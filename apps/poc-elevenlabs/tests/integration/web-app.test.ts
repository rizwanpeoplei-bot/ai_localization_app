import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createWebApp } from "../../src/web-server.js";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local web app", () => {
  it("serves the UI and validates submissions before queuing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ailocalization-web-"));
    temporaryDirectories.push(directory);
    const app = await createWebApp({
      host: "127.0.0.1",
      port: 0,
      artifactRoot: directory,
      maxVideoBytes: 10_000_000,
      maxLogoBytes: 1_000_000,
      downloadTimeoutMs: 5_000,
      ytDlpPath: "yt-dlp",
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${String(address.port)}`;

    const page = await fetch(baseUrl);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("AI Localization Studio");

    const form = new FormData();
    form.set("sourceLanguage", "en");
    form.set("targetLanguage", "ur");
    form.set("provider", "mock");
    form.set("subtitleMode", "burned");
    form.set("brightness", "0");
    form.set("volumePercent", "100");
    form.set("logoPosition", "bottom-right");
    form.set("logoSizePercent", "15");
    const response = await fetch(`${baseUrl}/api/jobs`, { method: "POST", body: form });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "VIDEO_INPUT_INVALID" });
  });

  it("requires a rights confirmation before queuing a YouTube import", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ailocalization-web-"));
    temporaryDirectories.push(directory);
    const app = await createWebApp({
      host: "127.0.0.1",
      port: 0,
      artifactRoot: directory,
      maxVideoBytes: 10_000_000,
      maxLogoBytes: 1_000_000,
      downloadTimeoutMs: 5_000,
      ytDlpPath: "yt-dlp",
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as AddressInfo;

    const form = new FormData();
    form.set("videoUrl", "https://www.youtube.com/shorts/zl0ttsLz9k8");
    form.set("sourceLanguage", "en");
    form.set("targetLanguage", "ur");
    form.set("provider", "mock");
    form.set("subtitleMode", "burned");
    form.set("brightness", "0");
    form.set("volumePercent", "100");
    form.set("logoPosition", "bottom-right");
    form.set("logoSizePercent", "15");
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/api/jobs`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "SOURCE_RIGHTS_CONFIRMATION_REQUIRED",
    });
  });
});
