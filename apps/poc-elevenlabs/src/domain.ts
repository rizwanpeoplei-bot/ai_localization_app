import { z } from "zod";

export const LanguageSchema = z.enum(["en", "ur", "hi"]);
export type Language = z.infer<typeof LanguageSchema>;

export const ProviderKindSchema = z.enum(["mock", "elevenlabs"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProjectStatusSchema = z.enum([
  "queued",
  "preparing",
  "processing",
  "ready",
  "failed",
]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const TargetStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "stale",
  "failed",
]);
export type TargetStatus = z.infer<typeof TargetStatusSchema>;

export interface ProviderProject {
  id: string;
  status: ProjectStatus;
  warnings: string[];
  error?: string;
}

export interface ProviderTarget {
  id: string;
  projectId: string;
  targetLanguage: Language;
  status: TargetStatus;
  warnings: string[];
  error?: string;
  hasLosslessAudio: boolean;
}

export const TranscriptSegmentSchema = z.object({
  id: z.string().min(1),
  speakerId: z.string().min(1),
  startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().positive(),
  sourceText: z.string(),
  translation: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const TargetTranscriptSchema = z.object({
  sourceLanguage: LanguageSchema,
  targetLanguage: LanguageSchema,
  revision: z.number().int().nonnegative(),
  segments: z.array(TranscriptSegmentSchema),
});
export type TargetTranscript = z.infer<typeof TargetTranscriptSchema>;

export const MatrixSourceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    input: z.string().min(1),
    sourceLanguage: LanguageSchema,
    targets: z.array(LanguageSchema).length(2),
  })
  .superRefine((source, context) => {
    const uniqueTargets = new Set(source.targets);
    if (uniqueTargets.size !== source.targets.length) {
      context.addIssue({ code: "custom", message: "Target languages must be unique" });
    }
    if (uniqueTargets.has(source.sourceLanguage)) {
      context.addIssue({ code: "custom", message: "Source and target languages must differ" });
    }
    const expected = new Set(
      LanguageSchema.options.filter((language) => language !== source.sourceLanguage),
    );
    if ([...expected].some((language) => !uniqueTargets.has(language))) {
      context.addIssue({
        code: "custom",
        message: "Each source must target both other supported languages",
      });
    }
  });

export const MatrixConfigSchema = z
  .object({
    version: z.literal(1),
    sources: z.array(MatrixSourceSchema).length(3),
  })
  .superRefine((matrix, context) => {
    const ids = new Set(matrix.sources.map((source) => source.id));
    if (ids.size !== matrix.sources.length) {
      context.addIssue({ code: "custom", message: "Source ids must be unique" });
    }
    const sourceLanguages = new Set(matrix.sources.map((source) => source.sourceLanguage));
    if (LanguageSchema.options.some((language) => !sourceLanguages.has(language))) {
      context.addIssue({
        code: "custom",
        message: "The matrix must contain one English, Urdu, and Hindi source",
      });
    }
  });

export type MatrixConfig = z.infer<typeof MatrixConfigSchema>;

export function assertLanguagePair(source: Language, target: Language): void {
  if (source === target) {
    throw new Error(`Source and target languages must differ: ${source} -> ${target}`);
  }
}
