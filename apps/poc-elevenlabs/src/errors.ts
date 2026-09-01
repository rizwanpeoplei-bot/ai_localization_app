export function sanitizeMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    .replace(/xi-api-key\s*[:=]\s*[^\s,;]+/giu, "xi-api-key=[REDACTED]")
    .replace(/authorization\s*[:=]\s*[^\s,;]+/giu, "authorization=[REDACTED]")
    .replace(
      /([?&](?:x-goog-signature|x-amz-signature|token|signature)=)[^&\s]+/giu,
      "$1[REDACTED]",
    )
    .replace(/sk_[a-z0-9_-]{12,}/giu, "[REDACTED]")
    .slice(0, 1_000);
}

export class PocError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(sanitizeMessage(message), options);
    this.name = "PocError";
  }
}

export function readNumericProperty(value: unknown, property: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === "number" ? candidate : undefined;
}

export function classifyProviderError(error: unknown): PocError {
  if (error instanceof PocError) return error;
  const status =
    readNumericProperty(error, "statusCode") ??
    readNumericProperty(error, "status") ??
    readNumericProperty(error, "code");
  const retryable = status === 408 || status === 429 || (status !== undefined && status >= 500);
  return new PocError(
    status === 429 ? "PROVIDER_RATE_LIMIT" : retryable ? "PROVIDER_TEMPORARY" : "PROVIDER_FAILED",
    sanitizeMessage(error),
    retryable,
    error instanceof Error ? { cause: error } : undefined,
  );
}
