import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { ElevenLabsDubbingProvider } from "../../src/providers/elevenlabs-provider.js";

const baseUrl = "https://provider.test";
const date = "2026-09-01T00:00:00Z";
const server = setupServer(
  http.post(`${baseUrl}/v1/dubbing/project`, () =>
    HttpResponse.json(
      {
        project_id: "project-1",
        status: "queued",
        revision: 0,
        created_at: date,
        updated_at: date,
        source_language: "en",
        model_id: "dubbing_v2",
        language_ids: [],
        webhook_ids: [],
        warnings: [],
      },
      { status: 201 },
    ),
  ),
  http.get(`${baseUrl}/v1/dubbing/project/project-1`, () =>
    HttpResponse.json({
      project_id: "project-1",
      status: "ready",
      revision: 0,
      created_at: date,
      updated_at: date,
      source_language: "en",
      model_id: "dubbing_v2",
      language_ids: ["language-1"],
      webhook_ids: [],
      warnings: [],
    }),
  ),
  http.post(`${baseUrl}/v1/dubbing/project/project-1/language`, () =>
    HttpResponse.json(
      {
        language_id: "language-1",
        project_id: "project-1",
        target_language: "ur",
        status: "queued",
        revision: 0,
        created_at: date,
        updated_at: date,
        warnings: [],
      },
      { status: 201 },
    ),
  ),
  http.get(`${baseUrl}/v1/dubbing/project/project-1/language/language-1`, () =>
    HttpResponse.json({
      language_id: "language-1",
      project_id: "project-1",
      target_language: "ur",
      status: "completed",
      revision: 0,
      output_revision: 0,
      created_at: date,
      updated_at: date,
      outputs: {
        lossless_audio: `${baseUrl}/signed/audio.flac?X-Goog-Signature=secret`,
      },
      warnings: [],
    }),
  ),
  http.get(`${baseUrl}/v1/dubbing/project/project-1/language/language-1/transcript`, () =>
    HttpResponse.json({
      source_language: "en",
      target_language: "ur",
      revision: 0,
      segments: [
        {
          id: "segment-1",
          speaker_id: "speaker-1",
          start_s: 0,
          end_s: 1,
          source_text: "Welcome",
          translation: "خوش آمدید",
        },
      ],
    }),
  ),
  http.get(`${baseUrl}/signed/audio.flac`, () =>
    new HttpResponse(new Uint8Array([0x66, 0x4c, 0x61, 0x43]), {
      headers: { "content-type": "audio/flac" },
    }),
  ),
  http.delete(`${baseUrl}/v1/dubbing/project/project-1`, () => new HttpResponse(null, { status: 204 })),
);

const temporaryDirectories: string[] = [];

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(async () => {
  server.resetHandlers();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
afterAll(() => server.close());

describe("ElevenLabsDubbingProvider", () => {
  it("maps the current Dubbing v2 project, target, transcript, and signed audio contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ailocalization-provider-"));
    temporaryDirectories.push(directory);
    const input = join(directory, "input.mp4");
    const audio = join(directory, "audio.flac");
    await writeFile(input, "fixture");
    const provider = new ElevenLabsDubbingProvider({
      apiKey: "test-key",
      baseUrl,
      timeoutMs: 5_000,
      fetchImplementation: globalThis.fetch,
    });

    expect((await provider.createProject(input, "en", "test")).id).toBe("project-1");
    expect((await provider.getProject("project-1")).status).toBe("ready");
    expect((await provider.createLanguageTarget("project-1", "ur")).id).toBe("language-1");
    expect((await provider.getLanguageTarget("project-1", "language-1")).hasLosslessAudio).toBe(true);
    const transcript = await provider.getTargetTranscript("project-1", "language-1");
    expect(transcript.segments[0]?.translation).toBe("خوش آمدید");
    await provider.downloadLosslessAudio("project-1", "language-1", audio);
    expect(await readFile(audio)).toEqual(Buffer.from([0x66, 0x4c, 0x61, 0x43]));
    await expect(provider.deleteProject("project-1")).resolves.toBeUndefined();
  });
});
