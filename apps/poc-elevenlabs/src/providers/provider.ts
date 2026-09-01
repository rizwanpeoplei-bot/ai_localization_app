import type {
  Language,
  ProviderProject,
  ProviderTarget,
  TargetTranscript,
} from "../domain.js";

export interface RestoreProjectInput {
  projectId: string;
  inputPath: string;
  sourceLanguage: Language;
  targets: Array<{ languageId: string; targetLanguage: Language }>;
}

export interface DubbingProvider {
  readonly kind: "mock" | "elevenlabs";
  createProject(inputPath: string, sourceLanguage: Language, reference: string): Promise<ProviderProject>;
  getProject(projectId: string): Promise<ProviderProject>;
  createLanguageTarget(projectId: string, targetLanguage: Language): Promise<ProviderTarget>;
  getLanguageTarget(projectId: string, languageId: string): Promise<ProviderTarget>;
  getTargetTranscript(projectId: string, languageId: string): Promise<TargetTranscript>;
  downloadLosslessAudio(projectId: string, languageId: string, outputPath: string): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  restoreProject?(input: RestoreProjectInput): void;
}
