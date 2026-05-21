import {
  Keypair,
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { MppFaucetError, MppNetworkError, MppPaymentError, MppTimeoutError } from "./errors";

// ─── Chain types ──────────────────────────────────────────────

/** Blockchain to use for payments. */
export type ChainType = "solana" | "base";

// ─── Solana types ─────────────────────────────────────────────

/** Solana network to connect to. */
export type SolanaNetwork = "devnet" | "testnet" | "mainnet";

const SOLANA_RPC: Record<SolanaNetwork, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

const AIRDROP_NETWORKS: SolanaNetwork[] = ["devnet", "testnet"];

/**
 * Solana transaction confirmation level.
 * - `"processed"` - Fastest. Node has processed the transaction (may be rolled back on forks).
 * - `"confirmed"` - Default. Supermajority of the cluster has confirmed the transaction.
 * - `"finalized"` - Slowest. Transaction is permanently committed and cannot be rolled back.
 */
export type ConfirmationLevel = "processed" | "confirmed" | "finalized";

// ─── Base types ───────────────────────────────────────────────

/** Base (Ethereum L2) network to connect to. */
export type BaseNetwork = "sepolia" | "mainnet";

const BASE_RPC: Record<BaseNetwork, string> = {
  sepolia: "https://sepolia.base.org",
  mainnet: "https://mainnet.base.org",
};

// ─── Shared types ─────────────────────────────────────────────

export interface PaymentStep {
  type: "wallet-created" | "funded" | "request" | "payment" | "retry" | "success" | "error";
  message: string;
  data?: Record<string, unknown>;
}

export interface TestClientConfig {
  /**
   * Blockchain chain to use for payments.
   * - `"solana"` (default) - Solana devnet/testnet/mainnet.
   * - `"base"` - Base Ethereum L2 (Sepolia testnet or mainnet).
   */
  chain?: ChainType;

  // ── Solana options ──────────────────────────────────────────

  /**
   * Solana network to connect to.
   * - `"devnet"` (default) - Free SOL airdrop.
   * - `"testnet"` - Solana's testnet. Also has free airdrop.
   * - `"mainnet"` - Real SOL. Requires a pre-funded `secretKey`.
   */
  network?: SolanaNetwork;
  /**
   * Pre-funded Solana keypair secret key (32 or 64 bytes).
   * - On `devnet`/`testnet`: optional — wallet is auto-funded via airdrop.
   * - On `mainnet`: **required** — no airdrop available.
   */
  secretKey?: Uint8Array;
  /**
   * Solana transaction confirmation level.
   * - `"processed"` - Fastest, lowest finality guarantee.
   * - `"confirmed"` - Default. Supermajority confirmation.
   * - `"finalized"` - Highest finality. Slower but irreversible.
   */
  confirmationLevel?: ConfirmationLevel;

  // ── Base options ────────────────────────────────────────────

  /**
   * Base network to connect to.
   * - `"sepolia"` (default) - Base Sepolia testnet.
   * - `"mainnet"` - Base mainnet (real ETH).
   */
  baseNetwork?: BaseNetwork;
  /**
   * Hex-encoded private key for the Base wallet.
   * Required for `"mainnet"`. On `"sepolia"` a random wallet is generated,
   * but you must fund it from https://coinbase.com/faucets/base-ethereum-sepolia-faucet.
   */
  privateKey?: string;

  // ── Shared ──────────────────────────────────────────────────

  /** Lifecycle event callback for observing the payment flow. */
  onStep?: (step: PaymentStep) => void;
  /** Full flow timeout in ms (wallet + payment + retry). Default: 60000. */
  timeout?: number;
  /** Override the RPC endpoint. Takes precedence over `network`/`baseNetwork`. */
  rpcUrl?: string;
}

export interface TestClient {
  /** Wallet address (base58 for Solana, 0x hex for Base). */
  address: string;
  /** Network this client is connected to. */
  network: SolanaNetwork | BaseNetwork;
  /** Chain this client uses for payments. */
  chain: ChainType;
  /** Payment method identifier. */
  method: ChainType;
  /** Fetch a URL with automatic 402 MPP payment handling. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

// ─── Shared helpers ───────────────────────────────────────────

function parseHeaderParams(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  const parts = header.split(";").map((s) => s.trim());
  for (const part of parts.slice(1)) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      const key = part.slice(0, eqIdx).trim().toLowerCase();
      const val = part.slice(eqIdx + 1).trim().replace(/^"|"$/g, "");
      params[key] = val;
    }
  }
  return params;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

// ─── Solana helpers ───────────────────────────────────────────

async function airdropWithRetry(
  connection: Connection,
  publicKey: PublicKey,
  commitment: ConfirmationLevel,
  retries = 3,
): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
      const sig = await connection.requestAirdrop(publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, commitment);
      return;
    } catch (err) {
      if (attempt === retries - 1) {
        throw new MppFaucetError(publicKey.toBase58(), err);
      }
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
}

// ─── Solana client ────────────────────────────────────────────

async function createSolanaTestClient(config: TestClientConfig): Promise<TestClient> {
  const emit = config.onStep ?? (() => {});
  const timeout = config.timeout ?? 60_000;
  const network: SolanaNetwork = config.network ?? "devnet";
  const rpcUrl = config.rpcUrl ?? SOLANA_RPC[network];
  const confirmationLevel: ConfirmationLevel = config.confirmationLevel ?? "confirmed";

  if (network === "mainnet" && !config.secretKey) {
    throw new MppNetworkError(
      "mainnet",
      "createTestClient: Solana mainnet requires a pre-funded secretKey. " +
        "Pass your keypair's secretKey in the config.",
    );
  }

  const keypair = config.secretKey
    ? Keypair.fromSecretKey(config.secretKey)
    : Keypair.generate();

  const connection = new Connection(rpcUrl, confirmationLevel);
  const address = keypair.publicKey.toBase58();

  emit({ type: "wallet-created", message: `Wallet ${address}`, data: { address, network, chain: "solana" } });

  if (AIRDROP_NETWORKS.includes(network)) {
    await airdropWithRetry(connection, keypair.publicKey, confirmationLevel);
    emit({ type: "funded", message: `Wallet funded via ${network} airdrop (2 SOL)`, data: { network, amount: 2 } });
  } else {
    emit({ type: "funded", message: "Using pre-funded mainnet wallet", data: { network } });
  }

  const clientFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    emit({ type: "request", message: `→ ${url}`, data: { url } });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const signal = init?.signal ? anySignal([init.signal, controller.signal]) : controller.signal;

    try {
      const res = await fetch(url, { ...init, signal });

      if (res.status !== 402) {
        if (!res.ok) {
          emit({ type: "error", message: `← ${res.status} ${res.statusText}`, data: { status: res.status } });
          throw new MppPaymentError(url, res.status);
        }
        emit({ type: "success", message: `← ${res.status} OK`, data: { status: res.status } });
        return res;
      }

      const paymentRequestHeader = res.headers.get("payment-request");
      if (!paymentRequestHeader) {
        throw new MppPaymentError(url, 402, new Error("Server returned 402 without Payment-Request header"));
      }

      const params = parseHeaderParams(paymentRequestHeader);
      if (!params.recipient) throw new MppPaymentError(url, 402, new Error("Payment-Request header missing recipient field"));
      if (!params.amount) throw new MppPaymentError(url, 402, new Error("Payment-Request header missing amount field"));

      const recipient = new PublicKey(params.recipient);
      const amountSol = parseFloat(params.amount);
      if (isNaN(amountSol) || amountSol <= 0) {
        throw new MppPaymentError(url, 402, new Error(`Invalid payment amount: ${params.amount}`));
      }
      const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

      emit({
        type: "payment",
        message: `Paying ${amountSol} SOL → ${params.recipient.slice(0, 8)}...`,
        data: { amount: amountSol, recipient: params.recipient },
      });

      const { blockhash } = await connection.getLatestBlockhash(confirmationLevel);
      const tx = new Transaction();
      tx.recentBlockhash = blockhash;
      tx.feePayer = keypair.publicKey;
      tx.add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: recipient, lamports }));

      const signature = await sendAndConfirmTransaction(connection, tx, [keypair], {
        commitment: confirmationLevel,
      });

      emit({
        type: "payment",
        message: `Confirmed: ${signature.slice(0, 16)}...`,
        data: { signature, amount: amountSol },
      });

      emit({ type: "retry", message: `↑ Retrying with payment proof`, data: { signature } });

      const existingHeaders =
        init?.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : (init?.headers as Record<string, string> | undefined) ?? {};

      const retryRes = await fetch(url, {
        ...init,
        signal,
        headers: {
          ...existingHeaders,
          "payment-receipt": `solana; signature="${signature}"; network="${network}"; amount="${amountSol}"`,
        },
      });

      emit({
        type: retryRes.ok ? "success" : "error",
        message: `← ${retryRes.status} ${retryRes.ok ? "OK" : retryRes.statusText}`,
        data: { status: retryRes.status, signature },
      });

      return retryRes;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") throw new MppTimeoutError(url, timeout);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  return { address, network, chain: "solana", method: "solana", fetch: clientFetch };
}

// ─── Base client ──────────────────────────────────────────────

async function createBaseTestClient(config: TestClientConfig): Promise<TestClient> {
  let ethers: typeof import("ethers");
  try {
    ethers = await import("ethers");
  } catch {
    throw new Error(
      "ethers v6 is required for Base chain support. Install it: npm install ethers",
    );
  }

  const baseNetwork: BaseNetwork = config.baseNetwork ?? "sepolia";
  const rpcUrl = config.rpcUrl ?? BASE_RPC[baseNetwork];
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const emit = config.onStep ?? (() => {});
  const timeout = config.timeout ?? 60_000;

  const wallet = config.privateKey
    ? new ethers.Wallet(config.privateKey, provider)
    : ethers.Wallet.createRandom(provider);

  const address = wallet.address;

  emit({ type: "wallet-created", message: `Wallet ${address}`, data: { address, network: baseNetwork, chain: "base" } });

  if (!config.privateKey) {
    emit({
      type: "funded",
      message: `Fund your wallet at https://coinbase.com/faucets/base-ethereum-sepolia-faucet`,
      data: { network: baseNetwork, faucet: "https://coinbase.com/faucets/base-ethereum-sepolia-faucet" },
    });
  }

  const clientFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    emit({ type: "request", message: `→ ${url}`, data: { url } });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const signal = init?.signal ? anySignal([init.signal, controller.signal]) : controller.signal;

    try {
      const res = await fetch(url, { ...init, signal });

      if (res.status !== 402) {
        if (!res.ok) {
          emit({ type: "error", message: `← ${res.status} ${res.statusText}`, data: { status: res.status } });
          throw new MppPaymentError(url, res.status);
        }
        emit({ type: "success", message: `← ${res.status} OK`, data: { status: res.status } });
        return res;
      }

      const paymentRequestHeader = res.headers.get("payment-request");
      if (!paymentRequestHeader) {
        throw new MppPaymentError(url, 402, new Error("Server returned 402 without Payment-Request header"));
      }

      const params = parseHeaderParams(paymentRequestHeader);
      if (!params.recipient) throw new MppPaymentError(url, 402, new Error("Payment-Request missing recipient"));
      if (!params.amount) throw new MppPaymentError(url, 402, new Error("Payment-Request missing amount"));

      const amountEth = parseFloat(params.amount);
      if (isNaN(amountEth) || amountEth <= 0) {
        throw new MppPaymentError(url, 402, new Error(`Invalid payment amount: ${params.amount}`));
      }

      emit({
        type: "payment",
        message: `Paying ${amountEth} ETH → ${params.recipient.slice(0, 10)}...`,
        data: { amount: amountEth, recipient: params.recipient, chain: "base" },
      });

      const tx = await wallet.sendTransaction({
        to: params.recipient,
        value: ethers.parseEther(params.amount),
      });

      const receipt = await tx.wait(1);
      const txHash = receipt?.hash ?? tx.hash;

      emit({
        type: "payment",
        message: `Confirmed: ${txHash.slice(0, 18)}...`,
        data: { txHash, amount: amountEth, chain: "base" },
      });

      emit({ type: "retry", message: `↑ Retrying with payment proof`, data: { txHash } });

      const existingHeaders =
        init?.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : (init?.headers as Record<string, string> | undefined) ?? {};

      const retryRes = await fetch(url, {
        ...init,
        signal,
        headers: {
          ...existingHeaders,
          "payment-receipt": `base; txHash="${txHash}"; network="${baseNetwork}"; amount="${amountEth}"`,
        },
      });

      emit({
        type: retryRes.ok ? "success" : "error",
        message: `← ${retryRes.status} ${retryRes.ok ? "OK" : retryRes.statusText}`,
        data: { status: retryRes.status, txHash, chain: "base" },
      });

      return retryRes;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") throw new MppTimeoutError(url, timeout);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  return { address, network: baseNetwork, chain: "base", method: "base", fetch: clientFetch };
}

// ─── createTestClient ─────────────────────────────────────────

/**
 * Create an MPP test client for Solana or Base.
 *
 * Automatically creates a wallet and handles the full HTTP 402 payment flow.
 *
 * @example
 * ```ts
 * // Solana devnet (default) — zero config
 * const client = await createTestClient();
 *
 * // Base Sepolia
 * const client = await createTestClient({
 *   chain: "base",
 *   baseNetwork: "sepolia",
 *   privateKey: ethers.Wallet.createRandom().privateKey,
 * });
 *
 * const res = await client.fetch("http://localhost:3001/api/data");
 * ```
 */
export async function createTestClient(config?: TestClientConfig): Promise<TestClient> {
  const chain = config?.chain ?? "solana";
  if (chain === "base") {
    return createBaseTestClient(config ?? {});
  }
  return createSolanaTestClient(config ?? {});
}

// ─── mppFetch ─────────────────────────────────────────────────

let _sharedClient: TestClient | null = null;

/**
 * Drop-in replacement for `fetch` with automatic Solana MPP payment (devnet by default).
 *
 * Uses a shared client instance lazily created on first call.
 * Call `mppFetch.reset()` to discard the shared instance and generate a new wallet.
 *
 * For Base chain, use `createTestClient({ chain: "base" })` directly.
 *
 * @example
 * ```ts
 * import { mppFetch } from "mpp-test-sdk";
 *
 * const res = await mppFetch("http://localhost:3001/api/data");
 * const data = await res.json();
 * ```
 */
export async function mppFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!_sharedClient) {
    _sharedClient = await createTestClient();
  }
  return _sharedClient.fetch(url, init);
}

mppFetch.reset = () => {
  _sharedClient = null;
};
