#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { CardSchema, type Card } from "@dbzccg/schema";
import { DEFAULT_OUTPUT_CARDS } from "../constants.js";
import { loadRepoEnvLocal } from "../io/load-env-local.js";
import { resolveRepoPath } from "../io/repo-paths.js";

interface MigrateMetadataOptions {
  cardsPath: string;
  dryRun: boolean;
}

async function main(): Promise<void> {
  loadRepoEnvLocal();

  const flags = parseFlags(process.argv.slice(2));
  const options: MigrateMetadataOptions = {
    cardsPath: resolveRepoPath(getStringFlag(flags, "--cards") ?? DEFAULT_OUTPUT_CARDS),
    dryRun: hasFlag(flags, "--dry-run")
  };

  const raw = await readFile(options.cardsPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array in ${options.cardsPath}`);
  }

  const normalizedCards: Card[] = [];
  let changedCount = 0;
  for (const [index, entry] of parsed.entries()) {
    const sanitized = stripLegacyPowerStages(entry);
    const validated = CardSchema.safeParse(sanitized);
    if (!validated.success) {
      const issue = validated.error.issues[0];
      throw new Error(
        `Card parse failed at index ${index}: ${issue?.path.join(".") ?? "<root>"} ${issue?.message ?? "unknown error"}`
      );
    }

    const normalized = validated.data;
    normalizedCards.push(normalized);
    if (!stableJsonEqual(sanitized, normalized)) {
      changedCount += 1;
    }
  }

  if (!options.dryRun) {
    await writeFile(options.cardsPath, `${JSON.stringify(normalizedCards, null, 2)}\n`, "utf8");
  }

  console.log(
    `[migrate:metadata] cards=${normalizedCards.length} changed=${changedCount} dryRun=${String(options.dryRun)} path=${options.cardsPath}`
  );
}

function stableJsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function hasFlag(flags: Map<string, string | boolean>, key: string): boolean {
  return flags.get(key) === true;
}

function getStringFlag(flags: Map<string, string | boolean>, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

await main();
