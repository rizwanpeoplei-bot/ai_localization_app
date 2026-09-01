import { resolve } from "node:path";
import { z } from "zod";
import { LanguageSchema, ProviderKindSchema } from "./domain.js";
import { readJson, writeJsonAtomic } from "./files.js";

export const TargetStageSchema = z.enum([
  "PENDING",
  "TARGET_CREATED",
  "TARGET_COMPLETED",
  "AUDIO_DOWNLOADED",
  "TRANSCRIPT_DOWNLOADED",
  "SRT_GENERATED",
  "MUXED",
  "SUBTITLED",
  "COMPLETED",
]);
export type TargetStage = z.infer<typeof TargetStageSchema>;

const ArtifactSchema = z.object({
  path: z.string(),
  sha256: z.string().length(64).optional(),
});

const ManifestTargetSchema = z.object({
  targetLanguage: LanguageSchema,
  status: z.enum(["pending", "running", "completed", "failed"]),
  stage: TargetStageSchema,
  artifactDirectory: z.string(),
  languageId: z.string().optional(),
  providerStatus: z.string().optional(),
  warnings: z.array(z.string()),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  artifacts: z.object({
    providerAudio: ArtifactSchema.optional(),
    transcript: ArtifactSchema.optional(),
    subtitles: ArtifactSchema.optional(),
    localizedVideo: ArtifactSchema.optional(),
    subtitledVideo: ArtifactSchema.optional(),
    probe: ArtifactSchema.optional(),
    scorecard: ArtifactSchema.optional(),
  }),
});

const ManifestSourceSchema = z.object({
  id: z.string(),
  inputPath: z.string(),
  sourceLanguage: LanguageSchema,
  projectId: z.string().optional(),
  providerStatus: z.string().optional(),
  warnings: z.array(z.string()),
  targets: z.array(ManifestTargetSchema),
});

export const RunManifestSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  provider: ProviderKindSchema,
  status: z.enum(["running", "completed", "failed", "cleaned"]),
  outputRoot: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
  cleanedAt: z.iso.datetime().optional(),
  sources: z.array(ManifestSourceSchema),
});

export type RunManifest = z.infer<typeof RunManifestSchema>;
export type ManifestSource = RunManifest["sources"][number];
export type ManifestTarget = ManifestSource["targets"][number];

export class RunManifestStore {
  public constructor(public readonly path: string) {}

  public static async load(path: string): Promise<{ store: RunManifestStore; manifest: RunManifest }> {
    const resolved = resolve(path);
    const manifest = RunManifestSchema.parse(await readJson(resolved));
    return { store: new RunManifestStore(resolved), manifest };
  }

  public async save(manifest: RunManifest): Promise<void> {
    manifest.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.path, RunManifestSchema.parse(manifest));
  }
}
