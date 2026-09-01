import { spawn } from "node:child_process";
import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PocError } from "./errors.js";

export interface YoutubeDownloadOptions {
  maxBytes: number;
  timeoutMs: number;
  ytDlpPath?: string;
}

export interface YoutubeDownloadDependencies {
  runCommand: (command: string, args: string[], timeoutMs: number) => Promise<void>;
}

const youtubeHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
]);
const videoIdPattern = /^[a-zA-Z0-9_-]{6,20}$/u;

function parseHttpUrl(rawUrl: string): URL | undefined {
  try {
    const url = new URL(rawUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function isYoutubeVideoUrl(rawUrl: string): boolean {
  const url = parseHttpUrl(rawUrl);
  if (!url || !youtubeHosts.has(url.hostname.toLowerCase())) return false;
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (url.hostname.toLowerCase() === "youtu.be") return videoIdPattern.test(pathParts[0] ?? "");
  if (url.pathname === "/watch") return videoIdPattern.test(url.searchParams.get("v") ?? "");
  if (["shorts", "embed", "live"].includes(pathParts[0] ?? "")) {
    return videoIdPattern.test(pathParts[1] ?? "");
  }
  return false;
}

export function buildYtDlpArgs(rawUrl: string, outputTemplate: string, maxBytes: number): string[] {
  if (!isYoutubeVideoUrl(rawUrl)) {
    throw new PocError("YOUTUBE_URL_INVALID", "Use a valid YouTube video or Shorts link");
  }
  return [
    "--no-config",
    "--no-playlist",
    "--js-runtimes",
    "node",
    "--format",
    "bv[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[ext=mp4][vcodec^=avc1][acodec^=mp4a][height<=1080]",
    "--merge-output-format",
    "mp4",
    "--max-filesize",
    String(maxBytes),
    "--socket-timeout",
    "30",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--output",
    outputTemplate,
    rawUrl,
  ];
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 65_536) stderr += chunk.slice(0, 65_536 - stderr.length);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(new PocError("YOUTUBE_DOWNLOAD_TIMEOUT", "YouTube download exceeded the configured timeout"));
        return;
      }
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(stderr || `yt-dlp exited with status ${String(code)}`));
    });
  });
}

function classifyDownloadError(error: unknown): PocError {
  if (error instanceof PocError) return error;
  const nodeCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (nodeCode === "ENOENT") {
    return new PocError("YOUTUBE_DOWNLOADER_MISSING", "The YouTube downloader is not installed. Use the Docker runtime.");
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("requested format is not available")) {
    return new PocError("YOUTUBE_FORMAT_UNAVAILABLE", "This video has no supported H.264/AAC MP4 format at 1080p or below");
  }
  if (
    message.includes("video unavailable") ||
    message.includes("private video") ||
    message.includes("members-only") ||
    message.includes("sign in to confirm") ||
    message.includes("login required")
  ) {
    return new PocError("YOUTUBE_VIDEO_UNAVAILABLE", "The YouTube video is unavailable, private, restricted, or requires sign-in");
  }
  if (message.includes("max-filesize") || message.includes("larger than max")) {
    return new PocError("VIDEO_TOO_LARGE", "The YouTube video exceeds the configured size limit");
  }
  return new PocError("YOUTUBE_DOWNLOAD_FAILED", "Unable to download this YouTube video");
}

export async function downloadYoutubeVideo(
  rawUrl: string,
  outputPath: string,
  options: YoutubeDownloadOptions,
  dependencies: YoutubeDownloadDependencies = { runCommand },
): Promise<void> {
  if (!isYoutubeVideoUrl(rawUrl)) {
    throw new PocError("YOUTUBE_URL_INVALID", "Use a valid single YouTube video or Shorts link");
  }
  const temporaryDirectory = await mkdtemp(join(dirname(outputPath), ".youtube-download-"));
  try {
    const outputTemplate = join(temporaryDirectory, "source.%(ext)s");
    await dependencies.runCommand(
      options.ytDlpPath ?? "yt-dlp",
      buildYtDlpArgs(rawUrl, outputTemplate, options.maxBytes),
      options.timeoutMs,
    );
    const files = await readdir(temporaryDirectory);
    const mp4Files = files.filter((file) => file.toLowerCase().endsWith(".mp4"));
    if (mp4Files.length !== 1) {
      throw new PocError("YOUTUBE_OUTPUT_INVALID", "YouTube download did not produce one MP4 file");
    }
    const downloadedPath = join(temporaryDirectory, mp4Files[0]!);
    const downloaded = await stat(downloadedPath);
    if (downloaded.size > options.maxBytes) {
      throw new PocError("VIDEO_TOO_LARGE", "The YouTube video exceeds the configured size limit");
    }
    await rename(downloadedPath, outputPath);
  } catch (error) {
    throw classifyDownloadError(error);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
