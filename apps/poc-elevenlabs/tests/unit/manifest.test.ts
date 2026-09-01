import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunManifestStore, type RunManifest } from "../../src/manifest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("RunManifestStore", () => {
  it("writes and reloads a valid manifest atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ailocalization-manifest-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "manifest.json");
    const timestamp = new Date().toISOString();
    const manifest: RunManifest = {
      version: 1,
      runId: "test-run",
      provider: "mock",
      status: "running",
      outputRoot: directory,
      createdAt: timestamp,
      updatedAt: timestamp,
      sources: [],
    };
    const store = new RunManifestStore(path);
    await store.save(manifest);
    const loaded = await RunManifestStore.load(path);
    expect(loaded.manifest.runId).toBe("test-run");
    expect(loaded.store.path).toBe(path);
  });
});
