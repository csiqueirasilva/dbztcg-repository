#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CardSchema, type Card } from "@dbzccg/schema";
import { DEFAULT_PARSE_MODEL } from "../constants.js";
import { loadRepoEnvLocal } from "../io/load-env-local.js";
import { inferFilenamePriors } from "../normalize/filename-priors.js";
import { parseCardWithLlm } from "../llm/parse-card.js";
import { loadRulebookLexicon } from "../rulebook/lexicon.js";
import type { OcrResult } from "../types.js";

interface BackfillOptions {
  cardsPath: string;
  model: string;
  maxCards?: number;
  concurrency: number;
}

async function main(): Promise<void> {
  loadRepoEnvLocal();

  const flags = parseFlags(process.argv.slice(2));
  const options: BackfillOptions = {
    cardsPath: resolvePath(getStringFlag(flags, "--cards") ?? "packages/data/data/cards.v1.json"),
    model: getStringFlag(flags, "--model") ?? DEFAULT_PARSE_MODEL,
    maxCards: getOptionalIntFlag(flags, "--max-cards"),
    concurrency: getIntFlag(flags, "--concurrency", 1)
  };

  const raw = await readFile(options.cardsPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array in ${options.cardsPath}`);
  }

  const lexicon = await loadRulebookLexicon();
  const cards = parsed.map((entry, index) => {
    const result = CardSchema.safeParse(stripLegacyPowerStages(entry));
    if (!result.success) {
      throw new Error(`Card parse failed at index ${index}: ${result.error.issues[0]?.message ?? "unknown error"}`);
    }
    return result.data;
  });

  const candidates = cards
    .filter((card) => {
      const personalityLike =
        card.cardType === "personality" ||
        card.isMainPersonality ||
        card.isAlly ||
        card.personalityLevel !== null ||
        card.pur !== null;
      const missingStageLadder = card.powerStageValues.length < 4 || !card.powerStageValues.includes(0);
      const missingAffiliation = card.affiliation === "unknown";
      const missingTitle = card.isMainPersonality && (card.title ?? "").trim().length === 0;
      return personalityLike && (missingStageLadder || missingAffiliation || missingTitle);
    })
    .slice(0, options.maxCards ?? Number.MAX_SAFE_INTEGER);

  console.log(`[backfill] cards=${cards.length} candidates=${candidates.length} concurrency=${options.concurrency}`);

  const updates = new Map<string, Card>();
  await mapWithConcurrency(candidates, options.concurrency, async (card, index) => {
    console.log(`[backfill] ${index + 1}/${candidates.length} ${card.id}`);
    const priors = inferFilenamePriors(card.source.imageFileName);
    const ocr: OcrResult = {
      text: card.raw.ocrText ?? "",
      engine: "existing-json",
      warnings: [],
      blocks: []
    };

    const llm = await parseCardWithLlm({
      image: {
        setCode: card.setCode,
        setName: card.setName,
        imagePath: card.source.imagePath,
        imageFileName: card.source.imageFileName
      },
      priors,
      ocr,
      lexicon,
      model: options.model
    });

    const merged = mergeBackfill(card, llm.data);
    updates.set(card.id, merged);
  });

  const nextCards = cards.map((card) => updates.get(card.id) ?? card);
  await writeFile(options.cardsPath, `${JSON.stringify(nextCards, null, 2)}\n`, "utf8");
  console.log(`[backfill] wrote ${options.cardsPath}`);
}

function mergeBackfill(card: Card, llmData: Record<string, unknown>): Card {
  const next = { ...card };
  const llmCardType = normalizeCardTypeValue(llmData.cardType);
  if (llmCardType) {
    next.cardType = llmCardType;
  }

  const affiliation = normalizeAffiliation(llmData.affiliation);
  if (affiliation !== "unknown") {
    next.affiliation = affiliation;
  } else if (next.affiliation === "unknown") {
    next.affiliation = inferAffiliationFromCard(next);
  }

  if (typeof llmData.isAlly === "boolean") {
    next.isAlly = llmData.isAlly;
  } else if (normalizedCardTypeFromUnknown(llmData.cardType) === "ally") {
    next.isAlly = true;
  }
  if (typeof llmData.isMainPersonality === "boolean") {
    next.isMainPersonality = llmData.isMainPersonality;
  } else if (next.cardType === "personality" && !next.isAlly && next.personalityLevel !== null) {
    next.isMainPersonality = true;
  }
  if (next.isAlly) {
    next.isMainPersonality = false;
    next.cardType = "personality";
  } else if (next.isMainPersonality) {
    next.cardType = "personality";
  }

  const title = asNonEmptyString(llmData.title);
  if (next.isMainPersonality && title) {
    next.title = title;
  }

  const stageValues = normalizeStageValues(llmData.powerStageValues);
  if (stageValues.length >= 4 && stageValues.includes(0)) {
    next.powerStageValues = stageValues;
  }

  const enduranceFromLlm = toNullableInt(llmData.endurance);
  if (enduranceFromLlm !== null) {
    next.endurance = enduranceFromLlm;
  } else if (next.endurance === null) {
    const fromText = extractEnduranceFromText(next.cardTextRaw);
    if (fromText !== null) {
      next.endurance = fromText;
    }
  }

  if (next.isMainPersonality && next.title && next.name.includes(next.title)) {
    const stripped = next.name.replace(next.title, "").replace(/\s+/g, " ").trim();
    if (stripped.length > 0) {
      next.name = stripped;
    }
  }

  return next;
}

function normalizeAffiliation(value: unknown): Card["affiliation"] {
  if (typeof value !== "string") {
    return "unknown";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "hero" || normalized === "villain" || normalized === "neutral" || normalized === "unknown") {
    return normalized;
  }
  return "unknown";
}

function normalizeCardTypeValue(value: unknown): Card["cardType"] | null {
  const normalized = normalizedCardTypeFromUnknown(value);
  if (!normalized) {
    return null;
  }
  if (normalized === "main_personality" || normalized === "ally") {
    return "personality";
  }
  if (
    [
      "personality",
      "mastery",
      "physical_combat",
      "energy_combat",
      "event",
      "setup",
      "drill",
      "dragon_ball",
      "non_combat",
      "other",
      "unknown"
    ].includes(normalized)
  ) {
    return normalized as Card["cardType"];
  }
  return null;
}

function normalizedCardTypeFromUnknown(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  return normalized.length > 0 ? normalized : null;
}

function inferAffiliationFromCard(card: Card): Card["affiliation"] {
  const lowered = [...card.tags, ...card.cardSubtypes].map((entry) => entry.toLowerCase());
  if (lowered.some((entry) => entry === "hero" || entry.includes("heroes-only") || entry.includes("heroic"))) {
    return "hero";
  }
  if (lowered.some((entry) => entry === "villain" || entry.includes("villains-only") || entry.includes("villainous"))) {
    return "villain";
  }
  return "unknown";
}

function normalizeStageValues(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry >= 0)
    .map((entry) => Math.trunc(entry));

  if (normalized.length === 0) {
    return [];
  }

  const descending = [normalized[0]];
  let previous = normalized[0];
  for (let index = 1; index < normalized.length; index += 1) {
    const current = normalized[index];
    if (current <= previous) {
      descending.push(current);
      previous = current;
    }
  }
  if (!descending.includes(0)) {
    descending.push(0);
  }

  return descending.filter((entry, index) => index === 0 || entry !== descending[index - 1]);
}

function extractEnduranceFromText(text: string): number | null {
  const match = text.match(/\bendurance\s*[:+-]?\s*(\d{1,2})\b/i);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNullableInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
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

function resolvePath(value: string): string {
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(process.cwd(), value);
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

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
