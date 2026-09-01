import { sanitizeMessage } from "./errors.js";

export interface Logger {
  info(event: string, details?: Record<string, unknown>): void;
  error(event: string, details?: Record<string, unknown>): void;
}

function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!details) return {};
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => {
      const lowered = key.toLowerCase();
      if (lowered.includes("key") || lowered.includes("authorization") || lowered.includes("signedurl")) {
        return [key, "[REDACTED]"];
      }
      return [key, typeof value === "string" ? sanitizeMessage(value) : value];
    }),
  );
}

export class JsonLogger implements Logger {
  public info(event: string, details?: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify({ level: "info", event, ...sanitizeDetails(details) })}\n`);
  }

  public error(event: string, details?: Record<string, unknown>): void {
    process.stderr.write(`${JSON.stringify({ level: "error", event, ...sanitizeDetails(details) })}\n`);
  }
}
