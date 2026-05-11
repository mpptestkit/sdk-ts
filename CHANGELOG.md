# Changelog

## [1.1.2] - 2026-05-11

### Improved
- Error classes now use `override readonly name` class property declarations instead of constructor assignments — cleaner TypeScript and better `instanceof` behaviour across module boundaries
- `MppPaymentError` message format: `HTTP ${status}` instead of `status: ${status}` for consistency
- `MppNetworkError` default message simplified

## [1.1.1] - 2026-05-03

### Fixed
- Airdrop retry with exponential back-off (1s → 2s → 4s) on faucet rate limiting

### Improved
- `mppFetch.reset()` now correctly discards the shared client instance

## [1.1.0] - 2026-05-01

### Added
- `mppFetch` — drop-in `fetch` replacement with shared lazy client
- `mppFetch.reset()` — discard shared instance and force a new wallet on next call
- `MppNetworkError` — thrown when mainnet is used without a `secretKey`
- `rpcUrl` option in `TestClientConfig` to override the Solana RPC endpoint
- `timeout` option in `TestClientConfig` — full flow timeout (default 30s)

### Improved
- `onStep` lifecycle callbacks now fire on all payment stages including `error`

## [1.0.0] - 2026-05-01

### Added
- `createTestClient` — auto-generates Solana wallet, airdrops SOL, handles HTTP 402 flow
- `createTestServer` — Express middleware for charging per request via Solana
- `MppFaucetError`, `MppPaymentError`, `MppTimeoutError` error classes
- Devnet and testnet support with automatic airdrop
- Mainnet support with pre-funded `secretKey`
