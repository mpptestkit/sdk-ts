import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestClient, mppFetch } from "../client";
import { MppFaucetError, MppTimeoutError, MppNetworkError, MppPaymentError } from "../errors";

// ─── Solana mock ──────────────────────────────────────────────

// vi.hoisted ensures these are initialized before the vi.mock factory is hoisted
const {
  mockConfirmTransaction,
  mockRequestAirdrop,
  mockGetLatestBlockhash,
  mockSendAndConfirmTransaction,
} = vi.hoisted(() => ({
  mockConfirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
  mockRequestAirdrop: vi.fn().mockResolvedValue("airdrop_sig_123"),
  mockGetLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "AbCdEfGh1234" }),
  mockSendAndConfirmTransaction: vi.fn().mockResolvedValue("tx_sig_abc123456789"),
}));

vi.mock("@solana/web3.js", () => {
  class FakePublicKey {
    private _key: string;
    constructor(key: string | Uint8Array) {
      this._key =
        typeof key === "string" ? key : "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    }
    toBase58() {
      return this._key;
    }
  }

  class FakeKeypair {
    publicKey = new FakePublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
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
    getParsedTransaction = vi.fn();
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

// ─── Global fetch mock ────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.resetAllMocks();
  // Re-seed defaults after reset
  mockRequestAirdrop.mockResolvedValue("airdrop_sig_123");
  mockConfirmTransaction.mockResolvedValue({ value: { err: null } });
  mockGetLatestBlockhash.mockResolvedValue({ blockhash: "AbCdEfGh1234" });
  mockSendAndConfirmTransaction.mockResolvedValue("tx_sig_abc123456789");
  mppFetch.reset();
});

// ─── Wallet creation ──────────────────────────────────────────

describe("createTestClient - wallet creation", () => {
  it("creates a Solana client with auto-generated keypair on devnet by default", async () => {
    const client = await createTestClient();
    expect(client.address).toBe("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
    expect(client.method).toBe("solana");
    expect(client.network).toBe("devnet");
    expect(typeof client.fetch).toBe("function");
  });

  it("uses testnet when specified", async () => {
    const client = await createTestClient({ network: "testnet" });
    expect(client.network).toBe("testnet");
  });

  it("uses mainnet when secretKey is provided", async () => {
    const client = await createTestClient({ network: "mainnet", secretKey: new Uint8Array(64) });
    expect(client.network).toBe("mainnet");
  });

  it("throws MppNetworkError when mainnet is used without secretKey", async () => {
    await expect(createTestClient({ network: "mainnet" })).rejects.toThrow(MppNetworkError);
  });

  it("MppNetworkError message mentions mainnet and secretKey", async () => {
    await expect(createTestClient({ network: "mainnet" })).rejects.toThrow(/mainnet/);
    await expect(createTestClient({ network: "mainnet" })).rejects.toThrow(/secretKey/);
  });

  it("MppNetworkError has network property set to 'mainnet'", async () => {
    try {
      await createTestClient({ network: "mainnet" });
    } catch (err) {
      expect(err).toBeInstanceOf(MppNetworkError);
      expect((err as MppNetworkError).network).toBe("mainnet");
    }
  });

  it("accepts a custom secretKey and still airdrops on devnet", async () => {
    const client = await createTestClient({ secretKey: new Uint8Array(64) });
    expect(client.address).toBeDefined();
    expect(mockRequestAirdrop).toHaveBeenCalledTimes(1);
  });

  it("does NOT airdrop on mainnet", async () => {
    await createTestClient({ network: "mainnet", secretKey: new Uint8Array(64) });
    expect(mockRequestAirdrop).not.toHaveBeenCalled();
  });

  it("airdrops exactly 2 SOL on devnet", async () => {
    await createTestClient({ network: "devnet" });
    expect(mockRequestAirdrop).toHaveBeenCalledWith(expect.anything(), 2_000_000_000);
  });

  it("airdrops on testnet", async () => {
    await createTestClient({ network: "testnet" });
    expect(mockRequestAirdrop).toHaveBeenCalledTimes(1);
  });

  it("emits wallet-created then funded lifecycle events in order", async () => {
    const steps: string[] = [];
    await createTestClient({ onStep: (s) => steps.push(s.type) });
    expect(steps[0]).toBe("wallet-created");
    expect(steps[1]).toBe("funded");
  });

  it("wallet-created event carries address and network in data", async () => {
    const events: any[] = [];
    await createTestClient({ onStep: (s) => events.push(s) });
    const ev = events.find((e) => e.type === "wallet-created");
    expect(ev?.data?.address).toBe("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
    expect(ev?.data?.network).toBe("devnet");
  });
});

// ─── Airdrop retry ────────────────────────────────────────────

describe("createTestClient - airdrop retry", () => {
  it("retries airdrop up to 3 times and succeeds on third attempt", async () => {
    mockRequestAirdrop
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce("airdrop_sig_success");

    await expect(createTestClient()).resolves.toBeDefined();
    expect(mockRequestAirdrop).toHaveBeenCalledTimes(3);
  });

  it("throws MppFaucetError after 3 consecutive airdrop failures", async () => {
    mockRequestAirdrop
      .mockRejectedValueOnce(new Error("rate limit"))
      .mockRejectedValueOnce(new Error("rate limit"))
      .mockRejectedValueOnce(new Error("rate limit"));
    await expect(createTestClient()).rejects.toThrow(MppFaucetError);
    expect(mockRequestAirdrop).toHaveBeenCalledTimes(3);
  });

  it("MppFaucetError carries the wallet address", async () => {
    mockRequestAirdrop
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockRejectedValueOnce(new Error("rate limited"));
    try {
      await createTestClient();
    } catch (err) {
      expect(err).toBeInstanceOf(MppFaucetError);
      expect((err as MppFaucetError).address).toBe("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
    }
  });

  it("MppFaucetError message is actionable (mentions retry and wait)", async () => {
    mockRequestAirdrop
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockRejectedValueOnce(new Error("rate limited"));
    try {
      await createTestClient();
    } catch (err) {
      expect((err as MppFaucetError).message).toContain("rate-limited");
    }
  });
});

// ─── fetch - basic paths ──────────────────────────────────────

describe("client.fetch - non-payment paths", () => {
  it("returns 200 response directly without attempting payment", async () => {
    const client = await createTestClient();
    mockFetch.mockResolvedValueOnce(new Response('{"data":"free"}', { status: 200 }));

    const res = await client.fetch("http://localhost:3001/api/free");
    expect(res.status).toBe(200);
    expect(mockSendAndConfirmTransaction).not.toHaveBeenCalled();
  });

  it("throws MppPaymentError on non-402 error status codes", async () => {
    const client = await createTestClient();
    mockFetch.mockResolvedValueOnce(new Response('{"error":"Forbidden"}', { status: 403 }));
    await expect(client.fetch("http://localhost:3001/api/private")).rejects.toThrow(MppPaymentError);
  });

  it("MppPaymentError has the correct url and status", async () => {
    const client = await createTestClient();
    mockFetch.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    try {
      await client.fetch("http://localhost:3001/error");
    } catch (err) {
      expect(err).toBeInstanceOf(MppPaymentError);
      expect((err as MppPaymentError).url).toBe("http://localhost:3001/error");
      expect((err as MppPaymentError).status).toBe(500);
    }
  });
});

// ─── fetch - 402 payment flow ─────────────────────────────────

describe("client.fetch - 402 payment flow", () => {
  const PAYMENT_REQUEST_HEADER =
    'solana; amount="0.001"; recipient="9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; network="devnet"';

  it("handles 402 → pay → retry and returns 200", async () => {
    const client = await createTestClient();
    mockFetch
      .mockResolvedValueOnce(
        new Response("{}", { status: 402, headers: { "payment-request": PAYMENT_REQUEST_HEADER } }),
      )
      .mockResolvedValueOnce(new Response('{"data":"paid"}', { status: 200 }));

    const res = await client.fetch("http://localhost:3001/api/paid");
    expect(res.status).toBe(200);
    expect(mockSendAndConfirmTransaction).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("sends Payment-Receipt header with signature on retry", async () => {
    const client = await createTestClient();
    mockFetch
      .mockResolvedValueOnce(
        new Response("{}", { status: 402, headers: { "payment-request": PAYMENT_REQUEST_HEADER } }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await client.fetch("http://localhost:3001/api/paid");

    const retryHeaders = mockFetch.mock.calls[1][1]?.headers ?? {};
    expect(retryHeaders["payment-receipt"]).toContain("solana");
    expect(retryHeaders["payment-receipt"]).toContain("tx_sig_abc123456789");
    expect(retryHeaders["payment-receipt"]).toContain('signature="tx_sig_abc123456789"');
  });

  it("throws MppPaymentError when 402 has no Payment-Request header", async () => {
    const client = await createTestClient();
    mockFetch.mockResolvedValueOnce(new Response("{}", { status: 402 }));
    await expect(client.fetch("http://localhost:3001/api/paid")).rejects.toThrow(MppPaymentError);
  });

  it("emits payment, retry, and success events during 402 flow", async () => {
    const steps: any[] = [];
    const client = await createTestClient({ onStep: (s) => steps.push(s) });
    mockFetch
      .mockResolvedValueOnce(
        new Response("{}", { status: 402, headers: { "payment-request": PAYMENT_REQUEST_HEADER } }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await client.fetch("http://localhost:3001/api/paid");

    const types = steps.map((s) => s.type);
    expect(types).toContain("request");
    expect(types).toContain("payment");
    expect(types).toContain("retry");
    expect(types).toContain("success");
  });

  it("payment event data contains amount and recipient", async () => {
    const steps: any[] = [];
    const client = await createTestClient({ onStep: (s) => steps.push(s) });
    mockFetch
      .mockResolvedValueOnce(
        new Response("{}", { status: 402, headers: { "payment-request": PAYMENT_REQUEST_HEADER } }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await client.fetch("http://localhost:3001/api/paid");

    const paymentEv = steps.find((s) => s.type === "payment" && s.data?.amount);
    expect(paymentEv?.data?.amount).toBe(0.001);
    expect(paymentEv?.data?.recipient).toBe("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  });
});

// ─── fetch - timeout ──────────────────────────────────────────

describe("client.fetch - timeout", () => {
  function abortingFetch(_url: string, opts: { signal?: AbortSignal }) {
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (opts?.signal?.aborted) abort();
      else opts?.signal?.addEventListener("abort", abort);
    });
  }

  it("throws MppTimeoutError when request exceeds timeout", async () => {
    const client = await createTestClient({ timeout: 1 });
    mockFetch.mockImplementationOnce(abortingFetch);
    await expect(client.fetch("http://localhost:3001/slow")).rejects.toThrow(MppTimeoutError);
  });

  it("MppTimeoutError has correct url and timeoutMs", async () => {
    const client = await createTestClient({ timeout: 1 });
    mockFetch.mockImplementationOnce(abortingFetch);
    try {
      await client.fetch("http://localhost:3001/slow");
    } catch (err) {
      expect(err).toBeInstanceOf(MppTimeoutError);
      expect((err as MppTimeoutError).url).toBe("http://localhost:3001/slow");
      expect((err as MppTimeoutError).timeoutMs).toBe(1);
    }
  });
});

// ─── mppFetch ─────────────────────────────────────────────────

describe("mppFetch", () => {
  it("lazily creates and caches a shared client (airdrop called once)", async () => {
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await mppFetch("http://localhost:3001/a");
    await mppFetch("http://localhost:3001/b");
    expect(mockRequestAirdrop).toHaveBeenCalledTimes(1);
  });

  it("reset() discards the shared client so next call creates a new one", async () => {
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await mppFetch("http://localhost:3001/a");
    mppFetch.reset();
    await mppFetch("http://localhost:3001/b");
    expect(mockRequestAirdrop).toHaveBeenCalledTimes(2);
  });
});
