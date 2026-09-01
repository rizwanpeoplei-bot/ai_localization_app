import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadPublicVideo } from "../../src/url-downloader.js";

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("public video download", () => {
  it("pins a validated address, follows a revalidated redirect, and writes atomically", async () => {
    const payload = Buffer.from("synthetic-mp4-payload");
    const server = createServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { Location: "/source.mp4" });
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": payload.length });
      response.end(payload);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const directory = await mkdtemp(join(tmpdir(), "ailocalization-download-"));
    directories.push(directory);
    const output = join(directory, "source.mp4");

    await downloadPublicVideo(
      `http://video.test:${String(port)}/start`,
      output,
      { maxBytes: 1_024, timeoutMs: 5_000 },
      { resolveAddress: () => Promise.resolve({ address: "127.0.0.1", family: 4 }) },
    );
    expect(await readFile(output)).toEqual(payload);
  });

  it("rejects a webpage response before it reaches FFprobe", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<html>not a video</html>");
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const directory = await mkdtemp(join(tmpdir(), "ailocalization-download-"));
    directories.push(directory);

    await expect(
      downloadPublicVideo(
        `http://video.test:${String(port)}/page`,
        join(directory, "source.mp4"),
        { maxBytes: 1_024, timeoutMs: 5_000 },
        { resolveAddress: () => Promise.resolve({ address: "127.0.0.1", family: 4 }) },
      ),
    ).rejects.toMatchObject({ code: "VIDEO_URL_NOT_MEDIA" });
  });
});
