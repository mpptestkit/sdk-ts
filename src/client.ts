import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Mppx, tempo } from "mppx/client";
import { MppFaucetError, MppPaymentError, MppTimeoutError } from "./errors";

const FAUCET_RPC = "https://rpc.testnet.tempo.xyz";

export interface PaymentStep {
  type: "wallet-created" | "funded" | "request" | "payment" | "success" | "error";
  message: string;
  data?: Record<string, unknown>;
}

export interface TestClientConfig {
  /** Use a specific wallet. If omitted, a new wallet is auto-generated. */
  privateKey?: `0x${string}`;
  /** Lifecycle event callback for observing the payment flow. */
  onStep?: (step: PaymentStep) => void;
  /** Request timeout in milliseconds. Default: 30000 (30s). */
  timeout?: number;
  /** Maximum retry attempts for transient failures. Default: 1 (single 402 retry). */
  maxRetries?: number;
}

export interface TestClient {
  /** The wallet address. */
  address: string;
  /** The payment method being used. */
  method: "tempo";
  /** Fetch a URL with automatic 402 payment handling. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

async function fundWallet(address: string): Promise<void> {
  const res = await fetch(FAUCET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tempo_fundAddress",
      params: [address],
    }),
  });

  if (!res.ok) {
    throw new MppFaucetError(address, new Error(`HTTP ${res.status}`));
  }

  const json = await res.json();
  if (json.error) {
    throw new MppFaucetError(address, new Error(json.error.message ?? "RPC error"));
  }
}

/**
 * Create an MPP test client.
 *
 * Auto-generates a wallet, funds it from the Tempo testnet faucet,
 * and handles 402 payments automatically.
 *
 * @example
 * ```ts
 * import { createTestClient } from "mpp-test-sdk";
 *
 * const client = await createTestClient();
 * const res = await client.fetch("http://localhost:3001/api/ping/paid");
 * const data = await res.json();
 * ```
 *
 * @throws {MppFaucetError} When the testnet faucet is unreachable or returns an error.
 */
export async function createTestClient(config?: TestClientConfig): Promise<TestClient> {
  const emit = config?.onStep ?? (() => {});
  const timeout = config?.timeout ?? 30_000;

  const key = config?.privateKey ?? generatePrivateKey();
  const account = privateKeyToAccount(key);
  emit({
    type: "wallet-created",
    message: `Wallet ${account.address}`,
    data: { address: account.address },
  });

  await fundWallet(account.address);
  emit({ type: "funded", message: "Wallet funded on testnet" });

  const mppxClient = Mppx.create({
    methods: [tempo({ account, testnet: true } as Parameters<typeof tempo>[0])],
  });

  return {
    address: account.address,
    method: "tempo",
    fetch: async (url: string, init?: RequestInit) => {
      emit({ type: "request", message: `→ ${url}` });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const signal = init?.signal
        ? anySignal([init.signal, controller.signal])
        : controller.signal;

      try {
        const response = await mppxClient.fetch(url, { ...init, signal });

        if (!response.ok && response.status !== 402) {
          emit({
            type: "error",
            message: `← ${response.status}`,
            data: { status: response.status },
          });
          throw new MppPaymentError(url, response.status);
        }

        emit({
          type: response.ok ? "success" : "payment",
          message: `← ${response.status}`,
          data: { status: response.status },
        });
        return response;
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new MppTimeoutError(url, timeout);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Combine multiple AbortSignals into one that aborts when any of them does. */
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

// --- Convenience: mppFetch ---

let _sharedClient: TestClient | null = null;

/**
 * One-shot fetch with automatic wallet creation, funding, and 402 payment.
 *
 * Uses a shared client instance across calls (lazy-initialized on first call).
 * Call `mppFetch.reset()` to discard the shared instance.
 *
 * @example
 * ```ts
 * import { mppFetch } from "mpp-test-sdk";
 *
 * const res = await mppFetch("http://localhost:3001/api/ping/paid");
 * const data = await res.json();
 * ```
 *
 * @throws {MppFaucetError} When the testnet faucet is unreachable.
 * @throws {MppTimeoutError} When the request times out.
 */
export async function mppFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!_sharedClient) {
    _sharedClient = await createTestClient();
  }
  return _sharedClient.fetch(url, init);
}

/** Discard the shared client instance. Next call to `mppFetch` will create a new wallet. */
mppFetch.reset = () => {
  _sharedClient = null;
};

