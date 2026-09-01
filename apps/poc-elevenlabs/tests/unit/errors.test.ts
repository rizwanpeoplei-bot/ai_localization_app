import { describe, expect, it } from "vitest";
import { classifyProviderError, sanitizeMessage } from "../../src/errors.js";

describe("error safety", () => {
  it("redacts secrets and signed URL values", () => {
    const message = sanitizeMessage(
      "xi-api-key=secret-value https://example.test/file?X-Goog-Signature=top-secret&part=1",
    );
    expect(message).not.toContain("secret-value");
    expect(message).not.toContain("top-secret");
    expect(message).toContain("[REDACTED]");
  });

  it("classifies rate limits and server errors as retryable", () => {
    const rateLimit = classifyProviderError(Object.assign(new Error("limited"), { statusCode: 429 }));
    const serverError = classifyProviderError(Object.assign(new Error("down"), { statusCode: 503 }));
    const validation = classifyProviderError(Object.assign(new Error("invalid"), { statusCode: 422 }));
    expect(rateLimit.code).toBe("PROVIDER_RATE_LIMIT");
    expect(rateLimit.retryable).toBe(true);
    expect(serverError.retryable).toBe(true);
    expect(validation.retryable).toBe(false);
  });
});
