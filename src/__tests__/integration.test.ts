/**
 * Integration tests - real HTTP server (Node.js built-in) + mocked Solana.
 *
 * Creates a real TCP server on a random port. Only the Solana blockchain layer
 * is mocked. The full HTTP 402 → pay → retry flow runs over a real connection.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createTestServer } from "../server";
import { createTestClient } from "../client";
import type { MppServer } from "../server";

// ─── Solana mock ──────────────────────────────────────────────

const {
  mockGetParsedTransaction,
  mockRequestAirdrop,
  mockConfirmTransaction,
  mockGetLatestBlockhash,
  mockSendAndConfirmTransaction,
} = vi.hoisted(() => ({
  mockGetParsedTransaction: vi.fn(),
  mockRequestAirdrop: vi.fn().mockResolvedValue("airdrop_sig"),
  mockConfirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
  mockGetLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "blockhash123" }),
  mockSendAndConfirmTransaction: vi.fn().mockResolvedValue("payment_sig_integration"),
}));

vi.mock("@solana/web3.js", () => {
  class FakePublicKey {
    private _key: string;
    constructor(key: string | Uint8Array) {
      this._key =
        typeof key === "string" ? key : "ServerIntegration1111111111111111111111";
    }
    toBase58() {
      return this._key;
    }
  }

  class FakeKeypair {
    publicKey = new FakePublicKey("ServerIntegration1111111111111111111111");
    secretKey = new Uint8Array(64);
    static generate() {
      return new FakeKeypair();
    }
    static fromSecretKey(_key: Uint8Array) {
      return new FakeKeypair();
    }
  }

  class FakeConnection {
    requestAirdrop = mockRequestAirdrop;
    confirmTransaction = mockConfirmTransaction;
    getLatestBlockhash = mockGetLatestBlockhash;
    getParsedTransaction = mockGetParsedTransaction;
  }

  class FakeTransaction {
    add(_ix: unknown) {
      return this;
    }
  }

  return {
    Keypair: FakeKeypair,
    Connection: FakeConnection,
    PublicKey: FakePublicKey,
    LAMPORTS_PER_SOL: 1_000_000_000,
    SystemProgram: {
      transfer: vi.fn().mockReturnValue({ programId: "11111111111111111111111111111111" }),
    },
    Transaction: FakeTransaction,
    sendAndConfirmTransaction: mockSendAndConfirmTransaction,
  };
});

// ─── Minimal express-compatible shim ─────────────────────────
//
// Adapts Node's raw IncomingMessage / ServerResponse into the req/res shape
// that createTestServer().charge() middleware expects.

function shimRes(raw: ServerResponse) {
  let statusCode = 200;
  const obj: Record<string, unknown> = {};

  obj.status = function (code: number) {
    statusCode = code;
    return obj;
  };
  obj.set = function (key: string, val: string) {
    raw.setHeader(key, val);
    return obj;
  };
  obj.json = function (body: unknown) {
    raw.writeHead(statusCode, { "Content-Type": "application/json" });
    raw.end(JSON.stringify(body));
  };

  return obj;
}

function buildServer(mpp: MppServer): http.Server {
  return http.createServer(async (req: IncomingMessage, rawRes: ServerResponse) => {
    const res = shimRes(rawRes) as any;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
    }
    const shimReq = { headers } as any;

    if (req.url === "/free") {
      rawRes.writeHead(200, { "Content-Type": "application/json" });
      rawRes.end(JSON.stringify({ free: true }));
      return;
    }

    if (req.url === "/paid") {
      const middleware = mpp.charge({ amount: "0.001" });
      let nextCalled = false;
      const next = () => {
        nextCalled = true;
        rawRes.writeHead(200, { "Content-Type": "application/json" });
        rawRes.end(JSON.stringify({ paid: true }));
      };
      await middleware(shimReq, res, next as any);
      return;
    }

    if (req.url === "/premium") {
      const middleware = mpp.charge({ amount: "0.005" });
      const next = () => {
        rawRes.writeHead(200, { "Content-Type": "application/json" });
        rawRes.end(JSON.stringify({ premium: true }));
      };
      await middleware(shimReq, res, next as any);
      return;
    }

    rawRes.writeHead(404);
    rawRes.end();
  });
}

// ─── Server setup ─────────────────────────────────────────────

const SERVER_RECIPIENT = "ServerIntegration1111111111111111111111";

let httpServer: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const mpp = createTestServer({ recipientAddress: SERVER_RECIPIENT });
  httpServer = buildServer(mpp);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  httpServer.close();
});

function validPaymentTx(recipient: string, lamports = 1_000_000) {
  return {
    meta: {
      err: null,
      preBalances: [2_000_000_000, 0],
      postBalances: [2_000_000_000 - lamports - 5000, lamports],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: { toBase58: () => "ClientAddr111111111111111111111111111111" } },
          { pubkey: { toBase58: () => recipient } },
        ],
      },
    },
  };
}

// ─── Integration tests ────────────────────────────────────────

describe("integration - free endpoint", () => {
  it("returns 200 for a free endpoint with no payment", async () => {
    const res = await fetch(`${baseUrl}/free`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.free).toBe(true);
  });

  it("client fetches free endpoint without triggering payment", async () => {
    vi.clearAllMocks();
    const client = await createTestClient();
    const res = await client.fetch(`${baseUrl}/free`);
    expect(res.status).toBe(200);
    expect(mockSendAndConfirmTransaction).not.toHaveBeenCalled();
  });
});

describe("integration - 402 payment flow", () => {
  it("server returns 402 with Payment-Request header on first request", async () => {
    vi.clearAllMocks();
    const res = await fetch(`${baseUrl}/paid`);
    expect(res.status).toBe(402);
    const header = res.headers.get("payment-request");
    expect(header).toContain("solana");
    expect(header).toContain(`recipient="${SERVER_RECIPIENT}"`);
    expect(header).toContain('amount="0.001"');
  });

  it("client auto-pays and gets 200 on retry (full E2E flow)", async () => {
    vi.clearAllMocks();
    mockGetParsedTransaction.mockResolvedValueOnce(
      validPaymentTx(SERVER_RECIPIENT, 1_000_000),
    );

    const steps: string[] = [];
    const client = await createTestClient({ onStep: (s) => steps.push(s.type) });
    const res = await client.fetch(`${baseUrl}/paid`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paid).toBe(true);

    expect(mockSendAndConfirmTransaction).toHaveBeenCalledOnce();
    expect(steps).toContain("payment");
    expect(steps).toContain("retry");
    expect(steps).toContain("success");
  });

  it("server returns 403 when transaction is not found on chain", async () => {
    vi.clearAllMocks();
    mockGetParsedTransaction.mockResolvedValueOnce(null);

    const res = await fetch(`${baseUrl}/paid`, {
      headers: {
        "payment-receipt": 'solana; signature="fake_sig"; network="devnet"; amount="0.001"',
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  it("server returns 403 when recipient is not in the transaction (wrong address attack)", async () => {
    vi.clearAllMocks();
    mockGetParsedTransaction.mockResolvedValueOnce({
      meta: { err: null, preBalances: [1_000_000_000, 2_000_000], postBalances: [997_000_000, 4_000_000] },
      transaction: {
        message: {
          accountKeys: [
            { pubkey: { toBase58: () => "SomeSender1111111111111111111111111111111" } },
            { pubkey: { toBase58: () => "WrongRecipient111111111111111111111111111" } },
          ],
        },
      },
    });

    const res = await fetch(`${baseUrl}/paid`, {
      headers: {
        "payment-receipt": 'solana; signature="sig"; network="devnet"; amount="0.001"',
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("not found in transaction");
  });
});

describe("integration - premium endpoint", () => {
  it("premium endpoint requests 0.005 SOL in Payment-Request header", async () => {
    vi.clearAllMocks();
    const res = await fetch(`${baseUrl}/premium`);
    expect(res.status).toBe(402);
    const header = res.headers.get("payment-request");
    expect(header).toContain('amount="0.005"');
  });

  it("client pays the correct amount and accesses premium content", async () => {
    vi.clearAllMocks();
    mockGetParsedTransaction.mockResolvedValueOnce(
      validPaymentTx(SERVER_RECIPIENT, 5_000_000),
    );

    const client = await createTestClient();
    const res = await client.fetch(`${baseUrl}/premium`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.premium).toBe(true);
  });
});
