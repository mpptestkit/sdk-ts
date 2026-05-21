import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import type { RequestHandler } from "express";
import type { ChainType, ConfirmationLevel, SolanaNetwork, BaseNetwork } from "./client";

const SOLANA_RPC: Record<SolanaNetwork, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

const BASE_RPC: Record<BaseNetwork, string> = {
  sepolia: "https://sepolia.base.org",
  mainnet: "https://mainnet.base.org",
};

// ─── Types ────────────────────────────────────────────────────

export interface ChargeOptions {
  /** Amount to charge (SOL for Solana, ETH for Base). E.g. "0.001". */
  amount: string;
}

export interface MppServer {
  /**
   * Express middleware that requires on-chain payment before passing to the route handler.
   *
   * - No receipt → 402 with `Payment-Request` header.
   * - Valid receipt + on-chain confirmation → calls `next()`.
   * - Invalid or insufficient payment → 403.
   */
  charge: (opts: ChargeOptions) => RequestHandler;
  /** The address where payments are sent. */
  recipientAddress: string;
  /** Network this server is configured for. */
  network: SolanaNetwork | BaseNetwork;
  /** Chain this server accepts payments on. */
  chain: ChainType;
}

export interface TestServerConfig {
  /** Chain to accept payments on. Default: `"solana"`. */
  chain?: ChainType;

  // ── Solana options ──────────────────────────────────────────

  /** Solana network. Default: `"devnet"`. */
  network?: SolanaNetwork;
  /** Server wallet keypair secret key. Auto-generated if omitted. */
  secretKey?: Uint8Array;
  /** Override the Solana RPC endpoint. */
  rpcUrl?: string;
  /**
   * Minimum confirmation level for verifying Solana payment transactions.
   * Default: `"confirmed"`.
   */
  confirmationLevel?: ConfirmationLevel;

  // ── Base options ────────────────────────────────────────────

  /** Base network. Default: `"sepolia"`. */
  baseNetwork?: BaseNetwork;
  /**
   * Recipient address for Base payments (EVM 0x address).
   * Auto-generated if omitted (useful for testing; save address to track funds).
   */
  recipientAddress?: string;
}

// ─── Helpers ──────────────────────────────────────────────────

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

function randomEvmAddress(): string {
  const bytes = new Uint8Array(20);
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 20; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── createTestServer ─────────────────────────────────────────

/**
 * Create an MPP-enabled Express server for Solana or Base.
 *
 * @example
 * ```ts
 * // Solana (default)
 * const mpp = createTestServer();
 *
 * // Base Sepolia
 * const mpp = createTestServer({ chain: "base", baseNetwork: "sepolia" });
 *
 * app.get("/api/data", mpp.charge({ amount: "0.001" }), handler);
 * ```
 */
export function createTestServer(config: TestServerConfig = {}): MppServer {
  const chain: ChainType = config.chain ?? "solana";

  if (chain === "base") {
    return createBaseServer(config);
  }
  return createSolanaServer(config);
}

// ─── Solana server ────────────────────────────────────────────

function createSolanaServer(config: TestServerConfig): MppServer {
  const network: SolanaNetwork = config.network ?? "devnet";
  const rpcUrl = config.rpcUrl ?? SOLANA_RPC[network];
  const confirmationLevel: ConfirmationLevel = config.confirmationLevel ?? "confirmed";

  const serverKeypair = config.secretKey
    ? Keypair.fromSecretKey(config.secretKey)
    : Keypair.generate();

  const recipientAddress = config.recipientAddress ?? serverKeypair.publicKey.toBase58();
  const connection = new Connection(rpcUrl, confirmationLevel);

  const charge =
    ({ amount }: ChargeOptions): RequestHandler =>
    async (req, res, next) => {
      const receiptHeader = (req.headers["payment-receipt"] as string | undefined) ?? "";

      if (!receiptHeader) {
        res
          .status(402)
          .set(
            "Payment-Request",
            `solana; amount="${amount}"; recipient="${recipientAddress}"; network="${network}"`,
          )
          .json({
            error: "Payment Required",
            payment: { amount, currency: "SOL", recipient: recipientAddress, network, chain: "solana" },
          });
        return;
      }

      try {
        const params = parseHeaderParams(receiptHeader);
        const { signature } = params;

        if (!signature) {
          res.status(403).json({ error: "Payment-Receipt missing signature field" });
          return;
        }

        const paidAmount = parseFloat(params.amount ?? "0");
        const requiredAmount = parseFloat(amount);
        if (isNaN(paidAmount) || paidAmount < requiredAmount) {
          res.status(403).json({
            error: `Insufficient payment: claimed ${params.amount ?? "0"} SOL, required ${amount} SOL`,
          });
          return;
        }

        const txCommitment = confirmationLevel === "finalized" ? "finalized" : "confirmed";
        const tx = await connection.getParsedTransaction(signature, {
          commitment: txCommitment,
          maxSupportedTransactionVersion: 0,
        });

        if (!tx) { res.status(403).json({ error: "Transaction not found on chain" }); return; }
        if (tx.meta?.err) { res.status(403).json({ error: "Transaction failed on chain" }); return; }

        const accountKeys = tx.transaction.message.accountKeys;
        const preBalances = tx.meta?.preBalances ?? [];
        const postBalances = tx.meta?.postBalances ?? [];

        const recipientPubkey = new PublicKey(recipientAddress);
        const recipientIdx = accountKeys.findIndex(
          (k) => k.pubkey.toBase58() === recipientPubkey.toBase58(),
        );

        if (recipientIdx < 0) {
          res.status(403).json({ error: `Recipient ${recipientAddress.slice(0, 8)}... not found in transaction` });
          return;
        }

        const received = (postBalances[recipientIdx] - preBalances[recipientIdx]) / LAMPORTS_PER_SOL;
        if (received < requiredAmount) {
          res.status(403).json({
            error: `Payment too small: received ${received} SOL, required ${requiredAmount} SOL`,
          });
          return;
        }

        next();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        res.status(403).json({ error: `Payment verification failed: ${message}` });
      }
    };

  return { charge, recipientAddress, network, chain: "solana" };
}

// ─── Base server ──────────────────────────────────────────────

function createBaseServer(config: TestServerConfig): MppServer {
  const baseNetwork: BaseNetwork = config.baseNetwork ?? "sepolia";
  const rpcUrl = config.rpcUrl ?? BASE_RPC[baseNetwork];
  const recipientAddress = config.recipientAddress ?? randomEvmAddress();

  const charge =
    ({ amount }: ChargeOptions): RequestHandler =>
    async (req, res, next) => {
      const receiptHeader = (req.headers["payment-receipt"] as string | undefined) ?? "";

      if (!receiptHeader) {
        res
          .status(402)
          .set(
            "Payment-Request",
            `base; amount="${amount}"; recipient="${recipientAddress}"; network="${baseNetwork}"`,
          )
          .json({
            error: "Payment Required",
            payment: { amount, currency: "ETH", recipient: recipientAddress, network: baseNetwork, chain: "base" },
          });
        return;
      }

      try {
        const params = parseHeaderParams(receiptHeader);
        const txHash = params.txhash ?? params.signature;

        if (!txHash) {
          res.status(403).json({ error: "Payment-Receipt missing txHash field" });
          return;
        }

        const paidAmount = parseFloat(params.amount ?? "0");
        const requiredAmount = parseFloat(amount);
        if (isNaN(paidAmount) || paidAmount < requiredAmount) {
          res.status(403).json({
            error: `Insufficient payment: claimed ${params.amount ?? "0"} ETH, required ${amount} ETH`,
          });
          return;
        }

        // Load ethers dynamically — only needed for Base chain verification
        let ethersModule: typeof import("ethers");
        try {
          ethersModule = await import("ethers");
        } catch {
          res.status(500).json({ error: "ethers v6 is required for Base chain. npm install ethers" });
          return;
        }

        const { JsonRpcProvider, parseEther, formatEther } = ethersModule;
        const provider = new JsonRpcProvider(rpcUrl);

        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) {
          res.status(403).json({ error: "Transaction not confirmed on Base" });
          return;
        }

        const tx = await provider.getTransaction(txHash);
        if (!tx) {
          res.status(403).json({ error: "Transaction not found on Base" });
          return;
        }

        if (tx.to?.toLowerCase() !== recipientAddress.toLowerCase()) {
          res.status(403).json({ error: `Transaction recipient mismatch: expected ${recipientAddress}` });
          return;
        }

        if (tx.value < parseEther(amount)) {
          res.status(403).json({
            error: `Payment too small: received ${formatEther(tx.value)} ETH, required ${amount} ETH`,
          });
          return;
        }

        next();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        res.status(403).json({ error: `Payment verification failed: ${message}` });
      }
    };

  return { charge, recipientAddress, network: baseNetwork, chain: "base" };
}
