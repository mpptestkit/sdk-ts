import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestClient, mppFetch } from "../client";
import { MppFaucetError, MppTimeoutError } from "../errors";

// Mock viem/accounts
vi.mock("viem/accounts", () => ({
  generatePrivateKey: () =>
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const,
  privateKeyToAccount: (_key: string) => ({
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    signMessage: vi.fn(),
    signTransaction: vi.fn(),
    signTypedData: vi.fn(),
  }),
}));

// Mock mppx/client
const mockFetch = vi.fn();
vi.mock("mppx/client", () => ({
  Mppx: {
    create: () => ({ fetch: mockFetch }),
  },
  tempo: vi.fn(() => ({})),
}));

// Mock global fetch (for faucet calls)
const mockGlobalFetch = vi.fn();
vi.stubGlobal("fetch", mockGlobalFetch);

beforeEach(() => {
  vi.clearAllMocks();
  mppFetch.reset();
});

describe("createTestClient", () => {
  it("creates a client with auto-generated wallet", async () => {
    mockGlobalFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: true }),
    });

    const client = await createTestClient();

    expect(client.address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(client.method).toBe("tempo");
    expect(typeof client.fetch).toBe("function");
  });

  it("emits lifecycle events", async () => {
    mockGlobalFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: true }),
    });

    const steps: string[] = [];
    await createTestClient({
      onStep: (step) => steps.push(step.type),
    });

    expect(steps).toContain("wallet-created");
    expect(steps).toContain("funded");
  });

  it("throws MppFaucetError when faucet HTTP fails", async () => {
    mockGlobalFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    await expect(createTestClient()).rejects.toThrow(MppFaucetError);
  });

  it("throws MppFaucetError when faucet returns RPC error", async () => {
    mockGlobalFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "rate limited" },
      }),
    });

    await expect(createTestClient()).rejects.toThrow(MppFaucetError);
  });

  it("uses provided private key", async () => {
    const key = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as const;

    mockGlobalFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: true }),
    });

    const client = await createTestClient({ privateKey: key });
    expect(client.address).toBeDefined();
  });
});

describe("client.fetch", () => {
  it("returns response on success", async () => {
    mockGlobalFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: true }),
    });

    const client = await createTestClient();

    const mockResponse = new Response(JSON.stringify({ data: "test" }), { status: 200 });
    Object.defineProperty(mockResponse, "ok", { value: true });
    mockFetch.mockResolvedValueOnce(mockResponse);

    const res = await client.fetch("http://localhost:3001/api/test");
    expect(res.status).toBe(200);
  });

  it("throws MppTimeoutError on timeout", async () => {
    mockGlobalFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: true }),
    });

    const client = await createTestClient({ timeout: 1 });

    mockFetch.mockImplementationOnce((_url: string, opts: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (opts?.signal?.aborted) {
          onAbort();
        } else {
          opts?.signal?.addEventListener("abort", onAbort);
        }
      });
    });

    await expect(client.fetch("http://localhost:3001/slow")).rejects.toThrow(MppTimeoutError);
  });
});

describe("mppFetch", () => {
  it("lazily creates and caches a shared client", async () => {
    mockGlobalFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: true }),
    });

    const mockResponse = new Response("{}", { status: 200 });
    Object.defineProperty(mockResponse, "ok", { value: true });
    mockFetch.mockResolvedValue(mockResponse);

    await mppFetch("http://localhost:3001/api/a");
    await mppFetch("http://localhost:3001/api/b");

    // Faucet should only be called once (shared client)
    expect(mockGlobalFetch).toHaveBeenCalledTimes(1);
  });

  it("reset() discards the shared client", async () => {
    mockGlobalFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: true }),
    });

    const mockResponse = new Response("{}", { status: 200 });
    Object.defineProperty(mockResponse, "ok", { value: true });
    mockFetch.mockResolvedValue(mockResponse);

    await mppFetch("http://localhost:3001/api/a");
    mppFetch.reset();
    await mppFetch("http://localhost:3001/api/b");

    // Faucet called twice (new client after reset)
    expect(mockGlobalFetch).toHaveBeenCalledTimes(2);
  });
});
