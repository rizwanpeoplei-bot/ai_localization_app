import { spawn } from "node:child_process";
import { access, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { Language } from "./domain.js";
import { PocError, sanitizeMessage } from "./errors.js";
import type { LogoPosition, SubtitleMode } from "./web-input.js";

const ProbeSchema = z.object({
  streams: z.array(
    z
      .object({
        index: z.number(),
        codec_name: z.string().optional(),
        codec_type: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        duration: z.string().optional(),
      })
      .passthrough(),
  ),
  format: z
    .object({
      filename: z.string().optional(),
      format_name: z.string().optional(),
      duration: z.string().optional(),
      size: z.string().optional(),
      bit_rate: z.string().optional(),
    })
    .passthrough(),
});

export type MediaProbe = z.infer<typeof ProbeSchema>;

export interface MediaServiceOptions {
  ffmpegPath: string;
  ffprobePath: string;
  fontDirectory: string;
  timeoutMs: number;
}

export interface FinalRenderSettings {
  brightness: number;
  volumePercent: number;
  subtitleMode: SubtitleMode;
  targetLanguage: Language;
  logoPath?: string;
  logoPosition: LogoPosition;
  logoSizePercent: number;
}

export const SUBTITLE_FONT_NAMES: Record<Language, string> = {
  en: "Noto Sans",
  ur: "Noto Naskh Arabic",
  hi: "Noto Sans Devanagari",
};

async function runProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  const signal = AbortSignal.timeout(timeoutMs);
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      ...(cwd ? { cwd } : {}),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-2_000_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2_000_000);
    });
    child.once("error", (error) => {
      rejectPromise(
        new PocError(
          signal.aborted ? "MEDIA_TIMEOUT" : "MEDIA_PROCESS_START_FAILED",
          signal.aborted
            ? `${basename(executable)} exceeded ${timeoutMs}ms`
            : `Unable to start ${executable}: ${sanitizeMessage(error)}`,
          false,
          { cause: error },
        ),
      );
    });
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else {
        rejectPromise(
          new PocError(
            "MEDIA_PROCESS_FAILED",
            `${basename(executable)} exited with ${String(code)}: ${sanitizeMessage(stderr)}`,
          ),
        );
      }
    });
  });
}

export class MediaService {
  public constructor(private readonly options: MediaServiceOptions) {}

  public async preflight(): Promise<void> {
    await runProcess(this.options.ffmpegPath, ["-version"], 15_000);
    await runProcess(this.options.ffprobePath, ["-version"], 15_000);
    await access(this.options.fontDirectory).catch(() => {
      throw new PocError(
        "SUBTITLE_FONTS_MISSING",
        `Subtitle font directory does not exist: ${this.options.fontDirectory}`,
      );
    });
  }

  public async probe(path: string): Promise<MediaProbe> {
    const result = await runProcess(
      this.options.ffprobePath,
      ["-v", "error", "-show_format", "-show_streams", "-of", "json", path],
      60_000,
    );
    try {
      return ProbeSchema.parse(JSON.parse(result.stdout) as unknown);
    } catch (error) {
      throw new PocError("FFPROBE_INVALID_OUTPUT", `Could not parse FFprobe output: ${sanitizeMessage(error)}`);
    }
  }

  public validatePocSource(probe: MediaProbe): number {
    const formatName = probe.format.format_name ?? "";
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    const audio = probe.streams.find((stream) => stream.codec_type === "audio");
    const duration = Number(probe.format.duration ?? video?.duration ?? audio?.duration);
    if (!formatName.split(",").includes("mp4")) {
      throw new PocError("UNSUPPORTED_CONTAINER", `POC source container is not MP4: ${formatName}`);
    }
    if (video?.codec_name !== "h264") {
      throw new PocError("UNSUPPORTED_VIDEO_CODEC", `POC source video codec must be H.264: ${video?.codec_name ?? "none"}`);
    }
    if (audio?.codec_name !== "aac") {
      throw new PocError("UNSUPPORTED_AUDIO_CODEC", `POC source audio codec must be AAC: ${audio?.codec_name ?? "none"}`);
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new PocError("INVALID_VIDEO_DURATION", "POC source has no positive duration");
    }
    if ((video.width ?? 0) > 1_920 || (video.height ?? 0) > 1_080) {
      throw new PocError("UNSUPPORTED_RESOLUTION", "POC source resolution must not exceed 1920x1080");
    }
    return duration;
  }

  public async createMockLosslessAudio(inputPath: string, outputPath: string): Promise<void> {
    const temporary = `${outputPath}.tmp.flac`;
    await rm(temporary, { force: true });
    try {
      await runProcess(
        this.options.ffmpegPath,
        ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath, "-map", "0:a:0", "-c:a", "flac", temporary],
        this.options.timeoutMs,
      );
      await rename(temporary, outputPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  public async muxDubbedAudio(
    sourcePath: string,
    dubbedAudioPath: string,
    outputPath: string,
    sourceDurationSeconds: number,
  ): Promise<void> {
    const temporary = `${outputPath}.tmp.mp4`;
    await rm(temporary, { force: true });
    try {
      await runProcess(
        this.options.ffmpegPath,
        [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        sourcePath,
        "-i",
        dubbedAudioPath,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-t",
        sourceDurationSeconds.toFixed(3),
        "-movflags",
        "+faststart",
        temporary,
        ],
        this.options.timeoutMs,
      );
      await rename(temporary, outputPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  public async burnSubtitles(
    localizedVideoPath: string,
    subtitlesPath: string,
    outputPath: string,
    language: Language,
  ): Promise<void> {
    const workDirectory = dirname(outputPath);
    if (dirname(localizedVideoPath) !== workDirectory || dirname(subtitlesPath) !== workDirectory) {
      throw new PocError("MEDIA_PATH_MISMATCH", "Localized video, subtitles, and output must share a directory");
    }
    const temporaryName = `${basename(outputPath)}.tmp.mp4`;
    const temporaryPath = join(workDirectory, temporaryName);
    const subtitleFilter = [
      `subtitles=filename=${basename(subtitlesPath)}`,
      `fontsdir=${this.options.fontDirectory}`,
      `force_style='FontName=${SUBTITLE_FONT_NAMES[language]},FontSize=22,MarginV=28'`,
    ].join(":");
    await rm(temporaryPath, { force: true });
    try {
      await runProcess(
        this.options.ffmpegPath,
        [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        basename(localizedVideoPath),
        "-vf",
        subtitleFilter,
        "-c:v",
        "libx264",
        "-crf",
        "20",
        "-preset",
        "medium",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        temporaryName,
        ],
        this.options.timeoutMs,
        workDirectory,
      );
      await rename(temporaryPath, outputPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  public async renderFinalVideo(
    localizedVideoPath: string,
    subtitlesPath: string,
    outputPath: string,
    sourceDurationSeconds: number,
    settings: FinalRenderSettings,
  ): Promise<void> {
    const workDirectory = dirname(outputPath);
    if (dirname(localizedVideoPath) !== workDirectory || dirname(subtitlesPath) !== workDirectory) {
      throw new PocError("MEDIA_PATH_MISMATCH", "Final video inputs and output must share a directory");
    }
    if (settings.logoPath && dirname(settings.logoPath) !== workDirectory) {
      throw new PocError("MEDIA_PATH_MISMATCH", "Logo and final output must share a directory");
    }
    const sourceProbe = await this.probe(localizedVideoPath);
    const sourceVideo = sourceProbe.streams.find((stream) => stream.codec_type === "video");
    const sourceWidth = sourceVideo?.width ?? 0;
    if (sourceWidth <= 0) throw new PocError("INVALID_VIDEO_DIMENSIONS", "Localized video width is unavailable");

    const temporaryName = `${basename(outputPath)}.tmp.mp4`;
    const temporaryPath = join(workDirectory, temporaryName);
    const inputName = basename(localizedVideoPath);
    const filters: string[] = [];
    if (settings.brightness !== 0) {
      filters.push(`eq=brightness=${(settings.brightness / 100).toFixed(2)}`);
    }
    if (settings.subtitleMode === "burned") {
      filters.push(
        [
          `subtitles=filename=${basename(subtitlesPath)}`,
          `fontsdir=${this.options.fontDirectory}`,
          `force_style='FontName=${SUBTITLE_FONT_NAMES[settings.targetLanguage]},FontSize=22,MarginV=28'`,
        ].join(":"),
      );
    }

    const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", inputName];
    if (settings.logoPath) args.push("-i", basename(settings.logoPath));

    if (settings.logoPath) {
      const logoWidth = Math.max(24, Math.round(sourceWidth * (settings.logoSizePercent / 100)));
      const overlayByPosition: Record<LogoPosition, string> = {
        "top-left": "24:24",
        "top-right": "W-w-24:24",
        "bottom-left": "24:H-h-24",
        "bottom-right": "W-w-24:H-h-24",
      };
      const baseFilter = filters.length > 0 ? filters.join(",") : "null";
      args.push(
        "-filter_complex",
        `[0:v]${baseFilter}[base];[1:v]scale=${String(logoWidth)}:-1[logo];[base][logo]overlay=${overlayByPosition[settings.logoPosition]}:eof_action=repeat[v]`,
        "-map",
        "[v]",
      );
    } else {
      args.push("-map", "0:v:0");
      if (filters.length > 0) args.push("-vf", filters.join(","));
    }
    args.push(
      "-map",
      "0:a:0",
      "-c:v",
      "libx264",
      "-crf",
      "20",
      "-preset",
      "medium",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-af",
      `volume=${(settings.volumePercent / 100).toFixed(2)}`,
      "-t",
      sourceDurationSeconds.toFixed(3),
      "-movflags",
      "+faststart",
      temporaryName,
    );

    await rm(temporaryPath, { force: true });
    try {
      await runProcess(this.options.ffmpegPath, args, this.options.timeoutMs, workDirectory);
      await rename(temporaryPath, outputPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  public async generateSyntheticSource(outputPath: string, durationSeconds = 4): Promise<void> {
    await runProcess(
      this.options.ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x1f2937:s=640x360:r=25:d=${String(durationSeconds)}`,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:sample_rate=48000:duration=${String(durationSeconds)}`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      this.options.timeoutMs,
    );
  }
}
