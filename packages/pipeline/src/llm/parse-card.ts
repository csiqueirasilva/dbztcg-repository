import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CardExtractionSchema, type CardExtraction } from "@dbzccg/schema";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { DiscoveredImage, FilenamePriors, LlmParseResult, OcrResult, RulebookLexicon } from "../types.js";

const CODEX_COMMAND = (process.env.CODEX_COMMAND ?? "codex").trim();
const CODEX_TIMEOUT_MS = getTimeoutMs(process.env.CODEX_TIMEOUT_MS);
const CODEX_PARSE_ATTEMPTS = getParseAttempts(process.env.CODEX_PARSE_ATTEMPTS);

let extractionSchemaPathPromise: Promise<string> | null = null;

export interface ParseCardInput {
  image: DiscoveredImage;
  priors: FilenamePriors;
  ocr: OcrResult;
  lexicon: RulebookLexicon;
  model: string;
}

export async function parseCardWithLlm(input: ParseCardInput): Promise<LlmParseResult> {
  const schemaPath = await getExtractionSchemaPath();
  const tempDirectory = await mkdtemp(path.join(tmpdir(), "dbzccg-codex-response-"));
  const responsePath = path.join(tempDirectory, "response.json");
  const warnings: string[] = [];
  let lastRawResponse: string | undefined;
  let previousIssues: string[] = [];

  try {
    for (let attempt = 1; attempt <= CODEX_PARSE_ATTEMPTS; attempt += 1) {
      const prompt = buildCodexPrompt(input, {
        attempt,
        previousIssues,
        previousRawResponse: lastRawResponse
      });
      const args = buildCodexArgs({
        schemaPath,
        imagePath: input.image.imagePath,
        responsePath,
        model: input.model
      });

      const commandResult = await runCodexCommand(args, prompt);
      if (commandResult.error) {
        warnings.push(
          `Codex invocation failed on attempt ${attempt}/${CODEX_PARSE_ATTEMPTS}. ${commandResult.error.message}`
        );
        continue;
      }

      if (commandResult.timedOut) {
        warnings.push(`Codex timed out on attempt ${attempt}/${CODEX_PARSE_ATTEMPTS} after ${CODEX_TIMEOUT_MS}ms.`);
        continue;
      }

      if (commandResult.exitCode !== 0) {
        warnings.push(
          `Codex returned non-zero exit on attempt ${attempt}/${CODEX_PARSE_ATTEMPTS}. ` +
            formatCommandDiagnostics(commandResult.exitCode, commandResult.stderr, commandResult.stdout)
        );
        continue;
      }

      const rawResponse = await readResponseFile(responsePath);
      lastRawResponse = rawResponse;
      const parsedJson = tryParseJsonObject(rawResponse);
      if (!parsedJson) {
        warnings.push(`Codex response was not valid JSON on attempt ${attempt}/${CODEX_PARSE_ATTEMPTS}.`);
        continue;
      }

      const parsedExtraction = CardExtractionSchema.safeParse(parsedJson);
      if (!parsedExtraction.success) {
        const issues = parsedExtraction.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
        warnings.push(
          `Codex JSON failed schema validation on attempt ${attempt}/${CODEX_PARSE_ATTEMPTS}. ${issues.join(" | ")}`
        );
        previousIssues = issues;
        continue;
      }

      const qualityIssues = evaluateExtractionQuality(parsedExtraction.data, input);
      if (qualityIssues.length > 0 && attempt < CODEX_PARSE_ATTEMPTS) {
        previousIssues = qualityIssues;
        warnings.push(
          `Codex output quality was low on attempt ${attempt}/${CODEX_PARSE_ATTEMPTS}. ${qualityIssues.join(" | ")}`
        );
        continue;
      }

      if (qualityIssues.length > 0) {
        warnings.push(`Codex output quality warning. ${qualityIssues.join(" | ")}`);
      }

      const tunedExtraction = applyQualityPenalties(parsedExtraction.data, qualityIssues);
      return {
        data: tunedExtraction as Record<string, unknown>,
        llmUsed: true,
        warnings,
        rawJson: rawResponse
      };
    }

    warnings.push("All Codex parse attempts failed or were low-quality; used heuristic fallback.");
    return {
      data: buildHeuristicData(input),
      llmUsed: false,
      warnings,
      rawJson: lastRawResponse
    };
  } catch (error) {
    warnings.push(`Codex parsing failed unexpectedly. ${stringifyError(error)}`);
    warnings.push("Used heuristic fallback.");
    return {
      data: buildHeuristicData(input),
      llmUsed: false,
      warnings,
      rawJson: lastRawResponse
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

interface CodexPromptContext {
  attempt: number;
  previousIssues: string[];
  previousRawResponse?: string;
}

function buildCodexPrompt(input: ParseCardInput, context: CodexPromptContext): string {
  const ocrText = input.ocr.text.slice(0, 8_000);
  const lexiconSummary = JSON.stringify(input.lexicon, null, 2).slice(0, 8_000);
  const priors = JSON.stringify(input.priors, null, 2);
  const retryBlock =
    context.attempt > 1
      ? [
          "Previous attempt had issues. Correct them in this response.",
          `Issues:\n${context.previousIssues.length > 0 ? context.previousIssues.join("\n") : "- unknown issue"}`,
          `Previous JSON:\n${context.previousRawResponse ?? "<empty>"}`
        ].join("\n\n")
      : null;

  return [
    "Parse the attached Dragon Ball Z TCG image into one strict JSON object that matches the output schema.",
    "Output JSON only. No prose, no markdown.",
    "Extraction rules:",
    "- Use null for unknown scalar fields (except booleans), false for unknown booleans, and [] for unknown arrays.",
    "- Prefer visible card text and iconography over filename priors if they conflict.",
    "- name: primary card name; strip level markers like 'Lv. 1'.",
    "- title: epithet/subtitle only; null if absent.",
    "- characterKey: lowercase slug like 'nail' or 'goku'.",
    "- Named card rule: if the name is possessive (e.g., \"Nail's ...\"), include \"named\" in cardSubtypes and set characterKey to the owning personality (e.g., \"nail\").",
    "- cardType: use 'personality' for all personality cards (main personalities and allies).",
    "- affiliation: hero, villain, neutral, or unknown.",
    "- isMainPersonality: true only for a main personality; false otherwise.",
    "- isAlly: true if this is an Ally card/personality; otherwise false.",
    "- style: set only when a card style is explicit; for named non-personality cards, freestyle is common when no style banner/token is present.",
    "- For personality cards, read the right-side Power Stage ladder and return powerStageValues in exact descending order (including 0).",
    "- Use the rotated side banner near the stage ladder to classify affiliation/ally markers (HERO, VILLAIN, ALLY, HERO ALLY, VILLAIN ALLY, HERO/VILLAIN ALLY).",
    "- Extract endurance as an integer >= 0 when visible on the card; otherwise null.",
    "- For main personality cards, fill personalityLevel, pur, endurance, and mainPowerText when visible.",
    "- If isAlly is true, set isMainPersonality to false.",
    "- fieldConfidence values must be in [0,1] and reflect certainty per field.",
    `Set context: ${input.image.setCode} / ${input.image.setName}`,
    `Image path: ${input.image.imagePath}`,
    `Filename priors:\n${priors}`,
    `OCR text:\n${ocrText.length > 0 ? ocrText : "<empty>"}`,
    `Rulebook lexicon:\n${lexiconSummary}`,
    retryBlock
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function buildCodexArgs(input: {
  schemaPath: string;
  imagePath: string;
  responsePath: string;
  model: string;
}): string[] {
  const args = [
    "exec",
    "-",
    "--sandbox",
    "read-only",
    "--output-schema",
    input.schemaPath,
    "--output-last-message",
    input.responsePath,
    "--image",
    input.imagePath
  ];

  const model = input.model.trim();
  if (model.length > 0) {
    args.push("--model", model);
  }

  return args;
}

function evaluateExtractionQuality(data: CardExtraction, input: ParseCardInput): string[] {
  const issues: string[] = [];
  const name = data.name?.trim() ?? "";
  const title = data.title?.trim() ?? "";
  const cardTextRaw = data.cardTextRaw?.trim() ?? "";
  const hasPersonalityStats = data.powerStageValues.length > 0 || data.pur !== null || data.personalityLevel !== null;
  const isAllyLikeCard = data.isAlly === true;
  const isMainPersonalityCard =
    data.isMainPersonality === true ||
    (data.cardType === "personality" && !isAllyLikeCard && (input.priors.personalityLevel !== null || data.personalityLevel !== null));
  const isPersonalityCard = data.cardType === "personality" || isMainPersonalityCard || isAllyLikeCard || hasPersonalityStats;
  const affiliation = data.affiliation ?? "unknown";
  const powerStageValues = normalizePowerStageValues(data.powerStageValues);
  const hasStageLadder = powerStageValues.length >= 4 && powerStageValues[powerStageValues.length - 1] === 0;

  if (name.length < 2) {
    issues.push("name appears missing or too short");
  }
  if (isMainPersonalityCard && title.length === 0) {
    issues.push("title missing for personality card");
  }
  if (data.cardType === "unknown") {
    issues.push("cardType is unknown");
  }
  if ((data.cardType as string) === "ally") {
    issues.push("cardType uses legacy ally value");
  }
  if (isMainPersonalityCard && data.isMainPersonality !== true) {
    issues.push("isMainPersonality missing for main personality card");
  }
  if (isAllyLikeCard && data.isMainPersonality === true) {
    issues.push("isMainPersonality should be false for ally cards");
  }
  if ((isPersonalityCard || isAllyLikeCard) && affiliation === "unknown") {
    issues.push("affiliation is unknown for personality/ally card");
  }
  if (cardTextRaw.length < 16) {
    issues.push("cardTextRaw is too short");
  }
  if (title.length > 0 && /\bLv\.\s*\d\b/i.test(title)) {
    issues.push("title includes level marker");
  }

  if (isPersonalityCard) {
    if (!hasStageLadder) {
      issues.push("powerStageValues missing or invalid for personality card");
    }
    if (isMainPersonalityCard && data.personalityLevel === null) {
      issues.push("personalityLevel missing for personality card");
    }
    if (data.pur === null) {
      issues.push("pur missing for personality card");
    }
    if (data.endurance === null && /\bendurance\b/i.test(cardTextRaw)) {
      issues.push("endurance missing despite endurance text");
    }
    if (isMainPersonalityCard && (data.mainPowerText?.trim() ?? "").length < 8) {
      issues.push("mainPowerText missing or too short for personality card");
    }
  }

  if (!isStyleLikely(data.style, data.cardType, cardTextRaw, name, title)) {
    issues.push("style likely incorrect for card type");
  }

  return issues;
}

function applyQualityPenalties(data: CardExtraction, qualityIssues: string[]): CardExtraction {
  if (qualityIssues.length === 0) {
    return data;
  }

  const penalties: Partial<Record<keyof CardExtraction["fieldConfidence"], number>> = {};
  for (const issue of qualityIssues) {
    if (issue.includes("name")) {
      penalties.name = 0.35;
    } else if (issue.includes("cardType")) {
      penalties.cardType = 0.35;
    } else if (issue.includes("isMainPersonality")) {
      penalties.isMainPersonality = 0.35;
    } else if (issue.includes("affiliation")) {
      penalties.affiliation = 0.35;
    } else if (issue.includes("isAlly")) {
      penalties.isAlly = 0.35;
    } else if (issue.includes("cardTextRaw")) {
      penalties.cardTextRaw = 0.35;
    } else if (issue.includes("personalityLevel")) {
      penalties.personalityLevel = 0.35;
    } else if (issue.includes("powerStageValues")) {
      penalties.powerStageValues = 0.35;
    } else if (issue.includes("pur")) {
      penalties.pur = 0.35;
    } else if (issue.includes("endurance")) {
      penalties.endurance = 0.35;
    } else if (issue.includes("mainPowerText")) {
      penalties.mainPowerText = 0.35;
    }
  }

  return {
    ...data,
    fieldConfidence: {
      ...data.fieldConfidence,
      name: clamp01(Math.min(data.fieldConfidence.name, penalties.name ?? data.fieldConfidence.name)),
      cardType: clamp01(Math.min(data.fieldConfidence.cardType, penalties.cardType ?? data.fieldConfidence.cardType)),
      affiliation: clamp01(
        Math.min(data.fieldConfidence.affiliation, penalties.affiliation ?? data.fieldConfidence.affiliation)
      ),
      isMainPersonality: clamp01(
        Math.min(data.fieldConfidence.isMainPersonality, penalties.isMainPersonality ?? data.fieldConfidence.isMainPersonality)
      ),
      isAlly: clamp01(Math.min(data.fieldConfidence.isAlly, penalties.isAlly ?? data.fieldConfidence.isAlly)),
      cardTextRaw: clamp01(
        Math.min(data.fieldConfidence.cardTextRaw, penalties.cardTextRaw ?? data.fieldConfidence.cardTextRaw)
      ),
      personalityLevel: clamp01(
        Math.min(data.fieldConfidence.personalityLevel, penalties.personalityLevel ?? data.fieldConfidence.personalityLevel)
      ),
      powerStageValues: clamp01(
        Math.min(data.fieldConfidence.powerStageValues, penalties.powerStageValues ?? data.fieldConfidence.powerStageValues)
      ),
      pur: clamp01(Math.min(data.fieldConfidence.pur, penalties.pur ?? data.fieldConfidence.pur)),
      endurance: clamp01(Math.min(data.fieldConfidence.endurance, penalties.endurance ?? data.fieldConfidence.endurance)),
      mainPowerText: clamp01(
        Math.min(data.fieldConfidence.mainPowerText, penalties.mainPowerText ?? data.fieldConfidence.mainPowerText)
      )
    }
  };
}

function isStyleLikely(
  style: CardExtraction["style"],
  cardType: CardExtraction["cardType"],
  cardTextRaw: string,
  name: string,
  title: string
): boolean {
  if (!style) {
    return true;
  }

  if (["physical_combat", "energy_combat", "mastery", "drill", "event", "setup", "unknown"].includes(cardType)) {
    return true;
  }

  const lowerCombined = `${name} ${title} ${cardTextRaw}`.toLowerCase();
  return lowerCombined.includes(`${style} style`) || lowerCombined.includes(`${style} mastery`);
}

async function getExtractionSchemaPath(): Promise<string> {
  if (!extractionSchemaPathPromise) {
    extractionSchemaPathPromise = writeExtractionSchemaFile();
  }
  return extractionSchemaPathPromise;
}

async function writeExtractionSchemaFile(): Promise<string> {
  const schemaDirectory = await mkdtemp(path.join(tmpdir(), "dbzccg-codex-schema-"));
  const schemaPath = path.join(schemaDirectory, "card-extraction.schema.json");
  const schemaJson = zodToJsonSchema(CardExtractionSchema, {
    target: "jsonSchema7",
    $refStrategy: "none"
  });
  await writeFile(schemaPath, JSON.stringify(schemaJson, null, 2), "utf8");
  return schemaPath;
}

async function runCodexCommand(args: string[], prompt: string): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: Error;
}> {
  return new Promise((resolve) => {
    const child = spawn(CODEX_COMMAND, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2_000);
    }, CODEX_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolve({
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        error: error instanceof Error ? error : new Error(String(error))
      });
    });

    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut
      });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function readResponseFile(responsePath: string): Promise<string> {
  try {
    return await readFile(responsePath, "utf8");
  } catch {
    return "";
  }
}

function formatCommandDiagnostics(exitCode: number | null, stderr: string, stdout: string): string {
  const details: string[] = [];
  details.push(`exit=${exitCode === null ? "null" : String(exitCode)}`);

  const stderrTail = trimTail(stderr, 280);
  if (stderrTail) {
    details.push(`stderr=${stderrTail}`);
  }

  const stdoutTail = trimTail(stdout, 280);
  if (stdoutTail) {
    details.push(`stdout=${stdoutTail}`);
  }

  return details.join(" ");
}

function trimTail(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `...${compact.slice(compact.length - maxLength)}`;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getTimeoutMs(rawValue: string | undefined): number {
  if (!rawValue) {
    return 120_000;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 10_000) {
    return 120_000;
  }
  return parsed;
}

function getParseAttempts(rawValue: string | undefined): number {
  if (!rawValue) {
    return 2;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4) {
    return 2;
  }
  return parsed;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function tryParseJsonObject(value: string): CardExtraction | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CardExtraction;
    }
    return null;
  } catch {
    const blockMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!blockMatch) {
      return null;
    }
    try {
      const parsed = JSON.parse(blockMatch[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as CardExtraction;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function buildHeuristicData(input: ParseCardInput): CardExtraction {
  const ocrText = input.ocr.text.trim();
  const inferredText = ocrText.length > 0 ? ocrText : input.priors.nameGuess;
  const inferredAffiliation = inferAffiliationFromText(inferredText, input.lexicon);
  const inferredIsAlly = inferIsAllyFromText(inferredText, input.priors.cardTypeGuess);
  const inferredIsMainPersonality = inferIsMainPersonalityFromText(
    inferredText,
    input.priors.cardTypeGuess,
    input.priors.personalityLevel,
    inferredIsAlly
  );
  const inferredPowerStageValues = normalizePowerStageValues(extractPowerStageValuesFromText(inferredText));
  const inferredEndurance = extractEnduranceValue(inferredText);
  const effectChunks = inferredText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 8)
    .map((line) => ({
      kind: "other" as const,
      text: line,
      keywords: inferKeywordsFromLine(line)
    }));

  return {
    name: input.priors.nameGuess,
    title: null,
    characterKey: input.priors.characterKey,
    cardType: input.priors.cardTypeGuess,
    affiliation: inferredAffiliation,
    isMainPersonality: inferredIsMainPersonality,
    isAlly: inferredIsAlly,
    cardSubtypes: [],
    style: normalizeHeuristicStyle(input.priors.styleGuess),
    tags: [],
    personalityLevel: input.priors.personalityLevel,
    powerStageValues: inferredPowerStageValues,
    pur: extractNumericStat(ocrText, ["pur"]),
    endurance: inferredEndurance,
    mainPowerText: extractMainPowerText(ocrText),
    cardTextRaw: inferredText,
    effectChunks,
    icons: {
      isAttack: false,
      isDefense: false,
      isQuick: false,
      isConstant: false,
      rawIconEvidence: []
    },
    fieldConfidence: {
      name: 0.75,
      cardType: input.priors.cardTypeGuess === "unknown" ? 0.35 : 0.6,
      affiliation: inferredAffiliation === "unknown" ? 0.3 : 0.65,
      isMainPersonality: inferredIsMainPersonality ? 0.65 : 0.5,
      isAlly: inferredIsAlly ? 0.65 : 0.5,
      cardTextRaw: ocrText.length > 30 ? 0.75 : 0.2,
      personalityLevel: input.priors.personalityLevel !== null ? 0.8 : 0.3,
      powerStageValues: inferredPowerStageValues.length >= 4 ? 0.6 : inferredPowerStageValues.length > 0 ? 0.35 : 0.2,
      pur: ocrText.length > 0 ? 0.4 : 0.2,
      endurance: inferredEndurance !== null ? 0.6 : 0.4,
      mainPowerText: ocrText.length > 0 ? 0.4 : 0.2
    }
  };
}

function inferAffiliationFromText(text: string, lexicon: RulebookLexicon): CardExtraction["affiliation"] {
  const lowered = text.toLowerCase();
  if (lexicon.affiliationKeywords.hero.some((value) => lowered.includes(value))) {
    return "hero";
  }
  if (lexicon.affiliationKeywords.villain.some((value) => lowered.includes(value))) {
    return "villain";
  }
  if (lexicon.affiliationKeywords.neutral.some((value) => lowered.includes(value))) {
    return "neutral";
  }
  return "unknown";
}

function inferIsAllyFromText(text: string, cardTypeGuess: CardExtraction["cardType"]): boolean {
  if (cardTypeGuess !== "personality" && cardTypeGuess !== "unknown") {
    return false;
  }
  const lowered = text.toLowerCase();
  return /\ball(?:y|ies)\b/.test(lowered);
}

function inferIsMainPersonalityFromText(
  text: string,
  cardTypeGuess: CardExtraction["cardType"],
  personalityLevel: number | null,
  isAlly: boolean
): boolean {
  if (cardTypeGuess !== "personality" || isAlly) {
    return false;
  }
  if (personalityLevel !== null) {
    return true;
  }
  const lowered = text.toLowerCase();
  return /\blv\.\s*[1-4]\b/.test(lowered) || /\blevel\s*[1-4]\b/.test(lowered) || /\bmain personality\b/.test(lowered);
}

function inferKeywordsFromLine(line: string): string[] {
  const normalized = line.toLowerCase();
  const tokens = ["damage", "combat", "anger", "dragon ball", "stages", "discard", "power", "ally", "drill"];
  return tokens.filter((token) => normalized.includes(token));
}

function normalizeHeuristicStyle(value: string | null): CardExtraction["style"] {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  const allowed: Array<Exclude<CardExtraction["style"], null>> = [
    "black",
    "blue",
    "namekian",
    "orange",
    "red",
    "saiyan",
    "freestyle",
    "other",
    "unknown"
  ];

  if (allowed.includes(normalized as Exclude<CardExtraction["style"], null>)) {
    return normalized as Exclude<CardExtraction["style"], null>;
  }
  return null;
}

function extractNumericStat(text: string, labels: string[]): number | null {
  const lowered = text.toLowerCase();
  for (const label of labels) {
    const regex = new RegExp(`${escapeRegex(label)}\\s*[:|-]?\\s*(\\d{1,3})`, "i");
    const match = lowered.match(regex);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isInteger(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function extractPowerStageValuesFromText(text: string): number[] {
  const matches = text.match(/\b\d{1,3}(?:,\d{3})*\b/g) ?? [];
  const numbers = matches
    .map((value) => Number(value.replace(/,/g, "")))
    .filter((value) => Number.isInteger(value) && value >= 0);

  if (numbers.length === 0) {
    return [];
  }

  const bestSequence: number[] = [];
  for (let startIndex = 0; startIndex < numbers.length; startIndex += 1) {
    const candidate: number[] = [numbers[startIndex]];
    let previous = numbers[startIndex];

    for (let index = startIndex + 1; index < numbers.length; index += 1) {
      const current = numbers[index];
      if (current <= previous) {
        candidate.push(current);
        previous = current;
        if (current === 0) {
          break;
        }
      }
    }

    if (candidate.length > bestSequence.length) {
      bestSequence.splice(0, bestSequence.length, ...candidate);
    }
  }

  return bestSequence;
}

function normalizePowerStageValues(values: number[]): number[] {
  if (values.length === 0) {
    return [];
  }

  const normalized = values
    .map((value) => Math.trunc(value))
    .filter((value) => Number.isInteger(value) && value >= 0);

  if (normalized.length === 0) {
    return [];
  }

  const dedupedOrdered = normalized.filter((value, index) => index === 0 || value !== normalized[index - 1]);
  if (!dedupedOrdered.includes(0)) {
    dedupedOrdered.push(0);
  }

  return dedupedOrdered;
}

function extractEnduranceValue(text: string): number | null {
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

function extractMainPowerText(text: string): string | null {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const powerLine = lines.find((line) => /power|main personality power/i.test(line));
  return powerLine ?? null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
