import { Mppx, tempo } from "mppx/express";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { RequestHandler } from "express";

const PATHUSD = "0x20c0000000000000000000000000000000000000" as const;

export interface ChargeOptions {
  /** Amount to charge in PathUSD (e.g. "0.01"). */
  amount: string;
}

export interface MppServer {
  /** Express middleware that charges the specified amount before passing through. */
  charge: (opts: ChargeOptions) => RequestHandler;
}

export interface TestServerConfig {
  /** Your MPP secret key. Required. */
  secretKey: string;
  /** Optional private key for the server wallet. Auto-generated if omitted. */
  privateKey?: `0x${string}`;
  /** Optional currency token address. Defaults to PathUSD on Tempo testnet. */
  currency?: `0x${string}`;
}

/**
 * Create an MPP-enabled Express middleware.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { createTestServer } from "mpp-test-sdk";
 *
 * const app = express();
 * const mpp = createTestServer({ secretKey: "sk_test_..." });
 * app.get("/api/paid", mpp.charge({ amount: "0.01" }), (req, res) => res.json({ ok: true }));
 * ```
 */
export function createTestServer(config: TestServerConfig): MppServer {
  if (!config.secretKey) {
    throw new Error("createTestServer: secretKey is required");
  }

  const serverKey = config.privateKey ?? generatePrivateKey();
  const serverAccount = privateKeyToAccount(serverKey);

  const mppx = Mppx.create({
    secretKey: config.secretKey,
    methods: [
      tempo({
        testnet: true,
        currency: (config.currency ?? PATHUSD) as `0x${string}`,
        recipient: serverAccount.address,
        account: serverAccount,
      }),
    ],
  });

  return mppx as unknown as MppServer;
}
