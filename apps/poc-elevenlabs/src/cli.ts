#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import process from "node:process";
import { Command } from "commander";
import { validateInputFile, validateOutputRoot } from "./config.js";
import {
  LanguageSchema,
  MatrixConfigSchema,
  ProviderKindSchema,
} from "./domain.js";
import { PocError, sanitizeMessage } from "./errors.js";
import { readJson } from "./files.js";
import { RunManifestStore } from "./manifest.js";
import type { SourceRunInput } from "./orchestrator.js";
import { createRuntime, loadLocalEnvironment, requireLiveConfirmation } from "./runtime.js";

interface ProviderOptions {
  provider: string;
  confirmBillable?: boolean;
}

interface RunOptions extends ProviderOptions {
  input: string;
  sourceLanguage: string;
  targetLanguage: string;
  output: string;
}

interface MatrixOptions extends ProviderOptions {
  config: string;
  output: string;
}

interface ResumeOptions {
  manifest: string;
  confirmBillable?: boolean;
}

function providerOption(command: Command): Command {
  return command
    .option("--provider <provider>", "mock or elevenlabs", "mock")
    .option("--confirm-billable", "confirm that live provider calls may incur charges");
}

async function runSingle(options: RunOptions): Promise<void> {
  const providerKind = ProviderKindSchema.parse(options.provider);
  requireLiveConfirmation(providerKind, options.confirmBillable);
  const sourceLanguage = LanguageSchema.parse(options.sourceLanguage);
  const targetLanguage = LanguageSchema.parse(options.targetLanguage);
  const inputPath = await validateInputFile(options.input);
  const outputRoot = validateOutputRoot(options.output);
  const runtime = await createRuntime(providerKind, true);
  const { manifest, store } = await runtime.orchestrator.createRun(outputRoot, providerKind, [
    {
      id: `${sourceLanguage}-source`,
      inputPath,
      sourceLanguage,
      targets: [targetLanguage],
    },
  ]);
  await runtime.orchestrator.execute(manifest, store);
  process.stdout.write(`${store.path}\n`);
}

async function runMatrix(options: MatrixOptions): Promise<void> {
  const providerKind = ProviderKindSchema.parse(options.provider);
  requireLiveConfirmation(providerKind, options.confirmBillable);
  const configPath = resolve(options.config);
  const matrix = MatrixConfigSchema.parse(await readJson(configPath));
  const configDirectory = dirname(configPath);
  const sources: SourceRunInput[] = [];
  for (const source of matrix.sources) {
    sources.push({
      id: source.id,
      inputPath: await validateInputFile(resolve(configDirectory, source.input)),
      sourceLanguage: source.sourceLanguage,
      targets: source.targets,
    });
  }
  const outputRoot = validateOutputRoot(options.output);
  const runtime = await createRuntime(providerKind, true);
  const { manifest, store } = await runtime.orchestrator.createRun(outputRoot, providerKind, sources);
  await runtime.orchestrator.execute(manifest, store);
  process.stdout.write(`${store.path}\n`);
}

async function resumeRun(options: ResumeOptions): Promise<void> {
  const loaded = await RunManifestStore.load(options.manifest);
  requireLiveConfirmation(loaded.manifest.provider, options.confirmBillable);
  const runtime = await createRuntime(loaded.manifest.provider, true);
  await runtime.orchestrator.execute(loaded.manifest, loaded.store);
  process.stdout.write(`${loaded.store.path}\n`);
}

async function cleanupRun(options: ResumeOptions): Promise<void> {
  const loaded = await RunManifestStore.load(options.manifest);
  const runtime = await createRuntime(loaded.manifest.provider, false);
  await runtime.orchestrator.cleanup(loaded.manifest, loaded.store);
  process.stdout.write(`${loaded.store.path}\n`);
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const program = new Command().name("poc").description("ElevenLabs Dubbing v2 localization POC");

  providerOption(
    program
      .command("run")
      .requiredOption("--input <mp4>")
      .requiredOption("--source-language <language>")
      .requiredOption("--target-language <language>")
      .requiredOption("--output <directory>"),
  ).action(runSingle);

  providerOption(
    program
      .command("matrix")
      .requiredOption("--config <matrix.json>")
      .requiredOption("--output <directory>"),
  ).action(runMatrix);

  program
    .command("resume")
    .requiredOption("--manifest <manifest.json>")
    .option("--confirm-billable", "confirm that live provider calls may incur charges")
    .action(resumeRun);

  program
    .command("cleanup")
    .requiredOption("--manifest <manifest.json>")
    .action(cleanupRun);

  await program.parseAsync(process.argv);
}

try {
  await main();
} catch (error) {
  const code = error instanceof PocError ? error.code : "POC_FAILED";
  process.stderr.write(`${JSON.stringify({ level: "error", code, message: sanitizeMessage(error) })}\n`);
  process.exitCode = 1;
}
