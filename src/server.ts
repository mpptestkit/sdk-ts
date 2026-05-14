import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import type { RequestHandler } from "express";
import type { ConfirmationLevel, SolanaNetwork } from "./client";

const NETWORK_RPC: Record<SolanaNetwork, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

// ─── Types ────────────────────────────────────────────────────

export interface ChargeOptions {
  /** Amount to charge in SOL (e.g. "0.001"). */
  amount: string;
}

export interface MppServer {
  /**
   * Express middleware that requires SOL payment before passing to the route handler.
   *
   * - No receipt → 402 with `Payment-Request` header.
   * - Valid receipt + on-chain confirmation → calls `next()`.
   * - Invalid or insufficient payment → 403.
   */
  charge: (opts: ChargeOptions) => RequestHandler;
  /** The Solana address where payments are sent. */
  recipientAddress: string;
  /** Network this server is configured for. */
  network: SolanaNetwork;
}

export interface TestServerConfig {
  /**
   * Solana network to connect to.
   * - `"devnet"` (default) - Solana devnet.
   * - `"testnet"` - Solana testnet.
   * - `"mainnet"` - Solana mainnet (real SOL).
   */
  network?: SolanaNetwork;
  /** Server wallet keypair secret key. Auto-generated if omitted. */
  secretKey?: Uint8Array;
  /**
   * Override the recipient Solana address (base58).
   * Defaults to the server keypair's public key.
   */
  recipientAddress?: string;
  /** Override the Solana RPC endpoint. Takes precedence over `network`. */
  rpcUrl?: string;
  /**
   * Minimum confirmation level required when verifying payment transactions.
   * - `"processed"` - Fastest, lowest finality guarantee.
   * - `"confirmed"` - Default. Supermajority confirmation.
   * - `"finalized"` - Highest finality. Slowest but irreversible.
   */
  confirmationLevel?: ConfirmationLevel;
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

// ─── createTestServer ─────────────────────────────────────────

/**
 * Create a Solana MPP-enabled Express server.
 *
 * Handles the HTTP 402 payment flow and verifies SOL transfers on-chain.
 * No config needed - auto-generates a server wallet.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { createTestServer } from "mpp-test-sdk";
 *
 * const app = express();
 * const mpp = createTestServer();  // or createTestServer({ network: "mainnet" })
 *
 * // Charge 0.001 SOL per request
 * app.get("/api/data", mpp.charge({ amount: "0.001" }), (req, res) => {
 *   res.json({ data: "premium content" });
 * });
 * ```
 */
export function createTestServer(config: TestServerConfig = {}): MppServer {
  const network: SolanaNetwork = config.network ?? "devnet";
  const rpcUrl = config.rpcUrl ?? NETWORK_RPC[network];
  const confirmationLevel: ConfirmationLevel = config.confirmationLevel ?? "confirmed";

  const serverKeypair = config.secretKey
    ? Keypair.fromSecretKey(config.secretKey)
    : Keypair.generate();

  const recipientAddress =
    config.recipientAddress ?? serverKeypair.publicKey.toBase58();

  const connection = new Connection(rpcUrl, confirmationLevel);

  const charge =
    ({ amount }: ChargeOptions): RequestHandler =>
    async (req, res, next) => {
      const receiptHeader =
        (req.headers["payment-receipt"] as string | undefined) ?? "";

      // No receipt - return 402 with payment terms
      if (!receiptHeader) {
        res
          .status(402)
          .set(
            "Payment-Request",
            `solana; amount="${amount}"; recipient="${recipientAddress}"; network="${network}"`,
          )
          .json({
            error: "Payment Required",
            payment: {
              amount,
              currency: "SOL",
              recipient: recipientAddress,
              network,
            },
          });
        return;
      }

      // Receipt present - verify on-chain
      try {
        const params = parseHeaderParams(receiptHeader);
        const { signature } = params;

        if (!signature) {
          res.status(403).json({ error: "Payment-Receipt missing signature field" });
          return;
        }

        // Validate claimed amount
        const paidAmount = parseFloat(params.amount ?? "0");
        const requiredAmount = parseFloat(amount);

        if (isNaN(paidAmount) || paidAmount < requiredAmount) {
          res.status(403).json({
            error: `Insufficient payment: claimed ${params.amount ?? "0"} SOL, required ${amount} SOL`,
          });
          return;
        }

        // Fetch and validate Solana transaction
        // getParsedTransaction only accepts Finality ("confirmed" | "finalized")
        const txCommitment = confirmationLevel === "finalized" ? "finalized" : "confirmed";
        const tx = await connection.getParsedTransaction(signature, {
          commitment: txCommitment,
          maxSupportedTransactionVersion: 0,
        });

        if (!tx) {
          res.status(403).json({ error: "Transaction not found on chain" });
          return;
        }

        if (tx.meta?.err) {
          res.status(403).json({ error: "Transaction failed on chain" });
          return;
        }

        // Verify the recipient received at least the required amount
        const accountKeys = tx.transaction.message.accountKeys;
        const preBalances = tx.meta?.preBalances ?? [];
        const postBalances = tx.meta?.postBalances ?? [];

        const recipientPubkey = new PublicKey(recipientAddress);
        const recipientIdx = accountKeys.findIndex(
          (k) => k.pubkey.toBase58() === recipientPubkey.toBase58(),
        );

        if (recipientIdx < 0) {
          res.status(403).json({
            error: `Recipient ${recipientAddress.slice(0, 8)}... not found in transaction`,
          });
          return;
        }

        const received =
          (postBalances[recipientIdx] - preBalances[recipientIdx]) / LAMPORTS_PER_SOL;

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

  return {
    charge,
    recipientAddress,
    network,
  };
}
