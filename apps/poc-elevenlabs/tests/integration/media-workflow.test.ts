import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Logger } from "../../src/logger.js";
import { RunManifestStore } from "../../src/manifest.js";
import { MediaService, SUBTITLE_FONT_NAMES } from "../../src/media.js";
import { PocOrchestrator } from "../../src/orchestrator.js";
import { MockDubbingProvider } from "../../src/providers/mock-provider.js";

const fontDirectory = "/usr/share/fonts/truetype/noto";
const mediaAvailable =
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("test", ["-d", fontDirectory], { stdio: "ignore" }).status === 0;

const temporaryDirectories: string[] = [];
const silentLogger: Logger = { info: () => undefined, error: () => undefined };

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(!mediaAvailable)("mocked media workflow", () => {
  it("uses the container-compatible Urdu font with Arabic glyph support", () => {
    expect(SUBTITLE_FONT_NAMES.ur).toBe("Noto Naskh Arabic");
    expect(
      spawnSync("fc-match", [SUBTITLE_FONT_NAMES.ur], { encoding: "utf8" }).stdout,
    ).toContain("NotoNaskhArabic");
  });

  it("generates and resumes all six immutable pair artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ailocalization-media-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "source.mp4");
    const outputRoot = join(directory, "artifacts");
    const media = new MediaService({
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      fontDirectory,
      timeoutMs: 120_000,
    });
    await media.preflight();
    await media.generateSyntheticSource(sourcePath, 4);
    const provider = new MockDubbingProvider((input, output) => media.createMockLosslessAudio(input, output));
    const orchestrator = new PocOrchestrator(provider, media, silentLogger, {
      pollInitialMs: 0,
      pollMaxMs: 1,
      operationTimeoutMs: 30_000,
      sleep: () => Promise.resolve(),
    });
    const sources = [
      { id: "en-source", inputPath: sourcePath, sourceLanguage: "en" as const, targets: ["ur", "hi"] as const },
      { id: "ur-source", inputPath: sourcePath, sourceLanguage: "ur" as const, targets: ["en", "hi"] as const },
      { id: "hi-source", inputPath: sourcePath, sourceLanguage: "hi" as const, targets: ["en", "ur"] as const },
    ].map((source) => ({ ...source, targets: [...source.targets] }));
    const created = await orchestrator.createRun(outputRoot, "mock", sources);
    const completed = await orchestrator.execute(created.manifest, created.store);

    expect(completed.status).toBe("completed");
    const targets = completed.sources.flatMap((source) => source.targets);
    expect(targets).toHaveLength(6);
    for (const target of targets) {
      expect(target.status).toBe("completed");
      expect(target.stage).toBe("COMPLETED");
      for (const artifact of Object.values(target.artifacts)) {
        expect(artifact).toBeDefined();
        if (!artifact) continue;
        await expect(access(artifact.path)).resolves.toBeUndefined();
        expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
      }
    }

    const brandedTarget = targets[0]!;
    const logoPath = join(brandedTarget.artifactDirectory, "logo.png");
    expect(
      spawnSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=0xd8ff56:s=160x80",
          "-frames:v",
          "1",
          logoPath,
        ],
        { stdio: "ignore" },
      ).status,
    ).toBe(0);
    const finalPath = join(brandedTarget.artifactDirectory, "localized-final.mp4");
    await media.renderFinalVideo(
      brandedTarget.artifacts.localizedVideo!.path,
      brandedTarget.artifacts.subtitles!.path,
      finalPath,
      4,
      {
        brightness: 10,
        volumePercent: 120,
        subtitleMode: "burned",
        targetLanguage: brandedTarget.targetLanguage,
        logoPath,
        logoPosition: "bottom-right",
        logoSizePercent: 15,
      },
    );
    const finalProbe = await media.probe(finalPath);
    expect(finalProbe.streams.find((stream) => stream.codec_type === "video")?.codec_name).toBe("h264");
    expect(finalProbe.streams.find((stream) => stream.codec_type === "audio")?.codec_name).toBe("aac");

    const idsBeforeResume = targets.map((target) => target.languageId);
    const loaded = await RunManifestStore.load(created.store.path);
    const resumedProvider = new MockDubbingProvider((input, output) =>
      media.createMockLosslessAudio(input, output),
    );
    const resumedOrchestrator = new PocOrchestrator(resumedProvider, media, silentLogger, {
      pollInitialMs: 0,
      pollMaxMs: 1,
      operationTimeoutMs: 30_000,
      sleep: () => Promise.resolve(),
    });
    const resumed = await resumedOrchestrator.execute(loaded.manifest, loaded.store);
    expect(resumed.sources.flatMap((source) => source.targets).map((target) => target.languageId)).toEqual(
      idsBeforeResume,
    );
  }, 120_000);
});
