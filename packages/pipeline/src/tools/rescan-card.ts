#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { CardSchema, SetCodeSchema, SetSchema, type Card, type ReviewQueueItem, type SetCode, type SetRecord } from "@dbzccg/schema";
import {
  DEFAULT_OUTPUT_CARDS,
  DEFAULT_OUTPUT_REVIEW,
  DEFAULT_OUTPUT_SETS,
  DEFAULT_PARSE_MODEL,
  DEFAULT_RULEBOOK_LEXICON,
  DEFAULT_RULEBOOK_PDF,
  DEFAULT_RULEBOOK_TEXT,
  SET_DEFINITIONS
} from "../constants.js";
import { writeJsonFile } from "../io/write-json.js";
import { loadRepoEnvLocal } from "../io/load-env-local.js";
import { parseCardWithLlm } from "../llm/parse-card.js";
import { inferFilenamePriors } from "../normalize/filename-priors.js";
import { normalizeCardCandidate } from "../normalize/enrich-with-rulebook.js";
import { runOcr } from "../ocr/run-ocr.js";
import {
  createReprintReuseState,
  registerAcceptedCardForReuse,
  registerReviewItemForReuse,
  tryReuseReprint
} from "../reprints/reprint-reuse.js";
import { loadRulebookLexicon } from "../rulebook/lexicon.js";
import { findRepoRoot, resolveRepoPath } from "../io/repo-paths.js";
import { validateCardCandidate } from "../validate/validate-card.js";

interface RescanOptions {
  imagePath: string;
  setCode: SetCode;
  setName: string;
  cardsPath: string;
  reviewQueuePath: string;
  setsPath: string;
  minConfidence: number;
  model: string;
  rulebookPdfPath: string;
  rulebookLexiconPath: string;
  rulebookTextPath: string;
  reuseReprints: boolean;
}

interface RescanSummary {
  status: "accepted" | "review";
  cardId: string;
  setCode: SetCode;
  imagePath: string;
}

async function main(): Promise<void> {
  loadRepoEnvLocal();

  const flags = parseFlags(process.argv.slice(2));
  const imagePathFlag = getStringFlag(flags, "--image");
  if (!imagePathFlag) {
    throw new Error("Missing required --image <path>.");
  }

  const cwd = process.cwd();
  const repoRoot = findRepoRoot(cwd);
  const imagePath = resolveUserPath(imagePathFlag, cwd, repoRoot);
  const inferredSetCode = inferSetCodeFromImagePath(imagePath);
  const explicitSet = getStringFlag(flags, "--set");
  const parsedSet = explicitSet ? SetCodeSchema.safeParse(explicitSet.toUpperCase()) : null;
  if (explicitSet && (!parsedSet || !parsedSet.success)) {
    throw new Error(`Invalid --set value: ${explicitSet}`);
  }
  const setCode = parsedSet?.success ? parsedSet.data : inferredSetCode;
  if (!setCode) {
    throw new Error("Unable to infer set code from image path. Pass --set <AWA|EVO|HNV|MOV|PER|PRE|VEN>.");
  }
  const setName = getStringFlag(flags, "--set-name") ?? SET_DEFINITIONS[setCode].name;

  const options: RescanOptions = {
    imagePath,
    setCode,
    setName,
    cardsPath: resolveFlagPath(flags, "--cards", DEFAULT_OUTPUT_CARDS, cwd, repoRoot),
    reviewQueuePath: resolveFlagPath(flags, "--review-queue", DEFAULT_OUTPUT_REVIEW, cwd, repoRoot),
    setsPath: resolveFlagPath(flags, "--sets", DEFAULT_OUTPUT_SETS, cwd, repoRoot),
    minConfidence: getNumberFlag(flags, "--min-confidence", 0.9),
    model: getStringFlag(flags, "--model") ?? DEFAULT_PARSE_MODEL,
    rulebookPdfPath: resolveFlagPath(flags, "--rulebook-pdf", DEFAULT_RULEBOOK_PDF, cwd, repoRoot),
    rulebookLexiconPath: resolveFlagPath(flags, "--rulebook-lexicon", DEFAULT_RULEBOOK_LEXICON, cwd, repoRoot),
    rulebookTextPath: resolveFlagPath(flags, "--rulebook-text", DEFAULT_RULEBOOK_TEXT, cwd, repoRoot),
    reuseReprints: !getBooleanFlag(flags, "--no-reprint-reuse")
  };

  const summary = await rescanCard(options);
  console.log(`[rescan] status=${summary.status} cardId=${summary.cardId} set=${summary.setCode}`);
}

async function rescanCard(options: RescanOptions): Promise<RescanSummary> {
  const imageFileName = path.basename(options.imagePath);
  const priors = inferFilenamePriors(imageFileName);
  const cards = await readCards(options.cardsPath);
  const reviewQueue = await readReviewQueue(options.reviewQueuePath);

  if (options.reuseReprints) {
    const reuseState = createReprintReuseState({
      cards,
      reviewQueue
    });
    const reused = tryReuseReprint({
      state: reuseState,
      image: {
        setCode: options.setCode,
        setName: options.setName,
        imagePath: options.imagePath,
        imageFileName
      },
      priors
    });

    if (reused?.kind === "accepted") {
      const nextCards = upsertCard(cards, reused.card);
      const nextReviewQueue = reviewQueue.filter(
        (item) => !(item.cardId === reused.card.id || normalizePath(item.imagePath) === normalizePath(options.imagePath))
      );
      const nextSets = await upsertSetRecord({
        setsPath: options.setsPath,
        cards: nextCards,
        reviewQueue: nextReviewQueue,
        setCode: options.setCode,
        parseModel: `${options.model.length > 0 ? options.model : "codex-default"}+reprint-reuse`,
        minConfidence: options.minConfidence
      });

      await Promise.all([
        writeJsonFile(options.cardsPath, nextCards),
        writeJsonFile(options.reviewQueuePath, nextReviewQueue),
        writeJsonFile(options.setsPath, nextSets)
      ]);

      return {
        status: "accepted",
        cardId: reused.card.id,
        setCode: options.setCode,
        imagePath: options.imagePath
      };
    }

    if (reused?.kind === "review") {
      const nextReviewQueue = upsertReviewQueueItem(reviewQueue, reused.reviewItem);
      const nextSets = await upsertSetRecord({
        setsPath: options.setsPath,
        cards,
        reviewQueue: nextReviewQueue,
        setCode: options.setCode,
        parseModel: `${options.model.length > 0 ? options.model : "codex-default"}+reprint-reuse`,
        minConfidence: options.minConfidence
      });

      await Promise.all([writeJsonFile(options.reviewQueuePath, nextReviewQueue), writeJsonFile(options.setsPath, nextSets)]);

      return {
        status: "review",
        cardId: reused.reviewItem.cardId,
        setCode: options.setCode,
        imagePath: options.imagePath
      };
    }
  }

  const lexicon = await loadRulebookLexicon({
    pdfPath: options.rulebookPdfPath,
    lexiconPath: options.rulebookLexiconPath,
    textPath: options.rulebookTextPath
  });

  const ocrResult = await runOcr(options.imagePath);
  const llmResult = await parseCardWithLlm({
    image: {
      setCode: options.setCode,
      setName: options.setName,
      imagePath: options.imagePath,
      imageFileName
    },
    priors,
    ocr: ocrResult,
    lexicon,
    model: options.model
  });

  const normalizedCandidate = normalizeCardCandidate({
    image: {
      setCode: options.setCode,
      setName: options.setName,
      imagePath: options.imagePath,
      imageFileName
    },
    priors,
    ocr: ocrResult,
    llmData: llmResult.data,
    llmUsed: llmResult.llmUsed,
    llmRawJson: llmResult.rawJson,
    warnings: llmResult.warnings,
    lexicon
  });

  const validation = validateCardCandidate(normalizedCandidate, { minConfidence: options.minConfidence });

  if (validation.accepted && validation.card) {
    const acceptedCard = validation.card;
    const nextCards = upsertCard(cards, acceptedCard);
    const nextReviewQueue = reviewQueue.filter(
      (item) => !(item.cardId === acceptedCard.id || normalizePath(item.imagePath) === normalizePath(options.imagePath))
    );
    const nextSets = await upsertSetRecord({
      setsPath: options.setsPath,
      cards: nextCards,
      reviewQueue: nextReviewQueue,
      setCode: options.setCode,
      parseModel: options.model.length > 0 ? options.model : "codex-default",
      minConfidence: options.minConfidence
    });

    await Promise.all([
      writeJsonFile(options.cardsPath, nextCards),
      writeJsonFile(options.reviewQueuePath, nextReviewQueue),
      writeJsonFile(options.setsPath, nextSets)
    ]);

    return {
      status: "accepted",
      cardId: acceptedCard.id,
      setCode: options.setCode,
      imagePath: options.imagePath
    };
  }

  if (!validation.reviewItem) {
    throw new Error("Unexpected validation outcome: missing both accepted card and review item.");
  }

  const nextReviewQueue = upsertReviewQueueItem(reviewQueue, validation.reviewItem);
  const nextSets = await upsertSetRecord({
    setsPath: options.setsPath,
    cards,
    reviewQueue: nextReviewQueue,
    setCode: options.setCode,
    parseModel: options.model.length > 0 ? options.model : "codex-default",
    minConfidence: options.minConfidence
  });

  await Promise.all([writeJsonFile(options.reviewQueuePath, nextReviewQueue), writeJsonFile(options.setsPath, nextSets)]);

  return {
    status: "review",
    cardId: validation.reviewItem.cardId,
    setCode: options.setCode,
    imagePath: options.imagePath
  };
}

async function readCards(cardsPath: string): Promise<Card[]> {
  const value = await readJsonArray(cardsPath);
  const cards: Card[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = CardSchema.safeParse(sanitizeCardRecord(stripLegacyPowerStages(entry), index));
    if (!parsed.success) {
      throw new Error(
        `Invalid cards file (${cardsPath}) at index ${index}: ${parsed.error.issues[0]?.path.join(".") ?? "<root>"} ${parsed.error.issues[0]?.message ?? "unknown error"}`
      );
    }
    cards.push(parsed.data);
  }
  return cards;
}

async function readReviewQueue(reviewQueuePath: string): Promise<ReviewQueueItem[]> {
  const value = await readJsonArray(reviewQueuePath);
  return value as ReviewQueueItem[];
}

async function readSetRecords(setsPath: string): Promise<SetRecord[]> {
  const value = await readJsonArray(setsPath);
  const sets: SetRecord[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = SetSchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error(`Invalid sets file (${setsPath}) at index ${index}: ${parsed.error.issues[0]?.message ?? "unknown error"}`);
    }
    sets.push(parsed.data);
  }
  return sets;
}

async function readJsonArray(filePath: string): Promise<unknown[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected array in ${filePath}`);
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function upsertCard(cards: Card[], card: Card): Card[] {
  const next = [...cards];
  const index = next.findIndex((entry) => entry.id === card.id);
  if (index >= 0) {
    next[index] = card;
  } else {
    next.push(card);
  }
  next.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" }));
  return next;
}

function upsertReviewQueueItem(queue: ReviewQueueItem[], item: ReviewQueueItem): ReviewQueueItem[] {
  const normalizedImagePath = normalizePath(item.imagePath);
  const next = queue.filter(
    (entry) => !(entry.cardId === item.cardId && normalizePath(entry.imagePath) === normalizedImagePath)
  );
  next.push(item);
  next.sort((left, right) => left.cardId.localeCompare(right.cardId, undefined, { numeric: true, sensitivity: "base" }));
  return next;
}

async function upsertSetRecord(input: {
  setsPath: string;
  cards: Card[];
  reviewQueue: ReviewQueueItem[];
  setCode: SetCode;
  parseModel: string;
  minConfidence: number;
}): Promise<SetRecord[]> {
  const sets = await readSetRecords(input.setsPath);
  const next = [...sets];
  const definition = SET_DEFINITIONS[input.setCode];
  const acceptedCards = input.cards.filter((card) => card.setCode === input.setCode).length;
  const reviewCards = input.reviewQueue.filter((item) => item.setCode === input.setCode).length;
  const now = new Date().toISOString();

  const index = next.findIndex((entry) => entry.setCode === input.setCode);
  const current = index >= 0 ? next[index] : null;
  const nextRecord = SetSchema.parse({
    setCode: input.setCode,
    setName: definition.name,
    cardCountExpected: current?.cardCountExpected ?? null,
    cardCountParsed: acceptedCards,
    sourceFolders: current?.sourceFolders ?? [definition.folderName],
    parseRunMetadata: {
      startedAt: current?.parseRunMetadata.startedAt ?? now,
      finishedAt: now,
      acceptedCards,
      reviewCards,
      parseModel: input.parseModel,
      minConfidence: input.minConfidence
    }
  });

  if (index >= 0) {
    next[index] = nextRecord;
  } else {
    next.push(nextRecord);
  }
  next.sort((left, right) => left.setCode.localeCompare(right.setCode));
  return next;
}

function inferSetCodeFromImagePath(imagePath: string): SetCode | null {
  const normalized = normalizePath(imagePath);
  for (const [setCode, definition] of Object.entries(SET_DEFINITIONS) as Array<[SetCode, (typeof SET_DEFINITIONS)[SetCode]]>) {
    const token = normalizePath(path.join("packages", "data", "raw", "images", definition.folderName));
    if (normalized.includes(token)) {
      return setCode;
    }
  }
  return null;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function parseFlags(args: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(token, true);
      continue;
    }
    flags.set(token, next);
    index += 1;
  }
  return flags;
}

function getStringFlag(flags: Map<string, string | boolean>, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function getBooleanFlag(flags: Map<string, string | boolean>, key: string): boolean {
  return flags.get(key) === true;
}

function getNumberFlag(flags: Map<string, string | boolean>, key: string, fallback: number): number {
  const value = getStringFlag(flags, key);
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${key} must be a number between 0 and 1`);
  }
  return parsed;
}

function resolveUserPath(value: string, cwd: string, repoRoot: string): string {
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }
  const fromCwd = path.resolve(cwd, value);
  if (existsSync(fromCwd)) {
    return fromCwd;
  }
  const fromRepoRoot = path.resolve(repoRoot, value);
  if (existsSync(fromRepoRoot)) {
    return fromRepoRoot;
  }
  return fromRepoRoot;
}

function stripLegacyPowerStages(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const next = { ...(value as Record<string, unknown>) };
  if ("powerStages" in next) {
    delete next.powerStages;
  }
  const confidence = next.confidence;
  if (confidence && typeof confidence === "object" && !Array.isArray(confidence)) {
    const fields = (confidence as Record<string, unknown>).fields;
    if (fields && typeof fields === "object" && !Array.isArray(fields) && "powerStages" in fields) {
      const nextFields = { ...(fields as Record<string, unknown>) };
      delete nextFields.powerStages;
      next.confidence = {
        ...(confidence as Record<string, unknown>),
        fields: nextFields
      };
    }
  }
  return next;
}

function sanitizeCardRecord(value: unknown, index: number): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const next = { ...(value as Record<string, unknown>) };
  const cardTextRaw = asNonEmptyString(next.cardTextRaw);
  if (!cardTextRaw) {
    next.cardTextRaw =
      asNonEmptyString(next.mainPowerText) ??
      asNonEmptyString(next.name) ??
      asNonEmptyString((next.source as Record<string, unknown> | undefined)?.imageFileName) ??
      asNonEmptyString(next.id) ??
      `recovered-card-text-${index}`;
  }

  const source = next.source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const sourceRecord = { ...(source as Record<string, unknown>) };
    const imagePath = asNonEmptyString(sourceRecord.imagePath);
    const imageFileName = asNonEmptyString(sourceRecord.imageFileName);
    if (!imageFileName && imagePath) {
      sourceRecord.imageFileName = path.basename(imagePath);
    }
    next.source = sourceRecord;
  }

  const raw = next.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const rawRecord = { ...(raw as Record<string, unknown>) };
    if (!Array.isArray(rawRecord.warnings)) {
      rawRecord.warnings = [];
    }
    if (!Array.isArray(rawRecord.ocrBlocks)) {
      rawRecord.ocrBlocks = [];
    }
    if (typeof rawRecord.ocrText !== "string") {
      rawRecord.ocrText = "";
    }
    next.raw = rawRecord;
  }

  return next;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
    return resolveUserPath(explicitValue, cwd, repoRoot);
  }
  return resolveRepoPath(defaultValue);
}

void main().catch((error) => {
  console.error(`[rescan] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
