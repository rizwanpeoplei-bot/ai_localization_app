import { createReadStream } from "node:fs";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type {
  Language,
  ProviderProject,
  ProviderTarget,
  TargetTranscript,
} from "../domain.js";
import {
  LanguageSchema,
  ProjectStatusSchema,
  TargetStatusSchema,
  TargetTranscriptSchema,
} from "../domain.js";
import { classifyProviderError, PocError, sanitizeMessage } from "../errors.js";
import type { DubbingProvider } from "./provider.js";

export interface ElevenLabsProviderOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetchImplementation?: typeof fetch;
}

function warningLabels(warnings: unknown[] | undefined): string[] {
  return (warnings ?? []).map((warning) => {
    if (typeof warning === "object" && warning !== null) {
      const type = (warning as Record<string, unknown>).type;
      if (typeof type === "string") return type;
    }
    return "provider-warning";
  });
}

function errorLabel(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? sanitizeMessage(code) : "provider-reported-failure";
}

export class ElevenLabsDubbingProvider implements DubbingProvider {
  public readonly kind = "elevenlabs" as const;
  private readonly client: ElevenLabsClient;
  private readonly timeoutMs: number;

  public constructor(options: ElevenLabsProviderOptions) {
    this.timeoutMs = options.timeoutMs;
    this.client = new ElevenLabsClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      timeoutInSeconds: Math.ceil(options.timeoutMs / 1_000),
      maxRetries: 2,
      ...(options.fetchImplementation ? { fetch: options.fetchImplementation } : {}),
    });
  }

  public async createProject(
    inputPath: string,
    sourceLanguage: Language,
    reference: string,
  ): Promise<ProviderProject> {
    try {
      const project = await this.client.dubbing.project.create({
        file: createReadStream(inputPath),
        sourceLanguage,
        modelId: "dubbing_v2",
        reference: reference.slice(0, 500),
      }, { maxRetries: 0 });
      const providerError = errorLabel(project.error);
      return {
        id: project.projectId,
        status: ProjectStatusSchema.parse(project.status),
        warnings: warningLabels(project.warnings),
        ...(providerError ? { error: providerError } : {}),
      };
    } catch (error) {
      throw classifyProviderError(error);
    }
  }

  public async getProject(projectId: string): Promise<ProviderProject> {
    try {
      const project = await this.client.dubbing.project.get(projectId);
      const providerError = errorLabel(project.error);
      return {
        id: project.projectId,
        status: ProjectStatusSchema.parse(project.status),
        warnings: warningLabels(project.warnings),
        ...(providerError ? { error: providerError } : {}),
      };
    } catch (error) {
      throw classifyProviderError(error);
    }
  }

  public async createLanguageTarget(
    projectId: string,
    targetLanguage: Language,
  ): Promise<ProviderTarget> {
    try {
      const target = await this.client.dubbing.project.language.create(projectId, {
        targetLanguage,
      }, { maxRetries: 0 });
      return this.mapTarget(target);
    } catch (error) {
      throw classifyProviderError(error);
    }
  }

  public async getLanguageTarget(projectId: string, languageId: string): Promise<ProviderTarget> {
    try {
      return this.mapTarget(await this.client.dubbing.project.language.get(projectId, languageId));
    } catch (error) {
      throw classifyProviderError(error);
    }
  }

  public async getTargetTranscript(projectId: string, languageId: string): Promise<TargetTranscript> {
    try {
      const transcript = await this.client.dubbing.project.language.transcript.get(projectId, languageId);
      return TargetTranscriptSchema.parse({
        sourceLanguage: LanguageSchema.parse(transcript.sourceLanguage),
        targetLanguage: LanguageSchema.parse(transcript.targetLanguage),
        revision: transcript.revision,
        segments: transcript.segments.map((segment) => {
          if (!segment.translation) {
            throw new PocError(
              "TRANSCRIPT_TRANSLATION_MISSING",
              `Provider transcript segment ${segment.id} has no translation`,
            );
          }
          return {
            id: segment.id,
            speakerId: segment.speakerId,
            startSeconds: segment.startS,
            endSeconds: segment.endS,
            sourceText: segment.sourceText,
            translation: segment.translation,
          };
        }),
      });
    } catch (error) {
      throw classifyProviderError(error);
    }
  }

  public async downloadLosslessAudio(
    projectId: string,
    languageId: string,
    outputPath: string,
  ): Promise<void> {
    try {
      const refreshed = await this.client.dubbing.project.language.get(projectId, languageId);
      const signedUrl = refreshed.outputs?.losslessAudio;
      if (refreshed.status !== "completed" || !signedUrl) {
        throw new PocError("PROVIDER_OUTPUT_MISSING", "Completed target has no lossless audio output");
      }
      const response = await fetch(signedUrl, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok || !response.body) {
        throw new PocError(
          "PROVIDER_DOWNLOAD_FAILED",
          `Provider audio download failed with HTTP ${response.status}`,
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }
      await pipeline(
        Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
        createWriteStream(outputPath, { flags: "wx" }),
      );
    } catch (error) {
      throw classifyProviderError(error);
    }
  }

  public async deleteProject(projectId: string): Promise<void> {
    try {
      await this.client.dubbing.project.delete(projectId);
    } catch (error) {
      throw classifyProviderError(error);
    }
  }

  private mapTarget(target: {
    languageId: string;
    projectId: string;
    targetLanguage: string;
    status: string;
    warnings?: unknown[];
    error?: unknown;
    outputs?: { losslessAudio?: string };
  }): ProviderTarget {
    const providerError = errorLabel(target.error);
    return {
      id: target.languageId,
      projectId: target.projectId,
      targetLanguage: LanguageSchema.parse(target.targetLanguage),
      status: TargetStatusSchema.parse(target.status),
      warnings: warningLabels(target.warnings),
      hasLosslessAudio: Boolean(target.outputs?.losslessAudio),
      ...(providerError ? { error: providerError } : {}),
    };
  }
}
