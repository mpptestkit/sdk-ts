import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestServer } from "../server";
import type { Request, Response, NextFunction } from "express";

// ─── Solana mock ──────────────────────────────────────────────

const mockGetParsedTransaction = vi.fn();

vi.mock("@solana/web3.js", () => {
  class FakePublicKey {
    private _key: string;
    constructor(key: string | Uint8Array) {
      this._key =
        typeof key === "string" ? key : "ServerPubkey1111111111111111111111111111";
    }
    toBase58() {
      return this._key;
    }
  }

  class FakeKeypair {
    publicKey = new FakePublicKey("ServerPubkey1111111111111111111111111111");
    secretKey = new Uint8Array(64);
    static generate() {
      return new FakeKeypair();
    }
    static fromSecretKey(_key: Uint8Array) {
      return new FakeKeypair();
    }
  }

  class FakeConnection {
    getParsedTransaction = mockGetParsedTransaction;
  }

  return {
    Keypair: FakeKeypair,
    Connection: FakeConnection,
    PublicKey: FakePublicKey,
    LAMPORTS_PER_SOL: 1_000_000_000,
  };
});

// ─── Test helpers ─────────────────────────────────────────────

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

function makeRes() {
  const res = {
    _status: 200,
    _body: null as unknown,
    _headers: {} as Record<string, string>,
    status: vi.fn().mockImplementation(function (this: typeof res, code: number) {
      this._status = code;
      return this;
    }),
    set: vi.fn().mockImplementation(function (this: typeof res, key: string, val: string) {
      this._headers[key] = val;
      return this;
    }),
    json: vi.fn().mockImplementation(function (this: typeof res, body: unknown) {
      this._body = body;
    }),
  };
  res.status = res.status.bind(res);
  res.set = res.set.bind(res);
  res.json = res.json.bind(res);
  return res;
}

const SERVER_RECIPIENT = "ServerPubkey1111111111111111111111111111";
const OTHER_ADDR = "SomeOtherRecipient11111111111111111111111";

function makeTx(recipient: string, receivedLamports = 2_000_000, failed = false) {
  return {
    meta: {
      err: failed ? { InstructionError: [0, "InsufficientFunds"] } : null,
      preBalances: [1_000_000_000, 0],
      postBalances: [997_000_000, receivedLamports],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: { toBase58: () => "ClientPubkey11111111111111111111111111111" } },
          { pubkey: { toBase58: () => recipient } },
        ],
      },
    },
  };
}

beforeEach(() => vi.clearAllMocks());

// ─── Server config ────────────────────────────────────────────

describe("createTestServer - config", () => {
  it("creates server with no config (auto-generates wallet)", () => {
    const mpp = createTestServer();
    expect(mpp.charge).toBeDefined();
    expect(typeof mpp.recipientAddress).toBe("string");
    expect(mpp.network).toBe("devnet");
  });

  it("exposes the correct recipientAddress when overridden", () => {
    const mpp = createTestServer({ recipientAddress: "CustomRecip111111111111111111111111111111" });
    expect(mpp.recipientAddress).toBe("CustomRecip111111111111111111111111111111");
  });

  it("exposes the correct network", () => {
    const mpp = createTestServer({ network: "testnet" });
    expect(mpp.network).toBe("testnet");
  });

  it("defaults recipientAddress to auto-generated keypair public key", () => {
    const mpp = createTestServer();
    expect(mpp.recipientAddress).toBe(SERVER_RECIPIENT);
  });

  it("charge() returns a middleware function", () => {
    const mpp = createTestServer();
    const handler = mpp.charge({ amount: "0.001" });
    expect(typeof handler).toBe("function");
    expect(handler.length).toBe(3); // (req, res, next)
  });
});

// ─── 402 path ─────────────────────────────────────────────────

describe("charge middleware - 402 (no receipt)", () => {
  it("returns 402 when no Payment-Receipt header present", async () => {
    const mpp = createTestServer({ recipientAddress: SERVER_RECIPIENT });
    const middleware = mpp.charge({ amount: "0.001" });
    const req = makeReq({});
    const res = makeRes();
    const next = vi.fn();

    await middleware(req as Request, res as unknown as Response, next as NextFunction);

    expect(res._status).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });

  it("sets Payment-Request header with solana scheme and all required fields", async () => {
    const mpp = createTestServer({ recipientAddress: SERVER_RECIPIENT });
    const middleware = mpp.charge({ amount: "0.005" });
    const req = makeReq({});
    const res = makeRes();

    await middleware(req as Request, res as unknown as Response, vi.fn() as NextFunction);

    const header = res._headers["Payment-Request"];
    expect(header).toContain("solana");
    expect(header).toContain('amount="0.005"');
    expect(header).toContain(`recipient="${SERVER_RECIPIENT}"`);
    expect(header).toContain('network="devnet"');
  });

  it("returns 402 JSON body with payment object", async () => {
    const mpp = createTestServer({ recipientAddress: SERVER_RECIPIENT });
    const middleware = mpp.charge({ amount: "0.001" });
    const req = makeReq({});
    const res = makeRes();

    await middleware(req as Request, res as unknown as Response, vi.fn() as NextFunction);

    expect((res._body as any)?.error).toBe("Payment Required");
    expect((res._body as any)?.payment?.amount).toBe("0.001");
    expect((res._body as any)?.payment?.currency).toBe("SOL");
    expect((res._body as any)?.payment?.recipient).toBe(SERVER_RECIPIENT);
  });
});

// ─── 403 paths ────────────────────────────────────────────────

describe("charge middleware - 403 paths", () => {
  it("returns 403 when signature is missing from receipt", async () => {
    const mpp = createTestServer({ recipientAddress: SERVER_RECIPIENT });
    const middleware = mpp.charge({ amount: "0.001" });
    const req = makeReq({ "payment-receipt": 'solana; network="devnet"; amount="0.001"' });
    const res = makeRes();
    const next = vi.fn();

    await middleware(req as Request, res as unknown as Response, next as NextFunction);

    expect(res._status).toBe(403);
    expect((res._body as any)?.error).toContain("signature");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when claimed amount is less than required", async () => {
    const mpp = createTestServer({ recipientAddress: SERVER_RECIPIENT });
    const middleware = mpp.charge({ amount: "0.01" });
    const req = makeReq({ "payment-receipt": 'solana; signature="sig"; network="devnet"; amount="0.001"' });
    const res = makeRes();
    const next = vi.fn();

    await middleware(req as Request, res as unknown as Response, next as NextFunction);

    expect(res._status).toBe(403);
    expect((res._body as any)?.error).toContain("Insufficient");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when transaction is not found on chain", async () => {
    mockGetParsedTransaction.mockResolvedValueOnce(null);
    const mpp = createTestServer({ recipientAddress: SERVER_RECIPIENT });
    const middleware = mpp.charge({ amount: "0.001" });
    const req = makeReq({ "payment-receipt": 'solana; signature="bad_sig"; network="devnet"; amount="0.001"' });
    const res = makeRes();
    const next = vi.fn();

    await middleware(req as Request, res as unknown as Response, next as NextFunction);

    expect(res._status).toBe(403);
    expect((res._body as any)?.error).toContain("not found");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when the on-chain transaction has an error (tx.meta.err)", async () => {
    mockGetParsedTransaction.mockResolvedValueOnce(makeTx(SERVER_RECIPIENT, 2_000_000, true));
    const mpp = createTestServer({ recipientAddress: SERVER_RECIPIENT });
    const middleware = mpp.charge({ amount: "0.001" });
    const req = makeReq({ "payment-receipt": 'solana; signature="sig"; network="devnet"; amount="0.001"' });
    const res = makeRes();
    const next = vi.fn();

    await middleware(req as Request, res as unknown as Response, next as NextFunction);

    expect(res._status).toBe(403);
    expect((res._body as any)?.error).toContain("failed on chain");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when recipient is NOT in the transaction accounts (critical verification)", async () => {
    // Transaction is valid and succeeded, but to a different address - not our server
    mockGetParsedTransaction.mockResolvedValueOnce({
      meta: { err: null, preBalances: [1_000_000_000, 2_000_000], postBalances: [997_000_000, 4_000_000] },
      transaction: {
        message: {
          accountKeys: [
            { pubkey: { toBase58: () => "SomeSender1111111111111111111111111111111" } },
            { pubkey: { toBase58: () => OTHER_ADDR } }, // different recipient
          ],
        },
      },
    });

    const mpp = createTestServer({ recipientAddress: SERVER_RECIPIENT });
    const middleware = mpp.charge({ amount: "0.001" });
    const req = makeReq({ "payment-receipt": 'solana; signature="sig"; network="devnet"; amount="0.001"' });
    const res = makeRes();
    const next = vi.fn();

    await middleware(req as Request, res as unknown as Response, next as NextFunction);

    // Must reject - not call next() - even though the transaction itself is valid
    expect(res._status).toBe(403);
    expect((res._body as any)?.error).toContain("not found in transaction");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when on-chain received amount is below required (underpayment)", async () => {
    // Received 0.0001 SOL (100_000 lamports), but 0.001 SOL required
    mockGetParsedTransaction.mockResolvedValueOnce(makeTx(SERVER_RECIPIENT, 100_000));
    const mpp = createTestServer({ recipientAddress: SERVER_RECIPIENT });
    const middleware = mpp.charge({ amount: "0.001" });
    const req = makeReq({ "payment-receipt": 'solana; signature="sig"; network="devnet"; amount="0.001"' });
    const res = makeRes();
    const next = vi.fn();

    await middleware(req as Request, res as unknown as Response, next as NextFunction);

    expect(res._status).toBe(403);
    expect((res._body as any)?.error).toContain("too small");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 with verification-failed message on unexpected RPC errors", async () => {
    mockGetParsedTransaction.mockRejectedValueOnce(new Error("RPC timeout"));
    const mpp = createTestServer({ recipientAddress: SERVER_RECIPIENT });
    const middleware = mpp.charge({ amount: "0.001" });
    const req = makeReq({ "payment-receipt": 'solana; signature="sig"; network="devnet"; amount="0.001"' });
    const res = makeRes();
    const next = vi.fn();

    await middleware(req as Request, res as unknown as Response, next as NextFunction);

    expect(res._status).toBe(403);
    expect((res._body as any)?.error).toContain("Payment verification failed");
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── 200 / next() path ────────────────────────────────────────

describe("charge middleware - next() (valid payment)", () => {
  it("calls next() when payment is exactly the required amount", async () => {
    mockGetParsedTransaction.mockResolvedValueOnce(makeTx(SERVER_RECIPIENT, 1_000_000)); // 0.001 SOL exactly
    const mpp = createTestServer({ recipientAddress: SERVER_RECIPIENT });
    const middleware = mpp.charge({ amount: "0.001" });
    const req = makeReq({ "payment-receipt": 'solana; signature="sig_exact"; network="devnet"; amount="0.001"' });
    const res = makeRes();
    const next = vi.fn();

    await middleware(req as Request, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBe(200); // untouched
  });

  it("calls next() when payment exceeds the required amount (overpayment)", async () => {
    mockGetParsedTransaction.mockResolvedValueOnce(makeTx(SERVER_RECIPIENT, 5_000_000)); // 0.005 SOL, requires 0.001
    const mpp = createTestServer({ recipientAddress: SERVER_RECIPIENT });
    const middleware = mpp.charge({ amount: "0.001" });
    const req = makeReq({ "payment-receipt": 'solana; signature="sig_over"; network="devnet"; amount="0.005"' });
    const res = makeRes();
    const next = vi.fn();

    await middleware(req as Request, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
  });

  it("verifies the transaction via the signature in the receipt header", async () => {
    mockGetParsedTransaction.mockResolvedValueOnce(makeTx(SERVER_RECIPIENT, 2_000_000));
    const mpp = createTestServer({ recipientAddress: SERVER_RECIPIENT });
    const middleware = mpp.charge({ amount: "0.001" });
    const req = makeReq({ "payment-receipt": 'solana; signature="the_real_sig"; network="devnet"; amount="0.001"' });
    const res = makeRes();

    await middleware(req as Request, res as unknown as Response, vi.fn() as NextFunction);

    expect(mockGetParsedTransaction).toHaveBeenCalledWith(
      "the_real_sig",
      expect.objectContaining({ commitment: "confirmed" }),
    );
  });
});
