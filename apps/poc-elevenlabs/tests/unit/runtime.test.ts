import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { loadLocalEnvironment } from "../../src/runtime.js";

describe("local environment loading", () => {
  it("loads .env and lets .env.local override it without replacing exported variables", async () => {
    const previousCwd = process.cwd();
    const previousBase = process.env.CODEX_TEST_BASE_ENV;
    const previousLocal = process.env.CODEX_TEST_LOCAL_ENV;
    const previousShell = process.env.CODEX_TEST_SHELL_ENV;
    const directory = await mkdtemp(join(tmpdir(), "ailocalization-env-"));
    try {
      await writeFile(join(directory, ".env"), [
        "CODEX_TEST_BASE_ENV=from-env",
        "CODEX_TEST_LOCAL_ENV=from-env",
        "CODEX_TEST_SHELL_ENV=from-env",
        "",
      ].join("\n"));
      await writeFile(join(directory, ".env.local"), [
        "CODEX_TEST_LOCAL_ENV=from-local",
        "CODEX_TEST_SHELL_ENV=from-local",
        "",
      ].join("\n"));
      process.env.CODEX_TEST_SHELL_ENV = "from-shell";
      process.chdir(directory);

      loadLocalEnvironment();

      expect(process.env.CODEX_TEST_BASE_ENV).toBe("from-env");
      expect(process.env.CODEX_TEST_LOCAL_ENV).toBe("from-local");
      expect(process.env.CODEX_TEST_SHELL_ENV).toBe("from-shell");
    } finally {
      process.chdir(previousCwd);
      if (previousBase === undefined) delete process.env.CODEX_TEST_BASE_ENV;
      else process.env.CODEX_TEST_BASE_ENV = previousBase;
      if (previousLocal === undefined) delete process.env.CODEX_TEST_LOCAL_ENV;
      else process.env.CODEX_TEST_LOCAL_ENV = previousLocal;
      if (previousShell === undefined) delete process.env.CODEX_TEST_SHELL_ENV;
      else process.env.CODEX_TEST_SHELL_ENV = previousShell;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
