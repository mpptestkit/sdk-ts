import { describe, it, expect, vi } from "vitest";
import { createTestServer } from "../server";

// Mock viem/accounts
vi.mock("viem/accounts", () => ({
  generatePrivateKey: () =>
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const,
  privateKeyToAccount: () => ({
    address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  }),
}));

// Mock mppx/express
const mockCharge = vi.fn(() => vi.fn());
vi.mock("mppx/express", () => ({
  Mppx: {
    create: () => ({ charge: mockCharge }),
  },
  tempo: vi.fn(() => ({})),
}));

describe("createTestServer", () => {
  it("creates server with required secretKey", () => {
    const mpp = createTestServer({ secretKey: "sk_test_abc" });
    expect(mpp).toBeDefined();
    expect(typeof mpp.charge).toBe("function");
  });

  it("throws when secretKey is missing", () => {
    expect(() => createTestServer({ secretKey: "" })).toThrow(
      "createTestServer: secretKey is required",
    );
  });

  it("charge returns a middleware function", () => {
    const mpp = createTestServer({ secretKey: "sk_test_abc" });
    const handler = mpp.charge({ amount: "0.01" });
    expect(handler).toBeDefined();
  });

  it("accepts custom private key and currency", () => {
    const mpp = createTestServer({
      secretKey: "sk_test_abc",
      privateKey: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      currency: "0x1111111111111111111111111111111111111111",
    });
    expect(mpp).toBeDefined();
  });
});
