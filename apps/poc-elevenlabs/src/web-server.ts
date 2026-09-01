#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { validateInputFile, validateOutputRoot } from "./config.js";
import { PocError, sanitizeMessage } from "./errors.js";
import { ensureDirectory, sha256File, writeJsonAtomic } from "./files.js";
import { JsonLogger } from "./logger.js";
import type { MediaProbe } from "./media.js";
import { createRuntime, loadLocalEnvironment, requireLiveConfirmation } from "./runtime.js";
import { downloadPublicVideo } from "./url-downloader.js";
import { downloadYoutubeVideo, isYoutubeVideoUrl } from "./youtube-downloader.js";
import {
  WebEnvironmentSchema,
  WebSubmissionSchema,
  type WebSubmission,
} from "./web-input.js";

type JobStatus = "queued" | "running" | "completed" | "failed";

interface JobResult {
  runId: string;
  pair: string;
  provider: WebSubmission["provider"];
  previewUrl: string;
  localizedUrl: string;
  subtitledUrl?: string;
  subtitleUrl?: string;
  scorecardUrl: string;
}

interface WebJob {
  id: string;
  status: JobStatus;
  stage: string;
  createdAt: string;
  updatedAt: string;
  error?: { code: string; message: string };
  result?: JobResult;
}

interface JobFiles {
  videoPath?: string;
  logoPath?: string;
  logoExtension?: string;
}

interface WebRuntimeEnvironment {
  host: string;
  port: number;
  artifactRoot: string;
  maxVideoBytes: number;
  maxLogoBytes: number;
  downloadTimeoutMs: number;
  ytDlpPath: string;
}

const jobs = new Map<string, WebJob>();
let executionQueue: Promise<void> = Promise.resolve();

function touch(job: WebJob, stage: string, status: JobStatus = job.status): void {
  job.stage = stage;
  job.status = status;
  job.updatedAt = new Date().toISOString();
}

function mediaUrl(runId: string, pair: string, file: string): string {
  return `/artifacts/${encodeURIComponent(runId)}/${encodeURIComponent(pair)}/${encodeURIComponent(file)}`;
}

function fileExtensionForLogo(file: Express.Multer.File): string {
  const byMime: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  };
  return byMime[file.mimetype] ?? extname(file.originalname).toLowerCase();
}

function multerFiles(request: Request): { video?: Express.Multer.File; logo?: Express.Multer.File } {
  const files = request.files as Record<string, Express.Multer.File[]> | undefined;
  const video = files?.video?.[0];
  const logo = files?.logo?.[0];
  return {
    ...(video ? { video } : {}),
    ...(logo ? { logo } : {}),
  };
}

async function moveIfPresent(source: string | undefined, destination: string): Promise<string | undefined> {
  if (!source) return undefined;
  await rename(source, destination);
  return destination;
}

async function runWebJob(
  job: WebJob,
  submission: WebSubmission,
  files: JobFiles,
  environment: WebRuntimeEnvironment,
): Promise<void> {
  let stagedVideoPath = files.videoPath;
  let stagedLogoPath = files.logoPath;
  try {
    touch(job, "Preparing media", "running");
    const runtime = await createRuntime(submission.provider, true, new JsonLogger());
    if (!stagedVideoPath) {
      if (!submission.videoUrl) throw new PocError("VIDEO_INPUT_REQUIRED", "Upload an MP4 or provide a video URL");
      stagedVideoPath = join(environment.artifactRoot, ".ui-staging", `${job.id}-source.mp4`);
      touch(job, "Downloading video");
      if (isYoutubeVideoUrl(submission.videoUrl)) {
        await downloadYoutubeVideo(submission.videoUrl, stagedVideoPath, {
          maxBytes: environment.maxVideoBytes,
          timeoutMs: environment.downloadTimeoutMs,
          ytDlpPath: environment.ytDlpPath,
        });
      } else {
        await downloadPublicVideo(submission.videoUrl, stagedVideoPath, {
          maxBytes: environment.maxVideoBytes,
          timeoutMs: environment.downloadTimeoutMs,
        });
      }
    }
    const validatedInput = await validateInputFile(stagedVideoPath);
    let sourceProbe: MediaProbe;
    try {
      sourceProbe = await runtime.media.probe(validatedInput);
    } catch (error) {
      throw new PocError(
        "INVALID_VIDEO",
        "The downloaded or uploaded file is not a complete readable MP4. Use a direct MP4 URL or upload the video file.",
        false,
        error instanceof Error ? { cause: error } : undefined,
      );
    }
    const sourceDuration = runtime.media.validatePocSource(sourceProbe);

    touch(job, "Creating localization run");
    const created = await runtime.orchestrator.createRun(environment.artifactRoot, submission.provider, [
      {
        id: `${submission.sourceLanguage}-web-source`,
        inputPath: validatedInput,
        sourceLanguage: submission.sourceLanguage,
        targets: [submission.targetLanguage],
      },
    ]);
    const inputDirectory = join(created.manifest.outputRoot, "input");
    await ensureDirectory(inputDirectory);
    const durableVideoPath = join(inputDirectory, "source.mp4");
    await rename(validatedInput, durableVideoPath);
    stagedVideoPath = undefined;
    created.manifest.sources[0]!.inputPath = durableVideoPath;

    let durableLogoPath: string | undefined;
    if (stagedLogoPath) {
      durableLogoPath = join(inputDirectory, `logo${files.logoExtension ?? ".png"}`);
      await rename(stagedLogoPath, durableLogoPath);
      stagedLogoPath = undefined;
    }
    await created.store.save(created.manifest);
    await writeJsonAtomic(join(created.manifest.outputRoot, "web-submission.json"), {
      version: 1,
      submittedAt: job.createdAt,
      source: { kind: submission.videoUrl ? (isYoutubeVideoUrl(submission.videoUrl) ? "youtube" : "url") : "upload" },
      settings: {
        sourceLanguage: submission.sourceLanguage,
        targetLanguage: submission.targetLanguage,
        provider: submission.provider,
        preserveVoice: submission.preserveVoice,
        subtitleMode: submission.subtitleMode,
        brightness: submission.brightness,
        volumePercent: submission.volumePercent,
        logo: {
          enabled: Boolean(durableLogoPath),
          position: submission.logoPosition,
          sizePercent: submission.logoSizePercent,
        },
      },
    });

    touch(job, "Dubbing and generating subtitles");
    const manifest = await runtime.orchestrator.execute(created.manifest, created.store);
    const target = manifest.sources[0]?.targets[0];
    if (!target?.artifacts.localizedVideo || !target.artifacts.subtitles) {
      throw new PocError("WEB_ARTIFACTS_MISSING", "Localization completed without required media artifacts");
    }
    const logoForRender = durableLogoPath
      ? await moveIfPresent(
          durableLogoPath,
          join(target.artifactDirectory, `logo${files.logoExtension ?? ".png"}`),
        )
      : undefined;

    touch(job, "Applying video settings");
    const finalPath = join(target.artifactDirectory, "localized-final.mp4");
    await runtime.media.renderFinalVideo(
      target.artifacts.localizedVideo.path,
      target.artifacts.subtitles.path,
      finalPath,
      sourceDuration,
      {
        brightness: submission.brightness,
        volumePercent: submission.volumePercent,
        subtitleMode: submission.subtitleMode,
        targetLanguage: submission.targetLanguage,
        ...(logoForRender ? { logoPath: logoForRender } : {}),
        logoPosition: submission.logoPosition,
        logoSizePercent: submission.logoSizePercent,
      },
    );
    const finalProbe = await runtime.media.probe(finalPath);
    const video = finalProbe.streams.find((stream) => stream.codec_type === "video");
    const audio = finalProbe.streams.find((stream) => stream.codec_type === "audio");
    const finalDuration = Number(finalProbe.format.duration ?? video?.duration ?? audio?.duration);
    if (video?.codec_name !== "h264" || audio?.codec_name !== "aac") {
      throw new PocError("OUTPUT_CODEC_INVALID", "Final UI output is not H.264/AAC");
    }
    if (!Number.isFinite(finalDuration) || Math.abs(finalDuration - sourceDuration) > 0.25) {
      throw new PocError("OUTPUT_DURATION_INVALID", "Final UI output duration differs from the source");
    }
    await writeJsonAtomic(join(target.artifactDirectory, "web-result.json"), {
      final: { path: finalPath, sha256: await sha256File(finalPath), probe: finalProbe },
    });

    const pair = `${submission.sourceLanguage}-to-${submission.targetLanguage}`;
    job.result = {
      runId: manifest.runId,
      pair,
      provider: submission.provider,
      previewUrl: mediaUrl(manifest.runId, pair, "localized-final.mp4"),
      localizedUrl: mediaUrl(manifest.runId, pair, "localized.mp4"),
      ...(submission.subtitleMode === "burned"
        ? { subtitledUrl: mediaUrl(manifest.runId, pair, "localized-subtitled.mp4") }
        : {}),
      ...(submission.subtitleMode !== "none"
        ? { subtitleUrl: mediaUrl(manifest.runId, pair, "subtitles.srt") }
        : {}),
      scorecardUrl: mediaUrl(manifest.runId, pair, "quality-scorecard.json"),
    };
    touch(job, "Completed", "completed");
  } catch (error) {
    job.error = {
      code: error instanceof PocError ? error.code : "WEB_JOB_FAILED",
      message: sanitizeMessage(error),
    };
    touch(job, "Failed", "failed");
    new JsonLogger().error("web.job.failed", { jobId: job.id, errorCode: job.error.code });
  } finally {
    await Promise.all(
      [stagedVideoPath, stagedLogoPath]
        .filter((path): path is string => Boolean(path))
        .map((path) => rm(path, { force: true })),
    );
  }
}

function queueWebJob(
  job: WebJob,
  submission: WebSubmission,
  files: JobFiles,
  environment: WebRuntimeEnvironment,
): void {
  executionQueue = executionQueue
    .then(async () => runWebJob(job, submission, files, environment))
    .catch(() => undefined);
}

export async function createWebApp(environment: WebRuntimeEnvironment): Promise<express.Express> {
  const app = express();
  const stagingRoot = join(environment.artifactRoot, ".ui-staging");
  await ensureDirectory(stagingRoot);
  const upload = multer({
    dest: stagingRoot,
    limits: { fileSize: environment.maxVideoBytes, files: 2, fields: 20 },
    fileFilter: (_request, file, callback) => {
      if (file.fieldname === "video") {
        const valid = file.mimetype === "video/mp4" || extname(file.originalname).toLowerCase() === ".mp4";
        if (!valid) callback(new PocError("UNSUPPORTED_FORMAT", "Uploaded video must be MP4"));
        else callback(null, true);
        return;
      }
      if (file.fieldname === "logo") {
        const valid = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
        if (!valid) callback(new PocError("LOGO_FORMAT_INVALID", "Logo must be PNG, JPG, or WebP"));
        else callback(null, true);
        return;
      }
      callback(new PocError("UPLOAD_FIELD_INVALID", `Unexpected upload field: ${file.fieldname}`));
    },
  });

  app.disable("x-powered-by");
  app.get("/health", (_request, response) => response.json({ status: "ok" }));
  app.get("/api/jobs", (_request, response) => response.json([...jobs.values()].slice(-20).reverse()));
  app.get("/api/jobs/:id", (request, response) => {
    const job = jobs.get(request.params.id ?? "");
    if (!job) {
      response.status(404).json({ code: "JOB_NOT_FOUND", message: "Job was not found" });
      return;
    }
    response.json(job);
  });
  app.post(
    "/api/jobs",
    upload.fields([
      { name: "video", maxCount: 1 },
      { name: "logo", maxCount: 1 },
    ]),
    async (request, response, next) => {
      const uploaded = multerFiles(request);
      try {
        const submission = WebSubmissionSchema.parse(request.body);
        requireLiveConfirmation(submission.provider, submission.confirmBillable);
        if (Boolean(uploaded.video) === Boolean(submission.videoUrl)) {
          throw new PocError("VIDEO_INPUT_INVALID", "Provide exactly one video upload or public video URL");
        }
        if (submission.videoUrl && isYoutubeVideoUrl(submission.videoUrl) && !submission.confirmSourceRights) {
          throw new PocError(
            "SOURCE_RIGHTS_CONFIRMATION_REQUIRED",
            "Confirm that you own or have permission to process this YouTube video",
          );
        }
        if (uploaded.video && uploaded.video.size > environment.maxVideoBytes) {
          throw new PocError("VIDEO_TOO_LARGE", "Uploaded video exceeds the configured size limit");
        }
        if (uploaded.logo && uploaded.logo.size > environment.maxLogoBytes) {
          throw new PocError("LOGO_TOO_LARGE", "Logo exceeds the configured size limit");
        }
        const id = randomUUID();
        const now = new Date().toISOString();
        const normalizedVideoPath = uploaded.video
          ? join(stagingRoot, `${id}-source.mp4`)
          : undefined;
        const logoExtension = uploaded.logo ? fileExtensionForLogo(uploaded.logo) : undefined;
        const normalizedLogoPath = uploaded.logo
          ? join(stagingRoot, `${id}-logo${logoExtension ?? ".png"}`)
          : undefined;
        if (uploaded.video && normalizedVideoPath) await rename(uploaded.video.path, normalizedVideoPath);
        if (uploaded.logo && normalizedLogoPath) await rename(uploaded.logo.path, normalizedLogoPath);
        const job: WebJob = { id, status: "queued", stage: "Queued", createdAt: now, updatedAt: now };
        jobs.set(id, job);
        queueWebJob(
          job,
          submission,
          {
            ...(normalizedVideoPath ? { videoPath: normalizedVideoPath } : {}),
            ...(normalizedLogoPath ? { logoPath: normalizedLogoPath } : {}),
            ...(logoExtension ? { logoExtension } : {}),
          },
          environment,
        );
        response.status(202).json(job);
      } catch (error) {
        await Promise.all(
          [uploaded.video?.path, uploaded.logo?.path]
            .filter((path): path is string => Boolean(path))
            .map((path) => rm(path, { force: true })),
        );
        next(error);
      }
    },
  );

  const safeFiles = new Set([
    "localized-final.mp4",
    "localized.mp4",
    "localized-subtitled.mp4",
    "subtitles.srt",
    "quality-scorecard.json",
  ]);
  app.get("/artifacts/:runId/:pair/:file", async (request, response, next) => {
    try {
      const { runId = "", pair = "", file = "" } = request.params;
      if (!/^[a-zA-Z0-9-]+$/u.test(runId) || !/^(en|ur|hi)-to-(en|ur|hi)$/u.test(pair) || !safeFiles.has(file)) {
        throw new PocError("ARTIFACT_PATH_INVALID", "Artifact path is invalid");
      }
      const artifactPath = resolve(environment.artifactRoot, runId, pair, file);
      const expectedPrefix = `${resolve(environment.artifactRoot)}${sep}`;
      if (!artifactPath.startsWith(expectedPrefix)) throw new PocError("ARTIFACT_PATH_INVALID", "Artifact path is unsafe");
      await access(artifactPath, constants.R_OK);
      response.sendFile(artifactPath);
    } catch (error) {
      next(error);
    }
  });

  const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));
  app.use(express.static(publicDirectory, { index: "index.html", fallthrough: true }));
  app.get("*path", (_request, response) => response.sendFile(join(publicDirectory, "index.html")));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    void _next;
    const zodMessage = error instanceof z.ZodError ? z.prettifyError(error) : undefined;
    const code = error instanceof PocError ? error.code : error instanceof multer.MulterError ? error.code : "WEB_REQUEST_FAILED";
    response.status(400).json({ code, message: zodMessage ?? sanitizeMessage(error) });
  });
  return app;
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const parsed = WebEnvironmentSchema.parse(process.env);
  const environment: WebRuntimeEnvironment = {
    host: parsed.UI_HOST,
    port: parsed.UI_PORT,
    artifactRoot: validateOutputRoot(parsed.UI_ARTIFACT_ROOT),
    maxVideoBytes: parsed.UI_MAX_VIDEO_BYTES,
    maxLogoBytes: parsed.UI_MAX_LOGO_BYTES,
    downloadTimeoutMs: parsed.UI_DOWNLOAD_TIMEOUT_MS,
    ytDlpPath: parsed.YTDLP_PATH,
  };
  await mkdir(environment.artifactRoot, { recursive: true });
  const app = await createWebApp(environment);
  app.listen(environment.port, environment.host, () => {
    process.stdout.write(`AI Localization UI: http://${environment.host}:${String(environment.port)}\n`);
  });
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPath) {
  void main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ level: "error", code: "WEB_START_FAILED", message: sanitizeMessage(error) })}\n`);
    process.exitCode = 1;
  });
}
