import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { isIP } from "node:net";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PocError } from "./errors.js";

export interface DownloadOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
}

export interface DownloadDependencies {
  resolveAddress: (hostname: string) => Promise<{ address: string; family: 4 | 6 }>;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || (b === 168) || (b === 0 && c === 2))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPublicIpv4(normalized.slice(7));
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith("2001:db8:")
  );
}

export async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dnsLookup(hostname, { all: true, verbatim: true });
  const candidate = addresses.find(
    (entry): entry is { address: string; family: 4 | 6 } =>
      (entry.family === 4 || entry.family === 6) && isPublicAddress(entry.address),
  );
  if (!candidate || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new PocError("VIDEO_URL_PRIVATE_ADDRESS", "Video URL resolves to a blocked private or reserved address");
  }
  return candidate;
}

function parseVideoUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PocError("VIDEO_URL_INVALID", "Video URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PocError("VIDEO_URL_SCHEME_INVALID", "Only public HTTP and HTTPS video URLs are allowed");
  }
  if (url.username || url.password) {
    throw new PocError("VIDEO_URL_CREDENTIALS_FORBIDDEN", "Video URL must not contain credentials");
  }
  if (!url.hostname) throw new PocError("VIDEO_URL_INVALID", "Video URL has no hostname");
  return url;
}

async function downloadOnce(
  url: URL,
  outputPath: string,
  options: Required<DownloadOptions>,
  redirectCount: number,
  dependencies: DownloadDependencies,
): Promise<void> {
  const resolved = await dependencies.resolveAddress(url.hostname);
  const requester = url.protocol === "https:" ? httpsGet : httpGet;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const request = requester(
      url,
      {
        headers: {
          Accept: "video/mp4,application/octet-stream;q=0.8",
          "User-Agent": "AILocalization-POC/0.1",
        },
        family: resolved.family,
        lookup: (_hostname, _options, callback) => {
          callback(null, resolved.address, resolved.family);
        },
        signal: AbortSignal.timeout(options.timeoutMs),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirectCount >= options.maxRedirects) {
            rejectPromise(new PocError("VIDEO_URL_REDIRECT_LIMIT", "Video URL exceeded the redirect limit"));
            return;
          }
          const redirected = parseVideoUrl(new URL(location, url).href);
          void downloadOnce(redirected, outputPath, options, redirectCount + 1, dependencies).then(
            resolvePromise,
            rejectPromise,
          );
          return;
        }
        if (status !== 200) {
          response.resume();
          rejectPromise(new PocError("VIDEO_DOWNLOAD_FAILED", `Video server returned HTTP ${String(status)}`));
          return;
        }
        const contentType = String(response.headers["content-type"] ?? "")
          .split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        if (
          contentType?.startsWith("text/") ||
          contentType === "application/json" ||
          contentType === "application/xml" ||
          contentType === "application/xhtml+xml"
        ) {
          response.resume();
          rejectPromise(
            new PocError(
              "VIDEO_URL_NOT_MEDIA",
              "The video URL returned a webpage or API response instead of an MP4 file",
            ),
          );
          return;
        }
        const declaredLength = Number(response.headers["content-length"] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
          response.resume();
          rejectPromise(new PocError("VIDEO_TOO_LARGE", "Remote video exceeds the configured size limit"));
          return;
        }
        let received = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (received > options.maxBytes) {
              callback(new PocError("VIDEO_TOO_LARGE", "Remote video exceeds the configured size limit"));
              return;
            }
            callback(null, chunk);
          },
        });
        void pipeline(response, limiter, createWriteStream(outputPath, { flags: "wx" })).then(
          resolvePromise,
          rejectPromise,
        );
      },
    );
    request.once("error", rejectPromise);
  });
}

export async function downloadPublicVideo(
  rawUrl: string,
  outputPath: string,
  options: DownloadOptions,
  dependencies: DownloadDependencies = { resolveAddress: resolvePublicAddress },
): Promise<void> {
  const temporaryPath = `${outputPath}.download`;
  await rm(temporaryPath, { force: true });
  try {
    await downloadOnce(
      parseVideoUrl(rawUrl),
      temporaryPath,
      { ...options, maxRedirects: options.maxRedirects ?? 3 },
      0,
      dependencies,
    );
    await rename(temporaryPath, outputPath);
  } catch (error) {
    if (error instanceof PocError) throw error;
    throw new PocError("VIDEO_DOWNLOAD_FAILED", "Unable to download the remote video", false, {
      cause: error,
    });
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
