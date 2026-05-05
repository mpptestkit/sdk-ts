export class MppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MppError";
  }
}

export class MppFaucetError extends MppError {
  public readonly address: string;

  constructor(address: string, cause?: unknown) {
    super(`Failed to fund wallet ${address} from testnet faucet`);
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
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "MppTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}
