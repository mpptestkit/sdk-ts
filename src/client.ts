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

// ─── Network ──────────────────────────────────────────────────

/** Solana network to connect to. */
export type SolanaNetwork = "devnet" | "testnet" | "mainnet";

const NETWORK_RPC: Record<SolanaNetwork, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

/** Networks that support free SOL airdrops. */
const AIRDROP_NETWORKS: SolanaNetwork[] = ["devnet", "testnet"];

// ─── Types ────────────────────────────────────────────────────

export interface PaymentStep {
  type: "wallet-created" | "funded" | "request" | "payment" | "retry" | "success" | "error";
  message: string;
  data?: Record<string, unknown>;
}

export interface TestClientConfig {
  /**
   * Solana network to connect to.
   * - `"devnet"` (default) - Free SOL airdrop, fast confirmation.
   * - `"testnet"` - Solana's testnet. Also has free airdrop.
   * - `"mainnet"` - Real SOL. Requires a pre-funded `secretKey`.
   */
  network?: SolanaNetwork;
  /**
   * Pre-funded Solana keypair secret key (32 or 64 bytes).
   * - On `devnet`/`testnet`: optional - wallet is auto-funded via airdrop.
   * - On `mainnet`: **required** - no airdrop available.
   */
  secretKey?: Uint8Array;
  /** Lifecycle event callback for observing the payment flow. */
  onStep?: (step: PaymentStep) => void;
  /** Full flow timeout in ms (wallet + payment + retry). Default: 30000. */
  timeout?: number;
  /** Override the Solana RPC endpoint. Takes precedence over `network`. */
  rpcUrl?: string;
}

export interface TestClient {
  /** Solana wallet address (base58 public key). */
  address: string;
  /** Network this client is connected to. */
  network: SolanaNetwork;
  /** Payment method. */
  method: "solana";
  /** Fetch a URL with automatic 402 MPP payment handling. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

// ─── Helpers ──────────────────────────────────────────────────

/** Airdrop SOL with up to 3 retries on rate limiting. */
async function airdropWithRetry(
  connection: Connection,
  publicKey: PublicKey,
  retries = 3,
): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const sig = await connection.requestAirdrop(publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      return;
    } catch (err) {
      if (attempt === retries - 1) {
        throw new MppFaucetError(publicKey.toBase58(), err);
      }
      // Exponential backoff: 1s, 2s, 4s
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
}

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

// ─── createTestClient ─────────────────────────────────────────

/**
 * Create a Solana MPP test client.
 *
 * Automatically creates a Solana wallet, funds it (via airdrop on devnet/testnet),
 * and handles HTTP 402 MPP payments with automatic retry.
 *
 * @example
 * ```ts
 * // devnet (default) - zero config
 * const client = await createTestClient();
 *
 * // testnet
 * const client = await createTestClient({ network: "testnet" });
 *
 * // mainnet - must provide pre-funded wallet
 * const client = await createTestClient({
 *   network: "mainnet",
 *   secretKey: loadKeypairFromFile("./wallet.json").secretKey,
 * });
 *
 * const res = await client.fetch("http://localhost:3001/api/data");
 * ```
 *
 * @throws {MppNetworkError} When `mainnet` is specified without a `secretKey`.
 * @throws {MppFaucetError} When the devnet/testnet airdrop fails after retries.
 */
export async function createTestClient(config?: TestClientConfig): Promise<TestClient> {
  const emit = config?.onStep ?? (() => {});
  const timeout = config?.timeout ?? 30_000;
  const network: SolanaNetwork = config?.network ?? "devnet";
  const rpcUrl = config?.rpcUrl ?? NETWORK_RPC[network];

  // Mainnet requires a pre-funded wallet
  if (network === "mainnet" && !config?.secretKey) {
    throw new MppNetworkError(
      "mainnet",
      "createTestClient: mainnet requires a pre-funded secretKey. " +
        "Airdrop is not available on mainnet. " +
        "Pass your keypair's secretKey in the config.",
    );
  }

  const keypair = config?.secretKey
    ? Keypair.fromSecretKey(config.secretKey)
    : Keypair.generate();

  const connection = new Connection(rpcUrl, "confirmed");
  const address = keypair.publicKey.toBase58();

  emit({
    type: "wallet-created",
    message: `Wallet ${address}`,
    data: { address, network },
  });

  // Fund via airdrop on devnet/testnet; skip on mainnet
  if (AIRDROP_NETWORKS.includes(network)) {
    await airdropWithRetry(connection, keypair.publicKey);
    emit({
      type: "funded",
      message: `Wallet funded via ${network} airdrop (2 SOL)`,
      data: { network, amount: 2 },
    });
  } else {
    emit({
      type: "funded",
      message: "Using pre-funded mainnet wallet",
      data: { network },
    });
  }

  // ─── fetch ──────────────────────────────────────────────────

  const clientFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    emit({ type: "request", message: `→ ${url}`, data: { url } });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const signal = init?.signal
      ? anySignal([init.signal, controller.signal])
      : controller.signal;

    try {
      // Step 1: Initial request
      const res = await fetch(url, { ...init, signal });

      // Non-402 path
      if (res.status !== 402) {
        if (!res.ok) {
          emit({
            type: "error",
            message: `← ${res.status} ${res.statusText}`,
            data: { status: res.status },
          });
          throw new MppPaymentError(url, res.status);
        }
        emit({
          type: "success",
          message: `← ${res.status} OK`,
          data: { status: res.status },
        });
        return res;
      }

      // Step 2: Parse Payment-Request header
      const paymentRequestHeader = res.headers.get("payment-request");
      if (!paymentRequestHeader) {
        throw new MppPaymentError(url, 402, new Error("Server returned 402 without Payment-Request header"));
      }

      const params = parseHeaderParams(paymentRequestHeader);

      if (!params.recipient) {
        throw new MppPaymentError(url, 402, new Error("Payment-Request header missing recipient field"));
      }
      if (!params.amount) {
        throw new MppPaymentError(url, 402, new Error("Payment-Request header missing amount field"));
      }

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

      // Step 3: Build and submit SOL transfer
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer: keypair.publicKey,
      }).add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: recipient,
          lamports,
        }),
      );

      const signature = await sendAndConfirmTransaction(connection, tx, [keypair], {
        commitment: "confirmed",
      });

      emit({
        type: "payment",
        message: `Confirmed: ${signature.slice(0, 16)}...`,
        data: { signature, amount: amountSol },
      });

      // Step 4: Retry with Payment-Receipt header
      emit({
        type: "retry",
        message: `↑ Retrying with payment proof`,
        data: { signature },
      });

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
      if (err instanceof Error && err.name === "AbortError") {
        throw new MppTimeoutError(url, timeout);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    address,
    network,
    method: "solana",
    fetch: clientFetch,
  };
}

// ─── mppFetch ─────────────────────────────────────────────────

let _sharedClient: TestClient | null = null;

/**
 * Drop-in replacement for `fetch` with automatic Solana MPP payment.
 *
 * Uses a shared client instance lazily created on first call (devnet by default).
 * Call `mppFetch.reset()` to discard the shared instance and generate a new wallet.
 *
 * @example
 * ```ts
 * import { mppFetch } from "mpp-test-sdk";
 *
 * const res = await mppFetch("http://localhost:3001/api/data");
 * const data = await res.json();
 * ```
 *
 * @throws {MppFaucetError} When the devnet airdrop fails after retries.
 * @throws {MppTimeoutError} When the full flow exceeds the timeout.
 */
export async function mppFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!_sharedClient) {
    _sharedClient = await createTestClient();
  }
  return _sharedClient.fetch(url, init);
}

/** Discard the shared client. Next call to `mppFetch` will create a fresh wallet. */
mppFetch.reset = () => {
  _sharedClient = null;
};
