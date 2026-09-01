import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import type { ProviderKind } from "./domain.js";
import { PocError } from "./errors.js";
import { loadConfig } from "./config.js";
import { JsonLogger, type Logger } from "./logger.js";
import { MediaService } from "./media.js";
import { PocOrchestrator } from "./orchestrator.js";
import { ElevenLabsDubbingProvider } from "./providers/elevenlabs-provider.js";
import { MockDubbingProvider } from "./providers/mock-provider.js";
import type { DubbingProvider } from "./providers/provider.js";

export function loadLocalEnvironment(): void {
  const localEnvironment = resolve(".env.local");
  if (existsSync(localEnvironment)) process.loadEnvFile(localEnvironment);
}

export function requireLiveConfirmation(provider: ProviderKind, confirmed: boolean | undefined): void {
  if (provider === "elevenlabs" && confirmed !== true) {
    throw new PocError(
      "BILLABLE_CONFIRMATION_REQUIRED",
      "Live execution may incur charges; explicitly confirm billable execution",
    );
  }
}

export async function createRuntime(
  providerKind: ProviderKind,
  preflight: boolean,
  logger: Logger = new JsonLogger(),
): Promise<{
  provider: DubbingProvider;
  media: MediaService;
  orchestrator: PocOrchestrator;
}> {
  const config = loadConfig(providerKind);
  const media = new MediaService({
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    fontDirectory: config.subtitleFontDirectory,
    timeoutMs: config.operationTimeoutMs,
  });
  if (preflight) await media.preflight();
  const provider: DubbingProvider =
    providerKind === "mock"
      ? new MockDubbingProvider((input, output) => media.createMockLosslessAudio(input, output))
      : new ElevenLabsDubbingProvider({
          apiKey: config.elevenLabsApiKey ?? "",
          baseUrl: config.elevenLabsBaseUrl,
          timeoutMs: config.operationTimeoutMs,
        });
  return {
    provider,
    media,
    orchestrator: new PocOrchestrator(provider, media, logger, {
      pollInitialMs: config.pollInitialMs,
      pollMaxMs: config.pollMaxMs,
      operationTimeoutMs: config.operationTimeoutMs,
    }),
  };
}
