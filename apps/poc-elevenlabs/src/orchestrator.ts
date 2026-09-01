import { access, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Language, ProviderKind, TargetTranscript } from "./domain.js";
import { assertLanguagePair, TargetTranscriptSchema } from "./domain.js";
import { PocError, sanitizeMessage } from "./errors.js";
import { createRunId, ensureDirectory, sha256File, writeJsonAtomic } from "./files.js";
import type { Logger } from "./logger.js";
import type { ManifestSource, ManifestTarget, RunManifest } from "./manifest.js";
import { RunManifestStore } from "./manifest.js";
import type { MediaProbe } from "./media.js";
import type { MediaService } from "./media.js";
import type { DubbingProvider } from "./providers/provider.js";
import { createBlankScorecard } from "./quality.js";
import { createSrt } from "./subtitles.js";

export interface SourceRunInput {
  id: string;
  inputPath: string;
  sourceLanguage: Language;
  targets: Language[];
}

export interface OrchestratorOptions {
  pollInitialMs: number;
  pollMaxMs: number;
  operationTimeoutMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function artifactExists(artifact: { path: string } | undefined): Promise<boolean> {
  if (!artifact) return false;
  return await access(artifact.path).then(
    () => true,
    () => false,
  );
}

function durationOf(probe: MediaProbe): number {
  return Number(probe.format.duration ?? probe.streams.find((stream) => stream.codec_type === "video")?.duration);
}

export class PocOrchestrator {
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;

  public constructor(
    private readonly provider: DubbingProvider,
    private readonly media: MediaService,
    private readonly logger: Logger,
    private readonly options: OrchestratorOptions,
  ) {
    this.sleep = options.sleep ?? delay;
    this.now = options.now ?? (() => new Date());
  }

  public async createRun(
    outputRoot: string,
    provider: ProviderKind,
    sources: SourceRunInput[],
  ): Promise<{ manifest: RunManifest; store: RunManifestStore }> {
    const runId = createRunId(this.now());
    const runDirectory = resolve(outputRoot, runId);
    await ensureDirectory(runDirectory);
    const createdAt = this.now().toISOString();
    const manifest: RunManifest = {
      version: 1,
      runId,
      provider,
      status: "running",
      outputRoot: runDirectory,
      createdAt,
      updatedAt: createdAt,
      sources: sources.map((source) => ({
        id: source.id,
        inputPath: resolve(source.inputPath),
        sourceLanguage: source.sourceLanguage,
        warnings: [],
        targets: source.targets.map((targetLanguage) => {
          assertLanguagePair(source.sourceLanguage, targetLanguage);
          return {
            targetLanguage,
            status: "pending" as const,
            stage: "PENDING" as const,
            artifactDirectory: join(runDirectory, `${source.sourceLanguage}-to-${targetLanguage}`),
            warnings: [],
            artifacts: {},
          };
        }),
      })),
    };
    const store = new RunManifestStore(join(runDirectory, "manifest.json"));
    await store.save(manifest);
    return { manifest, store };
  }

  public async execute(manifest: RunManifest, store: RunManifestStore): Promise<RunManifest> {
    this.restoreProvider(manifest);
    manifest.status = "running";
    delete manifest.completedAt;
    await store.save(manifest);
    try {
      for (const source of manifest.sources) {
        await this.processSource(manifest, source, store);
      }
      manifest.status = "completed";
      manifest.completedAt = this.now().toISOString();
      await store.save(manifest);
      this.logger.info("run.completed", { runId: manifest.runId, manifest: store.path });
      return manifest;
    } catch (error) {
      manifest.status = "failed";
      await store.save(manifest);
      throw error;
    }
  }

  public async cleanup(manifest: RunManifest, store: RunManifestStore): Promise<RunManifest> {
    this.restoreProvider(manifest);
    for (const source of manifest.sources) {
      if (source.projectId) {
        await this.provider.deleteProject(source.projectId);
        this.logger.info("provider.project.deleted", { projectId: source.projectId });
      }
    }
    manifest.status = "cleaned";
    manifest.cleanedAt = this.now().toISOString();
    await store.save(manifest);
    return manifest;
  }

  private restoreProvider(manifest: RunManifest): void {
    if (!this.provider.restoreProject) return;
    for (const source of manifest.sources) {
      if (!source.projectId) continue;
      this.provider.restoreProject({
        projectId: source.projectId,
        inputPath: source.inputPath,
        sourceLanguage: source.sourceLanguage,
        targets: source.targets.flatMap((target) =>
          target.languageId
            ? [{ languageId: target.languageId, targetLanguage: target.targetLanguage }]
            : [],
        ),
      });
    }
  }

  private async processSource(
    manifest: RunManifest,
    source: ManifestSource,
    store: RunManifestStore,
  ): Promise<void> {
    const sourceProbe = await this.media.probe(source.inputPath);
    const sourceDuration = this.media.validatePocSource(sourceProbe);
    if (!source.projectId) {
      if (source.providerStatus === "create-requested") {
        throw new PocError(
          "PROVIDER_PROJECT_CREATE_AMBIGUOUS",
          `Project creation was previously attempted for ${source.id}; reconcile the deterministic run reference in ElevenLabs before resuming`,
        );
      }
      source.providerStatus = "create-requested";
      await store.save(manifest);
      const project = await this.provider.createProject(
        source.inputPath,
        source.sourceLanguage,
        `${manifest.runId}:${source.id}`,
      );
      source.projectId = project.id;
      source.providerStatus = project.status;
      source.warnings = project.warnings;
      await store.save(manifest);
      this.logger.info("provider.project.created", { projectId: project.id, source: source.id });
    }
    await this.waitForProject(source, manifest, store);
    for (const target of source.targets) {
      await this.processTarget(manifest, source, target, sourceProbe, sourceDuration, store);
    }
  }

  private async waitForProject(
    source: ManifestSource,
    manifest: RunManifest,
    store: RunManifestStore,
  ): Promise<void> {
    if (source.providerStatus === "ready") return;
    const projectId = source.projectId;
    if (!projectId) throw new PocError("MANIFEST_INVALID", "Project id is missing");
    let pollMs = this.options.pollInitialMs;
    const deadline = Date.now() + this.options.operationTimeoutMs;
    while (Date.now() <= deadline) {
      try {
        const project = await this.provider.getProject(projectId);
        source.providerStatus = project.status;
        source.warnings = project.warnings;
        await store.save(manifest);
        if (project.status === "ready") return;
        if (project.status === "failed") {
          throw new PocError("PROVIDER_PROJECT_FAILED", project.error ?? "Provider project failed");
        }
      } catch (error) {
        if (!(error instanceof PocError) || !error.retryable) throw error;
        this.logger.info("provider.project.retry", { projectId, error: error.message });
      }
      await this.waitWithJitter(pollMs);
      pollMs = Math.min(Math.max(1, pollMs * 2), this.options.pollMaxMs);
    }
    throw new PocError("PROVIDER_PROJECT_TIMEOUT", `Provider project exceeded timeout: ${projectId}`);
  }

  private async processTarget(
    manifest: RunManifest,
    source: ManifestSource,
    target: ManifestTarget,
    sourceProbe: MediaProbe,
    sourceDuration: number,
    store: RunManifestStore,
  ): Promise<void> {
    const projectId = source.projectId;
    if (!projectId) throw new PocError("MANIFEST_INVALID", "Project id is missing");
    target.status = "running";
    target.startedAt ??= this.now().toISOString();
    delete target.errorCode;
    delete target.errorMessage;
    await ensureDirectory(target.artifactDirectory);
    await store.save(manifest);
    try {
      if (!target.languageId) {
        if (target.providerStatus === "create-requested") {
          throw new PocError(
            "PROVIDER_TARGET_CREATE_AMBIGUOUS",
            `Language creation was previously attempted for ${target.targetLanguage}; reconcile it in ElevenLabs before resuming`,
          );
        }
        target.providerStatus = "create-requested";
        await store.save(manifest);
        const created = await this.provider.createLanguageTarget(projectId, target.targetLanguage);
        target.languageId = created.id;
        target.providerStatus = created.status;
        target.warnings = created.warnings;
        target.stage = "TARGET_CREATED";
        await store.save(manifest);
        this.logger.info("provider.target.created", {
          projectId,
          languageId: created.id,
          targetLanguage: target.targetLanguage,
        });
      }
      await this.waitForTarget(projectId, target, manifest, store);
      await this.materializeArtifacts(manifest, source, target, sourceProbe, sourceDuration, store);
      target.status = "completed";
      target.stage = "COMPLETED";
      target.completedAt = this.now().toISOString();
      await store.save(manifest);
    } catch (error) {
      target.status = "failed";
      target.errorCode = error instanceof PocError ? error.code : "UNEXPECTED_ERROR";
      target.errorMessage = sanitizeMessage(error);
      await store.save(manifest);
      this.logger.error("target.failed", {
        targetLanguage: target.targetLanguage,
        errorCode: target.errorCode,
        error: target.errorMessage,
      });
      throw error;
    }
  }

  private async waitForTarget(
    projectId: string,
    target: ManifestTarget,
    manifest: RunManifest,
    store: RunManifestStore,
  ): Promise<void> {
    if (target.providerStatus === "completed" && target.stage !== "TARGET_CREATED") return;
    const languageId = target.languageId;
    if (!languageId) throw new PocError("MANIFEST_INVALID", "Language id is missing");
    let pollMs = this.options.pollInitialMs;
    const deadline = Date.now() + this.options.operationTimeoutMs;
    while (Date.now() <= deadline) {
      try {
        const providerTarget = await this.provider.getLanguageTarget(projectId, languageId);
        target.providerStatus = providerTarget.status;
        target.warnings = providerTarget.warnings;
        await store.save(manifest);
        if (providerTarget.status === "completed" && providerTarget.hasLosslessAudio) {
          target.stage = "TARGET_COMPLETED";
          await store.save(manifest);
          return;
        }
        if (providerTarget.status === "failed" || providerTarget.status === "stale") {
          throw new PocError(
            "PROVIDER_TARGET_FAILED",
            providerTarget.error ?? `Provider target entered ${providerTarget.status}`,
          );
        }
      } catch (error) {
        if (!(error instanceof PocError) || !error.retryable) throw error;
        this.logger.info("provider.target.retry", { languageId, error: error.message });
      }
      await this.waitWithJitter(pollMs);
      pollMs = Math.min(Math.max(1, pollMs * 2), this.options.pollMaxMs);
    }
    throw new PocError("PROVIDER_TARGET_TIMEOUT", `Provider target exceeded timeout: ${languageId}`);
  }

  private async materializeArtifacts(
    manifest: RunManifest,
    source: ManifestSource,
    target: ManifestTarget,
    sourceProbe: MediaProbe,
    sourceDuration: number,
    store: RunManifestStore,
  ): Promise<void> {
    const projectId = source.projectId;
    const languageId = target.languageId;
    if (!projectId || !languageId) throw new PocError("MANIFEST_INVALID", "Provider identifiers are missing");

    const providerAudioPath = join(target.artifactDirectory, "provider-audio.flac");
    if (!(await artifactExists(target.artifacts.providerAudio))) {
      const temporary = `${providerAudioPath}.download`;
      await rm(temporary, { force: true });
      try {
        await this.provider.downloadLosslessAudio(projectId, languageId, temporary);
        await rename(temporary, providerAudioPath);
      } finally {
        await rm(temporary, { force: true });
      }
      target.artifacts.providerAudio = await this.describeArtifact(providerAudioPath);
      target.stage = "AUDIO_DOWNLOADED";
      await store.save(manifest);
    }

    const transcriptPath = join(target.artifactDirectory, "target-transcript.json");
    let transcript: TargetTranscript;
    if (!(await artifactExists(target.artifacts.transcript))) {
      transcript = await this.provider.getTargetTranscript(projectId, languageId);
      await writeJsonAtomic(transcriptPath, transcript);
      target.artifacts.transcript = await this.describeArtifact(transcriptPath);
      target.stage = "TRANSCRIPT_DOWNLOADED";
      await store.save(manifest);
    } else {
      const { readJson } = await import("./files.js");
      transcript = TargetTranscriptSchema.parse(await readJson(transcriptPath));
    }

    const subtitlePath = join(target.artifactDirectory, "subtitles.srt");
    if (!(await artifactExists(target.artifacts.subtitles))) {
      await writeFile(subtitlePath, createSrt(transcript.segments), "utf8");
      target.artifacts.subtitles = await this.describeArtifact(subtitlePath);
      target.stage = "SRT_GENERATED";
      await store.save(manifest);
    }

    const localizedVideoPath = join(target.artifactDirectory, "localized.mp4");
    if (!(await artifactExists(target.artifacts.localizedVideo))) {
      await this.media.muxDubbedAudio(source.inputPath, providerAudioPath, localizedVideoPath, sourceDuration);
      target.artifacts.localizedVideo = await this.describeArtifact(localizedVideoPath);
      target.stage = "MUXED";
      await store.save(manifest);
    }

    const subtitledVideoPath = join(target.artifactDirectory, "localized-subtitled.mp4");
    if (!(await artifactExists(target.artifacts.subtitledVideo))) {
      await this.media.burnSubtitles(
        localizedVideoPath,
        subtitlePath,
        subtitledVideoPath,
        target.targetLanguage,
      );
      target.artifacts.subtitledVideo = await this.describeArtifact(subtitledVideoPath);
      target.stage = "SUBTITLED";
      await store.save(manifest);
    }

    const localizedProbe = await this.media.probe(localizedVideoPath);
    const subtitledProbe = await this.media.probe(subtitledVideoPath);
    this.validateFinalProbe(localizedProbe, sourceDuration);
    this.validateFinalProbe(subtitledProbe, sourceDuration);
    const probePath = join(target.artifactDirectory, "ffprobe.json");
    await writeJsonAtomic(probePath, {
      source: sourceProbe,
      localized: localizedProbe,
      subtitled: subtitledProbe,
    });
    target.artifacts.probe = await this.describeArtifact(probePath);

    const scorecardPath = join(target.artifactDirectory, "quality-scorecard.json");
    if (!(await artifactExists(target.artifacts.scorecard))) {
      await writeJsonAtomic(
        scorecardPath,
        createBlankScorecard(source.sourceLanguage, target.targetLanguage),
      );
      target.artifacts.scorecard = await this.describeArtifact(scorecardPath);
    }
  }

  private validateFinalProbe(probe: MediaProbe, sourceDuration: number): void {
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    const audio = probe.streams.find((stream) => stream.codec_type === "audio");
    if (video?.codec_name !== "h264" || audio?.codec_name !== "aac") {
      throw new PocError(
        "OUTPUT_CODEC_INVALID",
        `Expected H.264/AAC output, got ${video?.codec_name ?? "none"}/${audio?.codec_name ?? "none"}`,
      );
    }
    const duration = durationOf(probe);
    if (!Number.isFinite(duration) || Math.abs(duration - sourceDuration) > 0.25) {
      throw new PocError(
        "OUTPUT_DURATION_INVALID",
        `Output duration differs from source by more than 250ms: ${String(duration)} vs ${String(sourceDuration)}`,
      );
    }
  }

  private async describeArtifact(path: string): Promise<{ path: string; sha256: string }> {
    return { path, sha256: await sha256File(path) };
  }

  private async waitWithJitter(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return;
    const jittered = Math.max(1, Math.round(milliseconds * (0.8 + Math.random() * 0.4)));
    await this.sleep(jittered);
  }
}
