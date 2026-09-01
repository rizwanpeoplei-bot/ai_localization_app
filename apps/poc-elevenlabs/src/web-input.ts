import { z } from "zod";
import { LanguageSchema, ProviderKindSchema } from "./domain.js";

const CheckboxSchema = z
  .union([z.boolean(), z.enum(["true", "false", "on", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "on" || value === "1")
  .default(false);

export const LogoPositionSchema = z.enum([
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);
export type LogoPosition = z.infer<typeof LogoPositionSchema>;

export const SubtitleModeSchema = z.enum(["none", "file", "burned"]);
export type SubtitleMode = z.infer<typeof SubtitleModeSchema>;

export const WebSubmissionSchema = z
  .object({
    videoUrl: z.string().trim().max(2_048).optional(),
    sourceLanguage: LanguageSchema,
    targetLanguage: LanguageSchema,
    provider: ProviderKindSchema.default("mock"),
    confirmBillable: CheckboxSchema,
    confirmSourceRights: CheckboxSchema,
    preserveVoice: CheckboxSchema,
    subtitleMode: SubtitleModeSchema.default("burned"),
    brightness: z.coerce.number().int().min(-50).max(50).default(0),
    volumePercent: z.coerce.number().int().min(0).max(200).default(100),
    logoPosition: LogoPositionSchema.default("bottom-right"),
    logoSizePercent: z.coerce.number().int().min(5).max(30).default(15),
  })
  .superRefine((value, context) => {
    if (value.sourceLanguage === value.targetLanguage) {
      context.addIssue({
        code: "custom",
        path: ["targetLanguage"],
        message: "Source and target languages must differ",
      });
    }
    if (value.videoUrl === "") delete value.videoUrl;
  });

export type WebSubmission = z.infer<typeof WebSubmissionSchema>;

export const WebEnvironmentSchema = z.object({
  UI_HOST: z.string().min(1).default("127.0.0.1"),
  UI_PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  UI_ARTIFACT_ROOT: z.string().min(1).default("artifacts"),
  UI_MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(524_288_000),
  UI_MAX_LOGO_BYTES: z.coerce.number().int().positive().default(10_485_760),
  UI_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  YTDLP_PATH: z.string().min(1).default("yt-dlp"),
});
