export class MppError extends Error {
  override readonly name: string = "MppError";
  constructor(message: string) {
    super(message);
  }
}

export class MppFaucetError extends MppError {
  override readonly name = "MppFaucetError";
  readonly address: string;

  constructor(address: string, cause?: unknown) {
    super(
      `Failed to airdrop SOL to wallet ${address}. ` +
      `The devnet/testnet faucet may be rate-limited. ` +
      `Wait 30s and retry, or pass a pre-funded secretKey to skip airdrop.`,
    );
    this.address = address;
    this.cause = cause;
  }
}

export class MppPaymentError extends MppError {
  override readonly name = "MppPaymentError";
  readonly url: string;
  readonly status: number;

  constructor(url: string, status: number, cause?: unknown) {
    super(`Payment failed for ${url} (HTTP ${status})`);
    this.url = url;
    this.status = status;
    this.cause = cause;
  }
}

export class MppTimeoutError extends MppError {
  override readonly name = "MppTimeoutError";
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(
      `Request to ${url} timed out after ${timeoutMs}ms. ` +
      `Increase the timeout option or check your Solana RPC connection.`,
    );
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export class MppNetworkError extends MppError {
  override readonly name = "MppNetworkError";
  readonly network: string;

  constructor(network: string, message?: string) {
    super(
      message ??
      `Network error for "${network}". ` +
      `Mainnet requires a pre-funded secretKey - no airdrop available.`,
    );
    this.network = network;
  }
}
