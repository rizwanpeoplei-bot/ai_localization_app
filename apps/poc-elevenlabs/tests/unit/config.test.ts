import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, validateInputFile, validateOutputRoot } from "../../src/config.js";

describe("output path validation", () => {
  it("rejects broad destructive locations", () => {
    expect(() => validateOutputRoot("/")).toThrow(/unsafe/u);
    if (process.env.HOME) expect(() => validateOutputRoot(process.env.HOME as string)).toThrow(/unsafe/u);
  });

  it("accepts a scoped artifact directory", () => {
    expect(validateOutputRoot("./artifacts")).toMatch(/artifacts$/u);
  });

  it("treats an empty optional API key as unset for mock execution", () => {
    const previous = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "";
    try {
      expect(loadConfig("mock").elevenLabsApiKey).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = previous;
    }
  });

  it("rejects HTML or arbitrary content renamed to MP4", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ailocalization-input-"));
    const input = join(directory, "source.mp4");
    try {
      await writeFile(input, "<html>video page</html>");
      await expect(validateInputFile(input)).rejects.toMatchObject({ code: "INVALID_MP4_CONTENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
