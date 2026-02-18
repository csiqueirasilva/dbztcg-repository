#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface MigrationOptions {
  cardsPath: string;
  reviewQueuePath: string;
  wipe: boolean;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const options: MigrationOptions = {
    cardsPath: resolvePath(getStringFlag(flags, "--cards") ?? "../../packages/data/data/cards.v1.json"),
    reviewQueuePath: resolvePath(getStringFlag(flags, "--review-queue") ?? "../../packages/data/raw/review-queue.v1.json"),
    wipe: hasBooleanFlag(flags, "--wipe")
  };

  if (options.wipe) {
    await writeFile(options.cardsPath, "[]\n", "utf8");
    await writeFile(options.reviewQueuePath, "[]\n", "utf8");
    console.log(`[migrate:personality] wiped outputs: cards=${options.cardsPath} review=${options.reviewQueuePath}`);
    return;
  }

  const cardsRaw = await readJsonArray(options.cardsPath);
  const reviewRaw = await readJsonArray(options.reviewQueuePath);

  let cardsChanged = 0;
  const cardsNext = cardsRaw.map((entry) => {
    const normalized = normalizeCardLikeRecord(entry);
    if (normalized.changed) {
      cardsChanged += 1;
    }
    return normalized.value;
  });

  let reviewChanged = 0;
  const reviewNext = reviewRaw.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    const item = entry as Record<string, unknown>;
    const candidate = item.candidateValues;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return entry;
    }
    const normalized = normalizeCardLikeRecord(candidate as Record<string, unknown>);
    if (!normalized.changed) {
      const cleanedSnapshot = removePowerStagesFieldScore(item);
      if (!cleanedSnapshot.changed) {
        return entry;
      }
      reviewChanged += 1;
      return cleanedSnapshot.value;
    }
    reviewChanged += 1;
    const updated = {
      ...item,
      candidateValues: normalized.value
    };
    const cleanedSnapshot = removePowerStagesFieldScore(updated);
    return cleanedSnapshot.changed ? cleanedSnapshot.value : updated;
  });

  await writeFile(options.cardsPath, `${JSON.stringify(cardsNext, null, 2)}\n`, "utf8");
  await writeFile(options.reviewQueuePath, `${JSON.stringify(reviewNext, null, 2)}\n`, "utf8");
  console.log(
    `[migrate:personality] cards=${cardsNext.length} changed=${cardsChanged} reviewItems=${reviewNext.length} candidateChanges=${reviewChanged}`
  );
}

function normalizeCardLikeRecord(
  value: Record<string, unknown>
): { value: Record<string, unknown>; changed: boolean } {
  const next: Record<string, unknown> = { ...value };
  let changed = false;

  if ("powerStages" in next) {
    delete next.powerStages;
    changed = true;
  }
  const cleanedConfidence = removePowerStagesFieldScore(next);
  if (cleanedConfidence.changed) {
    changed = true;
    Object.assign(next, cleanedConfidence.value);
  }
  const cleanedFieldConfidence = removeLegacyFieldConfidence(next);
  if (cleanedFieldConfidence.changed) {
    changed = true;
    Object.assign(next, cleanedFieldConfidence.value);
  }

  const rawCardType = normalizeCardTypeToken(next.cardType);
  const rawIsAlly = toNullableBoolean(next.isAlly);
  const rawIsMainPersonality = toNullableBoolean(next.isMainPersonality);
  const personalityLevel = toNullableNonNegativeInt(next.personalityLevel);

  const normalizedCardType =
    rawCardType === "main_personality" || rawCardType === "ally"
      ? "personality"
      : isValidCardType(rawCardType)
        ? rawCardType
        : null;

  let isAlly = rawIsAlly;
  if (isAlly === null && rawCardType === "ally") {
    isAlly = true;
  }
  if (isAlly === null) {
    isAlly = false;
  }

  let isMainPersonality = rawIsMainPersonality;
  if (isMainPersonality === null && rawCardType === "main_personality") {
    isMainPersonality = true;
  }
  if (isMainPersonality === null) {
    isMainPersonality = normalizedCardType === "personality" && !isAlly && personalityLevel !== null;
  }
  if (isAlly) {
    isMainPersonality = false;
  }

  const resolvedCardType = normalizedCardType ?? (isAlly || isMainPersonality ? "personality" : "unknown");

  if (next.cardType !== resolvedCardType) {
    next.cardType = resolvedCardType;
    changed = true;
  }
  if (next.isAlly !== isAlly) {
    next.isAlly = isAlly;
    changed = true;
  }
  if (next.isMainPersonality !== isMainPersonality) {
    next.isMainPersonality = isMainPersonality;
    changed = true;
  }

  const endurance = toNullableNonNegativeInt(next.endurance);
  if (!isNullableEquivalent(next.endurance, endurance)) {
    next.endurance = endurance;
    changed = true;
  }

  return { value: next, changed };
}

function isValidCardType(value: string | null): boolean {
  if (!value) {
    return false;
  }
  return [
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
  ].includes(value);
}

function normalizeCardTypeToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  return normalized.length > 0 ? normalized : null;
}

function toNullableBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

function toNullableNonNegativeInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function isNullableEquivalent(raw: unknown, normalized: number | null): boolean {
  const current = toNullableNonNegativeInt(raw);
  return current === normalized;
}

function removePowerStagesFieldScore(
  value: Record<string, unknown>
): { value: Record<string, unknown>; changed: boolean } {
  const snapshot = value.confidenceSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { value, changed: false };
  }
  const fields = (snapshot as Record<string, unknown>).fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || !("powerStages" in fields)) {
    return { value, changed: false };
  }

  const nextFields = { ...(fields as Record<string, unknown>) };
  delete nextFields.powerStages;
  return {
    value: {
      ...value,
      confidenceSnapshot: {
        ...(snapshot as Record<string, unknown>),
        fields: nextFields
      }
    },
    changed: true
  };
}

function removeLegacyFieldConfidence(
  value: Record<string, unknown>
): { value: Record<string, unknown>; changed: boolean } {
  const keys: Array<"confidence" | "fieldConfidence"> = ["confidence", "fieldConfidence"];
  let changed = false;
  let next = value;

  for (const key of keys) {
    const container = next[key];
    if (!container || typeof container !== "object" || Array.isArray(container)) {
      continue;
    }
    const fields = key === "confidence" ? (container as Record<string, unknown>).fields : container;
    if (!fields || typeof fields !== "object" || Array.isArray(fields) || !("powerStages" in fields)) {
      continue;
    }

    const nextFields = { ...(fields as Record<string, unknown>) };
    delete nextFields.powerStages;

    if (key === "confidence") {
      next = {
        ...next,
        confidence: {
          ...(container as Record<string, unknown>),
          fields: nextFields
        }
      };
    } else {
      next = {
        ...next,
        fieldConfidence: nextFields
      };
    }
    changed = true;
  }

  return { value: next, changed };
}

async function readJsonArray(filePath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array at ${filePath}`);
  }
  return parsed.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
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

function hasBooleanFlag(flags: Map<string, string | boolean>, key: string): boolean {
  return flags.get(key) === true;
}

function getStringFlag(flags: Map<string, string | boolean>, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function resolvePath(targetPath: string): string {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(process.cwd(), targetPath);
}

void main().catch((error) => {
  console.error(`[migrate:personality] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
