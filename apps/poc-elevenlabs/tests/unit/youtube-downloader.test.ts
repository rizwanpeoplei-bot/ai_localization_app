import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildYtDlpArgs,
  downloadYoutubeVideo,
  isYoutubeVideoUrl,
} from "../../src/youtube-downloader.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("YouTube video ingestion", () => {
  it("recognizes only allowlisted single-video URL shapes", () => {
    expect(isYoutubeVideoUrl("https://www.youtube.com/shorts/zl0ttsLz9k8")).toBe(true);
    expect(isYoutubeVideoUrl("https://youtu.be/zl0ttsLz9k8")).toBe(true);
    expect(isYoutubeVideoUrl("https://www.youtube.com/watch?v=zl0ttsLz9k8")).toBe(true);
    expect(isYoutubeVideoUrl("https://www.youtube.com/playlist?list=PL123456")).toBe(false);
    expect(isYoutubeVideoUrl("https://youtube.com.evil.example/watch?v=zl0ttsLz9k8")).toBe(false);
    expect(isYoutubeVideoUrl("https://user:pass@youtube.com/watch?v=zl0ttsLz9k8")).toBe(false);
  });

  it("builds a fixed non-playlist command with Node JavaScript support", () => {
    const url = "https://www.youtube.com/shorts/zl0ttsLz9k8";
    const args = buildYtDlpArgs(url, "/tmp/source.%(ext)s", 1_024);
    expect(args).toContain("--no-playlist");
    expect(args).toContain("--no-config");
    expect(args.slice(args.indexOf("--js-runtimes"), args.indexOf("--js-runtimes") + 2)).toEqual([
      "--js-runtimes",
      "node",
    ]);
    expect(args.at(-1)).toBe(url);
  });

  it("moves one size-checked MP4 into place atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ailocalization-youtube-"));
    directories.push(directory);
    const destination = join(directory, "result", "source.mp4");
    await mkdir(dirname(destination), { recursive: true });
    const payload = Buffer.from("synthetic mp4");

    await downloadYoutubeVideo(
      "https://www.youtube.com/shorts/zl0ttsLz9k8",
      destination,
      { maxBytes: 1_024, timeoutMs: 1_000, ytDlpPath: "fake-yt-dlp" },
      {
        runCommand: async (command, args) => {
          expect(command).toBe("fake-yt-dlp");
          const template = args[args.indexOf("--output") + 1]!;
          await writeFile(template.replace("%(ext)s", "mp4"), payload);
        },
      },
    );

    expect(await readFile(destination)).toEqual(payload);
  });

  it("does not expose downloader diagnostics in a generic failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ailocalization-youtube-"));
    directories.push(directory);
    await expect(
      downloadYoutubeVideo(
        "https://youtu.be/zl0ttsLz9k8?token=secret-value",
        join(directory, "source.mp4"),
        { maxBytes: 1_024, timeoutMs: 1_000 },
        { runCommand: () => Promise.reject(new Error("server rejected token=secret-value")) },
      ),
    ).rejects.toMatchObject({ code: "YOUTUBE_DOWNLOAD_FAILED", message: "Unable to download this YouTube video" });
  });
});
