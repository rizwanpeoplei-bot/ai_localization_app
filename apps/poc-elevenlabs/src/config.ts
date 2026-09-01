import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { z } from "zod";
import type { ProviderKind } from "./domain.js";
import { PocError } from "./errors.js";

const EnvironmentSchema = z.object({
  ELEVENLABS_API_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  ELEVENLABS_BASE_URL: z.url().default("https://api.elevenlabs.io"),
  POC_POLL_INITIAL_MS: z.coerce.number().int().min(0).default(5_000),
  POC_POLL_MAX_MS: z.coerce.number().int().positive().default(30_000),
  POC_OPERATION_TIMEOUT_MS: z.coerce.number().int().positive().default(2_700_000),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  FFPROBE_PATH: z.string().min(1).default("ffprobe"),
  SUBTITLE_FONT_DIRECTORY: z.string().min(1).default("/usr/share/fonts/truetype/noto"),
});

export interface AppConfig {
  elevenLabsApiKey?: string;
  elevenLabsBaseUrl: string;
  pollInitialMs: number;
  pollMaxMs: number;
  operationTimeoutMs: number;
  ffmpegPath: string;
  ffprobePath: string;
  subtitleFontDirectory: string;
}

export function loadConfig(provider: ProviderKind): AppConfig {
  const environment = EnvironmentSchema.parse(process.env);
  if (provider === "elevenlabs" && !environment.ELEVENLABS_API_KEY) {
    throw new PocError(
      "ELEVENLABS_API_KEY_REQUIRED",
      "ELEVENLABS_API_KEY is required for live provider execution",
    );
  }
  return {
    ...(environment.ELEVENLABS_API_KEY
      ? { elevenLabsApiKey: environment.ELEVENLABS_API_KEY }
      : {}),
    elevenLabsBaseUrl: environment.ELEVENLABS_BASE_URL,
    pollInitialMs: provider === "mock" ? 0 : environment.POC_POLL_INITIAL_MS,
    pollMaxMs: provider === "mock" ? 1 : environment.POC_POLL_MAX_MS,
    operationTimeoutMs: environment.POC_OPERATION_TIMEOUT_MS,
    ffmpegPath: environment.FFMPEG_PATH,
    ffprobePath: environment.FFPROBE_PATH,
    subtitleFontDirectory: environment.SUBTITLE_FONT_DIRECTORY,
  };
}

export async function validateInputFile(input: string): Promise<string> {
  const resolved = resolve(input);
  if (parse(resolved).ext.toLowerCase() !== ".mp4") {
    throw new PocError("UNSUPPORTED_FORMAT", `POC input must be an MP4 file: ${input}`);
  }
  await access(resolved, constants.R_OK).catch(() => {
    throw new PocError("INPUT_NOT_READABLE", `Input file is not readable: ${resolved}`);
  });
  const handle = await open(resolved, "r");
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const signaturePosition = header.subarray(0, bytesRead).indexOf(Buffer.from("ftyp", "ascii"));
    if (bytesRead < 12 || signaturePosition < 4 || signaturePosition > 32) {
      throw new PocError(
        "INVALID_MP4_CONTENT",
        "The selected input is not a valid MP4 file. A video webpage or sharing link is not a direct MP4 download.",
      );
    }
  } finally {
    await handle.close();
  }
  return resolved;
}

export function validateOutputRoot(output: string): string {
  const resolved = resolve(output);
  const root = parse(resolved).root;
  if (resolved === root || resolved === resolve(process.env.HOME ?? root)) {
    throw new PocError("UNSAFE_OUTPUT_PATH", `Refusing unsafe output directory: ${resolved}`);
  }
  if (dirname(resolved) === resolved) {
    throw new PocError("UNSAFE_OUTPUT_PATH", `Refusing filesystem root: ${resolved}`);
  }
  return resolved;
}
