#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { SetCodeSchema } from "@dbzccg/schema";
import {
  ALL_SET_CODES,
  DEFAULT_IMAGES_ROOT,
  DEFAULT_OUTPUT_CARDS,
  DEFAULT_OUTPUT_REVIEW,
  DEFAULT_OUTPUT_SETS,
  DEFAULT_PARSE_MODEL,
  DEFAULT_RULEBOOK_ICON_PAGE_IMAGE,
  DEFAULT_RULEBOOK_ICON_ASSETS_DIR,
  DEFAULT_RULEBOOK_ICON_PAGE_NUMBER,
  DEFAULT_RULEBOOK_ICON_REFERENCE,
  DEFAULT_RULEBOOK_LEXICON,
  DEFAULT_RULEBOOK_PDF,
  DEFAULT_RULEBOOK_TEXT
} from "./constants.js";
import { buildDatabase } from "./build/build-db.js";
import { loadRepoEnvLocal } from "./io/load-env-local.js";
import { extractRulebookArtifacts } from "./rulebook/extract-rulebook.js";

async function main(): Promise<void> {
  loadRepoEnvLocal();

  const [command, ...args] = process.argv.slice(2);
  const flags = parseFlags(args);
  const cwd = process.cwd();
  const repoRoot = findRepoRoot(cwd);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "extract-rulebook") {
    const pdfPath = resolveFlagPath(flags, "--pdf", DEFAULT_RULEBOOK_PDF, cwd, repoRoot);
    const textPath = resolveFlagPath(flags, "--out-text", DEFAULT_RULEBOOK_TEXT, cwd, repoRoot);
    const lexiconPath = resolveFlagPath(flags, "--out-lexicon", DEFAULT_RULEBOOK_LEXICON, cwd, repoRoot);
    const iconReferencePath = resolveFlagPath(flags, "--out-icons", DEFAULT_RULEBOOK_ICON_REFERENCE, cwd, repoRoot);
    const iconPageImagePath = resolveFlagPath(
      flags,
      "--out-icons-page-image",
      DEFAULT_RULEBOOK_ICON_PAGE_IMAGE,
      cwd,
      repoRoot
    );
    const iconAssetsDir = resolveFlagPath(
      flags,
      "--out-icon-assets-dir",
      DEFAULT_RULEBOOK_ICON_ASSETS_DIR,
      cwd,
      repoRoot
    );
    const iconPageNumber = getIntFlag(flags, "--icons-page", DEFAULT_RULEBOOK_ICON_PAGE_NUMBER);

    const lexicon = await extractRulebookArtifacts({
      pdfPath,
      outputTextPath: textPath,
      outputLexiconPath: lexiconPath,
      outputIconReferencePath: iconReferencePath,
      outputIconPageImagePath: iconPageImagePath,
      outputIconAssetsDir: iconAssetsDir,
      iconPageNumber
    });

    console.log(`Rulebook text: ${textPath}`);
    console.log(`Rulebook lexicon: ${lexiconPath}`);
    console.log(`Rulebook icon reference: ${iconReferencePath}`);
    console.log(`Rulebook icon page image: ${iconPageImagePath}`);
    console.log(`Rulebook icon assets: ${iconAssetsDir}`);
    console.log(`Card type terms: ${lexicon.cardTypes.length}`);
    console.log(`Keyword terms: ${lexicon.keywords.length}`);
    return;
  }

  if (command !== "build-set" && command !== "build-all") {
    throw new Error(`Unknown command: ${command}`);
  }

  const imagesRoot = resolveFlagPath(flags, "--images-root", DEFAULT_IMAGES_ROOT, cwd, repoRoot);
  const outCardsPath = resolveFlagPath(flags, "--out-cards", DEFAULT_OUTPUT_CARDS, cwd, repoRoot);
  const outSetsPath = resolveFlagPath(flags, "--out-sets", DEFAULT_OUTPUT_SETS, cwd, repoRoot);
  const outReviewPath = resolveFlagPath(flags, "--out-review", DEFAULT_OUTPUT_REVIEW, cwd, repoRoot);
  const rulebookPdfPath = resolveFlagPath(flags, "--rulebook-pdf", DEFAULT_RULEBOOK_PDF, cwd, repoRoot);
  const rulebookLexiconPath = resolveFlagPath(
    flags,
    "--rulebook-lexicon",
    DEFAULT_RULEBOOK_LEXICON,
    cwd,
    repoRoot
  );
  const rulebookTextPath = resolveFlagPath(flags, "--rulebook-text", DEFAULT_RULEBOOK_TEXT, cwd, repoRoot);

  const parseConcurrency = getIntFlag(flags, "--concurrency", 1);
  const maxCards = getOptionalIntFlag(flags, "--max-cards");
  const minConfidence = getNumberFlag(flags, "--min-confidence", 0.9);
  const model = getStringFlag(flags, "--model") ?? DEFAULT_PARSE_MODEL;
  const refreshRulebookLexicon = getBooleanFlag(flags, "--refresh-rulebook-lexicon");
  const reuseReprints = !getBooleanFlag(flags, "--no-reprint-reuse");

  const setCodes =
    command === "build-all"
      ? ALL_SET_CODES
      : (() => {
          const rawSet = getStringFlag(flags, "--set");
          if (!rawSet) {
            throw new Error("build-set requires --set <AWA|EVO|HNV|MOV|PER|PRE|VEN>");
          }
          const parsed = SetCodeSchema.safeParse(rawSet.toUpperCase());
          if (!parsed.success) {
            throw new Error(`Invalid --set value: ${rawSet}`);
          }
          return [parsed.data];
        })();

  console.log(`Starting parse for sets: ${setCodes.join(", ")}`);
  console.log(`Images root: ${imagesRoot}`);
  console.log(`Codex model: ${model.length > 0 ? model : "(codex config default)"}`);
  console.log(`Concurrency: ${parseConcurrency}`);
  console.log(`Min confidence: ${minConfidence}`);
  console.log(`Reprint reuse: ${reuseReprints ? "enabled" : "disabled"}`);

  const result = await buildDatabase({
    setCodes,
    imagesRoot,
    outCardsPath,
    outSetsPath,
    outReviewPath,
    maxCards,
    parseConcurrency,
    minConfidence,
    model,
    rulebookPdfPath,
    rulebookLexiconPath,
    rulebookTextPath,
    refreshRulebookLexicon,
    reuseReprints,
    onProgress: (message) => console.log(message)
  });

  console.log(`Run started: ${result.startedAt}`);
  console.log(`Run finished: ${result.finishedAt}`);
  console.log(`Accepted cards: ${result.cards.length}`);
  console.log(`Review queue: ${result.reviewQueue.length}`);
  console.log(`Cards output: ${outCardsPath}`);
  console.log(`Sets output: ${outSetsPath}`);
  console.log(`Review output: ${outReviewPath}`);

  for (const setRecord of result.sets) {
    console.log(
      `Set ${setRecord.setCode} (${setRecord.setName}) accepted=${setRecord.parseRunMetadata.acceptedCards} ` +
        `review=${setRecord.parseRunMetadata.reviewCards}`
    );
  }
}

function parseFlags(args: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") {
      continue;
    }
    if (!token.startsWith("--")) {
      continue;
    }

    const maybeValue = args[index + 1];
    if (!maybeValue || maybeValue.startsWith("--")) {
      flags.set(token, true);
      continue;
    }

    flags.set(token, maybeValue);
    index += 1;
  }

  return flags;
}

function getStringFlag(flags: Map<string, string | boolean>, key: string): string | undefined {
  const value = flags.get(key);
  if (typeof value !== "string") {
    return undefined;
  }
  return value;
}

function getBooleanFlag(flags: Map<string, string | boolean>, key: string): boolean {
  return flags.get(key) === true;
}

function getIntFlag(flags: Map<string, string | boolean>, key: string, fallback: number): number {
  const value = getStringFlag(flags, key);
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be an integer >= 1`);
  }
  return parsed;
}

function getOptionalIntFlag(flags: Map<string, string | boolean>, key: string): number | undefined {
  const value = getStringFlag(flags, key);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be an integer >= 1`);
  }
  return parsed;
}

function getNumberFlag(flags: Map<string, string | boolean>, key: string, fallback: number): number {
  const value = getStringFlag(flags, key);
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${key} must be a number between 0 and 1`);
  }

  return parsed;
}

function resolvePath(root: string, value: string): string {
  return path.resolve(root, value);
}

function resolveFlagPath(
  flags: Map<string, string | boolean>,
  key: string,
  defaultValue: string,
  cwd: string,
  repoRoot: string
): string {
  const explicitValue = getStringFlag(flags, key);
  if (explicitValue) {
    return resolvePath(cwd, explicitValue);
  }
  return resolvePath(repoRoot, defaultValue);
}

function findRepoRoot(startDirectory: string): string {
  let currentDir = path.resolve(startDirectory);

  while (true) {
    const pnpmWorkspacePath = path.join(currentDir, "pnpm-workspace.yaml");
    const gitDirectoryPath = path.join(currentDir, ".git");
    if (existsSync(pnpmWorkspacePath) || existsSync(gitDirectoryPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return startDirectory;
    }
    currentDir = parentDir;
  }
}

function printUsage(): void {
  console.log(`
Usage:
  pnpm --filter @dbzccg/pipeline run build:set -- --set HNV [options]
  pnpm --filter @dbzccg/pipeline run build:all [options]
  pnpm --filter @dbzccg/pipeline run extract:rulebook [options]

Commands:
  build-set                Parse one set (requires --set)
  build-all                Parse all known sets
  extract-rulebook         Extract text and lexicon from the rulebook PDF

Build options:
  --set <code>             AWA | EVO | HNV | MOV | PER | PRE | VEN
  --images-root <dir>      Default: packages/data/raw/images
  --out-cards <file>       Default: packages/data/data/cards.v1.json
  --out-sets <file>        Default: packages/data/data/sets.v1.json
  --out-review <file>      Default: packages/data/raw/review-queue.v1.json
  --max-cards <n>          Optional cap for test runs
  --concurrency <n>        Parse concurrency (default: 1)
  --min-confidence <0..1>  Review threshold (default: 0.9)
  --model <name>           Codex model (default: codex config default)
  --rulebook-pdf <file>    Default: packages/data/panini-rule-book-3-0.pdf
  --rulebook-lexicon <file>
  --rulebook-text <file>
  --refresh-rulebook-lexicon
  --no-reprint-reuse       Disable filename name/title reprint reuse

Rulebook extraction options:
  --pdf <file>
  --out-text <file>
  --out-lexicon <file>
  --out-icons <file>            Default: packages/data/raw/intermediate/rulebook-icons.v1.json
  --out-icons-page-image <file> Default: packages/data/raw/intermediate/rulebook-page-12.png
  --out-icon-assets-dir <dir>   Default: packages/data/raw/intermediate/rulebook-icons
  --icons-page <n>              Default: 12

Environment overrides:
  CODEX_MODEL            Default model when --model is omitted
  CODEX_COMMAND          Codex binary to execute (default: codex)
  CODEX_TIMEOUT_MS       Per-card timeout in ms (default: 120000)
  CODEX_PARSE_ATTEMPTS   Attempts per card before fallback (default: 2, max: 4)
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
