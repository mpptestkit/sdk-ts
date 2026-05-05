# mpp-test-sdk

[![npm](https://img.shields.io/npm/v/mpp-test-sdk)](https://www.npmjs.com/package/mpp-test-sdk)
[![Node.js](https://img.shields.io/node/v/mpp-test-sdk)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-zinc.svg)](LICENSE)

Test pay-per-request APIs on Tempo testnet. Auto-creates wallets, funds from faucet, handles 402 payments — zero setup required.

**[mpptestkit.com](https://mpptestkit.com)** · [GitHub](https://github.com/mpptestkit/mpp-test-sdk) · [X](https://x.com/mpptestkit)

---

## Install

```bash
npm i mpp-test-sdk
```

Requires Node.js 22+.

---

## Client

```ts
import { mppFetch } from "mpp-test-sdk";

const res = await mppFetch("https://your-api.com/api/data");
const data = await res.json();
```

Or with a dedicated client instance:

```ts
import { createTestClient } from "mpp-test-sdk";

const client = await createTestClient({
  onStep: (step) => console.log(step.type, step.message),
});

const res = await client.fetch("https://your-api.com/api/data");
```

The SDK handles the full flow: wallet generation, testnet faucet funding, 402 detection, on-chain payment, and automatic retry with payment proof.

---

## Server

```ts
import express from "express";
import { createTestServer } from "mpp-test-sdk";

const app = express();
const mpp = createTestServer({ secretKey: process.env.MPP_SECRET_KEY });

// Free — no middleware
app.get("/api/ping", (req, res) => res.json({ ok: true }));

// Paid — one line
app.get("/api/data", mpp.charge({ amount: "0.01" }), (req, res) => {
  res.json({ data: "premium content" });
});

app.listen(3001);
```

---

## API Reference

### `mppFetch(url, init?)`

Drop-in replacement for `fetch`. Uses a shared client lazily created on first call.

Call `mppFetch.reset()` to discard the shared client and generate a new wallet on the next request.

### `createTestClient(config?)`

Creates a client with its own isolated wallet.

| Option | Type | Default | Description |
|---|---|---|---|
| `privateKey` | `` `0x${string}` `` | auto-generated | Reuse a pre-funded wallet |
| `onStep` | `(step: PaymentStep) => void` | — | Lifecycle event callback |
| `timeout` | `number` | `30000` | Full flow timeout in ms |
| `maxRetries` | `number` | `1` | Max retry attempts |

Returns `Promise<TestClient>` with `{ address, method, fetch }`.

**Throws:** `MppFaucetError` if the testnet faucet is unreachable.

### `createTestServer(config)`

Creates Express middleware that enforces payment on any route.

| Option | Type | Default | Description |
|---|---|---|---|
| `secretKey` | `string` | **required** | MPP secret key for payment verification |
| `privateKey` | `` `0x${string}` `` | auto-generated | Server wallet private key |
| `currency` | `` `0x${string}` `` | PathUSD | ERC-20 token address to accept |

Returns `MppServer` with `.charge({ amount })` middleware.

**Throws:** `Error` synchronously if `secretKey` is missing.

### `PaymentStep` events

| `step.type` | When |
|---|---|
| `"wallet-created"` | New ephemeral wallet generated |
| `"funded"` | Faucet funding confirmed |
| `"request"` | Outgoing HTTP request |
| `"payment"` | On-chain payment submitted |
| `"success"` | Final 200 response received |
| `"error"` | Flow failed |

---

## Error Handling

```ts
import { MppFaucetError, MppPaymentError, MppTimeoutError } from "mpp-test-sdk";

try {
  const res = await client.fetch("https://api.example.com/data");
} catch (err) {
  if (err instanceof MppFaucetError) {
    // Testnet faucet unreachable — err.address
  } else if (err instanceof MppPaymentError) {
    // Payment rejected — err.status, err.url
  } else if (err instanceof MppTimeoutError) {
    // Flow timed out — err.url, err.timeoutMs
  }
}
```

**Tip:** Pass a pre-funded `privateKey` to `createTestClient` during development to skip faucet calls.

---

## Network

All payments use **PathUSD** test tokens on **Tempo Moderato Testnet** (chain ID 42431). Real on-chain transactions, zero financial risk.

| | Value |
|---|---|
| Chain ID | `42431` |
| RPC | `https://rpc.testnet.tempo.xyz` |
| Explorer | `https://explorer.testnet.tempo.xyz` |
| PathUSD | `0x20c0000000000000000000000000000000000000` |
| Faucet | Automatic via SDK |

---

## Troubleshooting

**`MppFaucetError`** — Faucet has rate limits. Wait a few seconds and retry, or pass a pre-funded `privateKey` to skip faucet calls.

**`MppTimeoutError`** — Increase `timeout` in `createTestClient`. On-chain confirmations typically take 2–5 seconds.

**402 not handled** — Ensure `createTestServer` is called with a valid `secretKey` and the middleware is placed before the route handler.

---

## License

MIT
