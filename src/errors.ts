export class MppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MppError";
  }
}

export class MppFaucetError extends MppError {
  public readonly address: string;

  constructor(address: string, cause?: unknown) {
    super(
      `Failed to airdrop SOL to wallet ${address}. ` +
        `The devnet/testnet faucet may be rate-limited. ` +
        `Wait 30s and retry, or pass a pre-funded secretKey to skip airdrop.`,
    );
    this.name = "MppFaucetError";
    this.address = address;
    this.cause = cause;
  }
}

export class MppPaymentError extends MppError {
  public readonly status: number;
  public readonly url: string;

  constructor(url: string, status: number, cause?: unknown) {
    super(`Payment failed for ${url} (status: ${status})`);
    this.name = "MppPaymentError";
    this.status = status;
    this.url = url;
    this.cause = cause;
  }
}

export class MppTimeoutError extends MppError {
  public readonly url: string;
  public readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms. ` +
      `Increase the timeout option or check your Solana RPC connection.`);
    this.name = "MppTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export class MppNetworkError extends MppError {
  public readonly network: string;

  constructor(network: string, message?: string) {
    super(
      message ??
        `Network configuration error for "${network}". ` +
          `Mainnet requires a pre-funded secretKey (no airdrop available).`,
    );
    this.name = "MppNetworkError";
    this.network = network;
  }
}
