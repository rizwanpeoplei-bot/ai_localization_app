import { createWriteStream, openAsBlob } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
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
  if (typeof error === "string") return sanitizeMessage(error);
  if (typeof error !== "object" || error === null) return undefined;
  const fields = error as Record<string, unknown>;
  for (const key of ["error", "message", "code", "detail"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) return sanitizeMessage(value);
  }
  return Object.keys(fields).length > 0 ? "provider-reported-failure" : undefined;
}

export class ElevenLabsDubbingProvider implements DubbingProvider {
  public readonly kind = "elevenlabs" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(options: ElevenLabsProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.timeoutMs = options.timeoutMs;
  }

  public async createProject(
    inputPath: string,
    sourceLanguage: Language,
    reference: string,
  ): Promise<ProviderProject> {
    try {
      const body = new FormData();
      body.append("file", await openAsBlob(inputPath), "source.mp4");
      body.append("source_language", sourceLanguage);
      body.append("model_id", "dubbing_v2");
      body.append("reference", reference.slice(0, 500));
      const project = await this.requestJson("v1/dubbing/project", { method: "POST", body });
      const providerError = errorLabel(this.optionalValue(project, "error"));
      return {
        id: this.requireString(project, "project_id"),
        status: ProjectStatusSchema.parse(this.requireString(project, "status")),
        warnings: warningLabels(this.optionalArray(project, "warnings")),
        ...(providerError ? { error: providerError } : {}),
      };
    } catch (error) {
      throw classifyProviderError(error);
    }
  }

  public async getProject(projectId: string): Promise<ProviderProject> {
    try {
      const project = await this.requestJson(`v1/dubbing/project/${encodeURIComponent(projectId)}`);
      const providerError = errorLabel(this.optionalValue(project, "error"));
      return {
        id: this.requireString(project, "project_id"),
        status: ProjectStatusSchema.parse(this.requireString(project, "status")),
        warnings: warningLabels(this.optionalArray(project, "warnings")),
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
      const target = await this.requestJson(`v1/dubbing/project/${encodeURIComponent(projectId)}/language`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_language: targetLanguage }),
      });
      return this.mapTarget(target);
    } catch (error) {
      throw classifyProviderError(error);
    }
  }

  public async getLanguageTarget(projectId: string, languageId: string): Promise<ProviderTarget> {
    try {
      return this.mapTarget(
        await this.requestJson(
          `v1/dubbing/project/${encodeURIComponent(projectId)}/language/${encodeURIComponent(languageId)}`,
        ),
      );
    } catch (error) {
      throw classifyProviderError(error);
    }
  }

  public async getTargetTranscript(projectId: string, languageId: string): Promise<TargetTranscript> {
    try {
      const transcript = await this.requestJson(
        `v1/dubbing/project/${encodeURIComponent(projectId)}/language/${encodeURIComponent(languageId)}/transcript`,
      );
      const segments = this.optionalArray(transcript, "segments") ?? [];
      return TargetTranscriptSchema.parse({
        sourceLanguage: LanguageSchema.parse(this.requireString(transcript, "source_language")),
        targetLanguage: LanguageSchema.parse(this.requireString(transcript, "target_language")),
        revision: this.requireNumber(transcript, "revision"),
        segments: segments.map((segment) => {
          if (typeof segment !== "object" || segment === null) {
            throw new PocError("TRANSCRIPT_SEGMENT_INVALID", "Provider transcript segment is invalid");
          }
          const translation = this.optionalValue(segment, "translation");
          if (typeof translation !== "string" || !translation) {
            throw new PocError(
              "TRANSCRIPT_TRANSLATION_MISSING",
              `Provider transcript segment ${this.requireString(segment, "id")} has no translation`,
            );
          }
          return {
            id: this.requireString(segment, "id"),
            speakerId: this.requireString(segment, "speaker_id"),
            startSeconds: this.requireNumber(segment, "start_s"),
            endSeconds: this.requireNumber(segment, "end_s"),
            sourceText: this.requireString(segment, "source_text"),
            translation,
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
      const refreshed = await this.requestJson(
        `v1/dubbing/project/${encodeURIComponent(projectId)}/language/${encodeURIComponent(languageId)}`,
      );
      const outputs = this.optionalValue(refreshed, "outputs");
      const signedUrl =
        typeof outputs === "object" && outputs !== null
          ? this.optionalValue(outputs, "lossless_audio")
          : undefined;
      if (this.requireString(refreshed, "status") !== "completed" || typeof signedUrl !== "string" || !signedUrl) {
        throw new PocError("PROVIDER_OUTPUT_MISSING", "Completed target has no lossless audio output");
      }
      const response = await this.fetchImplementation(signedUrl, { signal: AbortSignal.timeout(this.timeoutMs) });
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
      await this.requestEmpty(`v1/dubbing/project/${encodeURIComponent(projectId)}`, { method: "DELETE" });
    } catch (error) {
      throw classifyProviderError(error);
    }
  }

  private mapTarget(target: unknown): ProviderTarget {
    const outputs = this.optionalValue(target, "outputs");
    const providerError = errorLabel(this.optionalValue(target, "error"));
    return {
      id: this.requireString(target, "language_id"),
      projectId: this.requireString(target, "project_id"),
      targetLanguage: LanguageSchema.parse(this.requireString(target, "target_language")),
      status: TargetStatusSchema.parse(this.requireString(target, "status")),
      warnings: warningLabels(this.optionalArray(target, "warnings")),
      hasLosslessAudio: Boolean(
        typeof outputs === "object" && outputs !== null && this.optionalValue(outputs, "lossless_audio"),
      ),
      ...(providerError ? { error: providerError } : {}),
    };
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(path, init);
    return response.json() as Promise<unknown>;
  }

  private async requestEmpty(path: string, init: RequestInit = {}): Promise<void> {
    await this.request(path, init);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetchImplementation(`${this.baseUrl}/${path}`, {
      ...init,
      headers: {
        "xi-api-key": this.apiKey,
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (response.ok) return response;

    throw new PocError(
      response.status === 429 ? "PROVIDER_RATE_LIMIT" : response.status >= 500 ? "PROVIDER_TEMPORARY" : "PROVIDER_FAILED",
      `Provider request failed with HTTP ${response.status}: ${await this.safeResponseText(response)}`,
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }

  private async safeResponseText(response: Response): Promise<string> {
    try {
      return sanitizeMessage(await response.text());
    } catch {
      return "unreadable response";
    }
  }

  private optionalValue(value: unknown, key: string): unknown {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as Record<string, unknown>)[key];
  }

  private optionalArray(value: unknown, key: string): unknown[] | undefined {
    const candidate = this.optionalValue(value, key);
    return Array.isArray(candidate) ? candidate : undefined;
  }

  private requireString(value: unknown, key: string): string {
    const candidate = this.optionalValue(value, key);
    if (typeof candidate === "string") return candidate;
    throw new PocError("PROVIDER_RESPONSE_INVALID", `Provider response missing string field: ${key}`);
  }

  private requireNumber(value: unknown, key: string): number {
    const candidate = this.optionalValue(value, key);
    if (typeof candidate === "number") return candidate;
    throw new PocError("PROVIDER_RESPONSE_INVALID", `Provider response missing numeric field: ${key}`);
  }
}
