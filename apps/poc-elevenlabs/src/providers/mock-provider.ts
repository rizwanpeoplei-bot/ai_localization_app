import { randomUUID } from "node:crypto";
import type {
  Language,
  ProviderProject,
  ProviderTarget,
  TargetTranscript,
} from "../domain.js";
import { PocError } from "../errors.js";
import type { DubbingProvider, RestoreProjectInput } from "./provider.js";

interface MockProjectState {
  inputPath: string;
  sourceLanguage: Language;
  reads: number;
}

interface MockTargetState {
  projectId: string;
  targetLanguage: Language;
  reads: number;
}

export type MockAudioFactory = (inputPath: string, outputPath: string) => Promise<void>;

const TRANSLATIONS: Record<Language, string> = {
  en: "Welcome to the AI video localization proof of concept.",
  ur: "اے آئی ویڈیو لوکلائزیشن کے ثبوت میں خوش آمدید۔",
  hi: "एआई वीडियो स्थानीयकरण प्रमाण में आपका स्वागत है।",
};

export class MockDubbingProvider implements DubbingProvider {
  public readonly kind = "mock" as const;
  private readonly projects = new Map<string, MockProjectState>();
  private readonly targets = new Map<string, MockTargetState>();

  public constructor(private readonly createAudio: MockAudioFactory) {}

  public createProject(
    inputPath: string,
    sourceLanguage: Language,
    reference: string,
  ): Promise<ProviderProject> {
    void reference;
    const id = `mock-project-${randomUUID()}`;
    this.projects.set(id, { inputPath, sourceLanguage, reads: 0 });
    return Promise.resolve({ id, status: "queued", warnings: [] });
  }

  public getProject(projectId: string): Promise<ProviderProject> {
    const project = this.requireProject(projectId);
    project.reads += 1;
    const status = project.reads === 1 ? "preparing" : "ready";
    return Promise.resolve({ id: projectId, status, warnings: [] });
  }

  public createLanguageTarget(
    projectId: string,
    targetLanguage: Language,
  ): Promise<ProviderTarget> {
    this.requireProject(projectId);
    const id = `mock-language-${randomUUID()}`;
    this.targets.set(id, { projectId, targetLanguage, reads: 0 });
    return Promise.resolve({
      id,
      projectId,
      targetLanguage,
      status: "queued",
      warnings: [],
      hasLosslessAudio: false,
    });
  }

  public getLanguageTarget(projectId: string, languageId: string): Promise<ProviderTarget> {
    const target = this.requireTarget(projectId, languageId);
    target.reads += 1;
    const status = target.reads === 1 ? "processing" : "completed";
    return Promise.resolve({
      id: languageId,
      projectId,
      targetLanguage: target.targetLanguage,
      status,
      warnings: [],
      hasLosslessAudio: status === "completed",
    });
  }

  public getTargetTranscript(projectId: string, languageId: string): Promise<TargetTranscript> {
    const target = this.requireTarget(projectId, languageId);
    const project = this.requireProject(projectId);
    return Promise.resolve({
      sourceLanguage: project.sourceLanguage,
      targetLanguage: target.targetLanguage,
      revision: 1,
      segments: [
        {
          id: "mock-segment-1",
          speakerId: "mock-speaker-1",
          startSeconds: 0.25,
          endSeconds: 2.75,
          sourceText: "Welcome to the AI video localization proof of concept.",
          translation: TRANSLATIONS[target.targetLanguage],
        },
      ],
    });
  }

  public async downloadLosslessAudio(
    projectId: string,
    languageId: string,
    outputPath: string,
  ): Promise<void> {
    const target = this.requireTarget(projectId, languageId);
    if (target.reads < 2) {
      throw new PocError("MOCK_TARGET_NOT_READY", "Mock language target is not complete");
    }
    const project = this.requireProject(projectId);
    await this.createAudio(project.inputPath, outputPath);
  }

  public deleteProject(projectId: string): Promise<void> {
    this.requireProject(projectId);
    this.projects.delete(projectId);
    for (const [languageId, target] of this.targets) {
      if (target.projectId === projectId) this.targets.delete(languageId);
    }
    return Promise.resolve();
  }

  public restoreProject(input: RestoreProjectInput): void {
    this.projects.set(input.projectId, {
      inputPath: input.inputPath,
      sourceLanguage: input.sourceLanguage,
      reads: 2,
    });
    for (const target of input.targets) {
      this.targets.set(target.languageId, {
        projectId: input.projectId,
        targetLanguage: target.targetLanguage,
        reads: 2,
      });
    }
  }

  private requireProject(projectId: string): MockProjectState {
    const project = this.projects.get(projectId);
    if (!project) throw new PocError("MOCK_PROJECT_NOT_FOUND", `Unknown mock project: ${projectId}`);
    return project;
  }

  private requireTarget(projectId: string, languageId: string): MockTargetState {
    const target = this.targets.get(languageId);
    if (!target || target.projectId !== projectId) {
      throw new PocError("MOCK_TARGET_NOT_FOUND", `Unknown mock language target: ${languageId}`);
    }
    return target;
  }
}
