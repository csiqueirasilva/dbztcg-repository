import { CardSchema, type Card, type SetCode } from "@dbzccg/schema";
import type { ValidationResult } from "../types.js";
import { createReviewQueueItem } from "../review/review-queue.js";

export interface ValidateCardOptions {
  minConfidence: number;
}

interface SourceSignals {
  llmUnavailable: boolean;
  ocrUnavailable: boolean;
}

interface ConsistencyFindings {
  failedFields: string[];
  reasons: string[];
}

export function validateCardCandidate(candidate: Record<string, unknown>, options: ValidateCardOptions): ValidationResult {
  const working = { ...candidate } as Record<string, unknown>;
  normalizeLegacyCardTypeFields(working);

  const setCode = asNonEmptyString(working.setCode) as SetCode | null;
  const printedNumber = asNonEmptyString(working.printedNumber);
  const cardId = setCode && printedNumber ? `${setCode}-${printedNumber}` : `TEMP-${Date.now()}`;
  working.id = cardId;

  const fieldConfidenceHints = toNumberMap(working._fieldConfidenceHint);
  const llmUsed = Boolean(working._llmUsed);
  delete working._fieldConfidenceHint;
  delete working._llmUsed;
  const sourceSignals = detectSourceSignals(working);
  const consistencyFindings = evaluateConsistencyFindings(working);

  const fieldConfidence = buildFieldConfidence(working, fieldConfidenceHints, llmUsed, sourceSignals, consistencyFindings);
  const overallConfidence = computeOverallConfidence(fieldConfidence);
  working.confidence = {
    overall: overallConfidence,
    fields: fieldConfidence
  };

  const criticalFailedFields = evaluateCriticalFieldFailures(working);
  const failedFields = Array.from(new Set([...criticalFailedFields, ...consistencyFindings.failedFields]));
  const reasons: string[] = [];

  if (criticalFailedFields.length > 0) {
    reasons.push("missing_critical_field");
  }
  reasons.push(...consistencyFindings.reasons);
  if (sourceSignals.llmUnavailable && !llmUsed) {
    reasons.push("llm_unavailable");
  }
  if (sourceSignals.ocrUnavailable && !llmUsed) {
    reasons.push("insufficient_ocr");
  }
  if (overallConfidence < options.minConfidence) {
    reasons.push("low_confidence");
  }
  const uniqueReasons = Array.from(new Set(reasons));

  working.review = {
    required: uniqueReasons.length > 0,
    reasons: uniqueReasons,
    notes: []
  };

  const parsed = CardSchema.safeParse(working);
  if (!parsed.success) {
    const validationReasons = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    const schemaFailedFields = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .filter((path) => path.length > 0);

    const reviewItem = createReviewQueueItem({
      cardId,
      setCode: (setCode ?? "HNV") as SetCode,
      imagePath: asNonEmptyString((working.source as Record<string, unknown> | undefined)?.imagePath) ?? "",
      failedFields: Array.from(new Set([...failedFields, ...schemaFailedFields])),
      reasons: Array.from(new Set(["schema_validation_error", ...uniqueReasons, ...validationReasons])),
      candidateValues: summarizeCandidate(working),
      confidenceOverall: overallConfidence,
      confidenceFields: fieldConfidence
    });

    return { accepted: false, reviewItem };
  }

  const parsedCard = parsed.data;
  if (uniqueReasons.length > 0) {
    const reviewItem = createReviewQueueItem({
      cardId: parsedCard.id,
      setCode: parsedCard.setCode,
      imagePath: parsedCard.source.imagePath,
      failedFields,
      reasons: uniqueReasons,
      candidateValues: summarizeCandidate(parsedCard),
      confidenceOverall: parsedCard.confidence.overall,
      confidenceFields: parsedCard.confidence.fields
    });
    return { accepted: false, reviewItem };
  }

  return {
    accepted: true,
    card: parsedCard
  };
}

function evaluateCriticalFieldFailures(candidate: Record<string, unknown>): string[] {
  const failed: string[] = [];
  const printedNumber = asNonEmptyString(candidate.printedNumber);

  if (!asNonEmptyString(candidate.setCode)) {
    failed.push("setCode");
  }
  if (!printedNumber) {
    failed.push("printedNumber");
  }
  const rarityPrefix = asNonEmptyString(candidate.rarityPrefix);
  if (!rarityPrefix) {
    failed.push("rarityPrefix");
  }
  const expectedRarityPrefix = inferRarityPrefixFromPrintedNumber(printedNumber);
  if (printedNumber && expectedRarityPrefix !== null && rarityPrefix && rarityPrefix !== expectedRarityPrefix) {
    failed.push("rarityPrefix", "printedNumber");
  }
  if (!asNonEmptyString(candidate.name)) {
    failed.push("name");
  }

  const cardType = asNonEmptyString(candidate.cardType);
  if (!cardType || cardType === "unknown") {
    failed.push("cardType");
  }
  const isMainPersonality = toNullableBoolean(candidate.isMainPersonality);
  const affiliation = asNonEmptyString(candidate.affiliation);
  const isAlly = toNullableBoolean(candidate.isAlly);
  const powerStageValues = toIntArray(candidate.powerStageValues);
  const isPersonalityCard =
    cardType === "personality" ||
    isMainPersonality === true ||
    isAlly === true ||
    toNullableInt(candidate.personalityLevel) !== null ||
    powerStageValues.length > 0;
  if (isPersonalityCard && (!affiliation || affiliation === "unknown")) {
    failed.push("affiliation");
  }
  if (isMainPersonality === true && cardType && cardType !== "personality") {
    failed.push("cardType", "isMainPersonality");
  }
  if (isAlly === true && cardType && cardType !== "personality") {
    failed.push("isAlly");
  }
  if (isMainPersonality === true && isAlly === true) {
    failed.push("isMainPersonality", "isAlly");
  }

  const cardTextRaw = asNonEmptyString(candidate.cardTextRaw);
  if (!cardTextRaw || cardTextRaw.length < 8) {
    failed.push("cardTextRaw");
  }

  if (isPersonalityCard) {
    if (isMainPersonality === true && toNullableInt(candidate.personalityLevel) === null) {
      failed.push("personalityLevel");
    }
    if (powerStageValues.length < 4 || !powerStageValues.includes(0)) {
      failed.push("powerStageValues");
    }
    if (toNullableInt(candidate.pur) === null) {
      failed.push("pur");
    }
    if (cardTextRaw && /\bendurance\b/i.test(cardTextRaw) && toNullableInt(candidate.endurance) === null) {
      failed.push("endurance");
    }
    if (isMainPersonality === true && !asNonEmptyString(candidate.mainPowerText)) {
      failed.push("mainPowerText");
    }
  }

  return Array.from(new Set(failed));
}

function buildFieldConfidence(
  candidate: Record<string, unknown>,
  hints: Record<string, number>,
  llmUsed: boolean,
  sourceSignals: SourceSignals,
  consistencyFindings: ConsistencyFindings
): Record<string, number> {
  const score = (field: string, fallback: number): number => clamp01(hints[field] ?? fallback);

  const textLength = asNonEmptyString(candidate.cardTextRaw)?.length ?? 0;
  const hasMainPower = asNonEmptyString(candidate.mainPowerText) !== null;
  const hasRarityPrefix = asNonEmptyString(candidate.rarityPrefix) !== null;
  const hasCardType = asNonEmptyString(candidate.cardType) !== null && asNonEmptyString(candidate.cardType) !== "unknown";
  const hasMainPersonalityFlag = typeof candidate.isMainPersonality === "boolean";
  const hasAffiliation =
    asNonEmptyString(candidate.affiliation) !== null && asNonEmptyString(candidate.affiliation) !== "unknown";
  const hasAllyFlag = typeof candidate.isAlly === "boolean";
  const hasStageValues = toIntArray(candidate.powerStageValues).length >= 4;
  const hasEndurance = toNullableInt(candidate.endurance) !== null;
  const hasConsideredAsStyledFlag = typeof candidate.considered_as_styled_card === "boolean";
  const hasLimitPerDeck = toNullableInt(candidate.limit_per_deck) !== null;
  const hasBanishedAfterUseFlag = typeof candidate.banished_after_use === "boolean";
  const hasShuffleIntoDeckAfterUseFlag = typeof candidate.shuffle_into_deck_after_use === "boolean";
  const personalityLevel = toNullableInt(candidate.personalityLevel);
  const noVisionSignal = sourceSignals.llmUnavailable && !llmUsed && sourceSignals.ocrUnavailable;
  const typeConflict = consistencyFindings.reasons.some((reason) => reason.includes("type_conflict"));

  const confidence = {
    setCode: score("setCode", 0.99),
    printedNumber: score("printedNumber", 0.99),
    rarityPrefix: score("rarityPrefix", hasRarityPrefix ? 0.95 : 0.35),
    name: score("name", llmUsed ? 0.92 : 0.72),
    cardType: score("cardType", hasCardType ? (llmUsed ? 0.86 : 0.55) : 0.2),
    affiliation: score("affiliation", hasAffiliation ? (llmUsed ? 0.84 : 0.55) : 0.25),
    isMainPersonality: score("isMainPersonality", hasMainPersonalityFlag ? (llmUsed ? 0.84 : 0.6) : 0.35),
    isAlly: score("isAlly", hasAllyFlag ? (llmUsed ? 0.84 : 0.6) : 0.35),
    cardTextRaw: score("cardTextRaw", textLength >= 20 ? 0.88 : textLength > 0 ? 0.42 : 0.1),
    personalityLevel: score("personalityLevel", personalityLevel !== null ? 0.8 : 0.4),
    powerStageValues: score("powerStageValues", hasStageValues ? (llmUsed ? 0.82 : 0.5) : 0.25),
    pur: score("pur", toNullableInt(candidate.pur) !== null ? 0.72 : 0.35),
    endurance: score("endurance", hasEndurance ? 0.78 : 0.45),
    mainPowerText: score("mainPowerText", hasMainPower ? 0.72 : 0.35),
    considered_as_styled_card: score(
      "considered_as_styled_card",
      hasConsideredAsStyledFlag ? (llmUsed ? 0.84 : 0.7) : 0.45
    ),
    limit_per_deck: score("limit_per_deck", hasLimitPerDeck ? 0.92 : 0.5),
    banished_after_use: score("banished_after_use", hasBanishedAfterUseFlag ? (llmUsed ? 0.84 : 0.7) : 0.45),
    shuffle_into_deck_after_use: score(
      "shuffle_into_deck_after_use",
      hasShuffleIntoDeckAfterUseFlag ? (llmUsed ? 0.84 : 0.7) : 0.45
    )
  };

  if (sourceSignals.llmUnavailable && !llmUsed) {
    confidence.name = clamp01(confidence.name * 0.8);
    confidence.cardType = clamp01(confidence.cardType * 0.7);
    confidence.affiliation = clamp01(confidence.affiliation * 0.7);
    confidence.isMainPersonality = clamp01(confidence.isMainPersonality * 0.75);
    confidence.isAlly = clamp01(confidence.isAlly * 0.75);
    confidence.powerStageValues = clamp01(confidence.powerStageValues * 0.75);
    confidence.endurance = clamp01(confidence.endurance * 0.8);
    confidence.cardTextRaw = clamp01(confidence.cardTextRaw * 0.75);
    confidence.considered_as_styled_card = clamp01(confidence.considered_as_styled_card * 0.85);
    confidence.limit_per_deck = clamp01(confidence.limit_per_deck * 0.9);
    confidence.banished_after_use = clamp01(confidence.banished_after_use * 0.85);
    confidence.shuffle_into_deck_after_use = clamp01(confidence.shuffle_into_deck_after_use * 0.85);
  }
  if (sourceSignals.ocrUnavailable) {
    confidence.cardTextRaw = clamp01(confidence.cardTextRaw * 0.8);
    confidence.mainPowerText = clamp01(confidence.mainPowerText * 0.85);
    confidence.considered_as_styled_card = clamp01(confidence.considered_as_styled_card * 0.85);
    confidence.limit_per_deck = clamp01(confidence.limit_per_deck * 0.88);
    confidence.banished_after_use = clamp01(confidence.banished_after_use * 0.85);
    confidence.shuffle_into_deck_after_use = clamp01(confidence.shuffle_into_deck_after_use * 0.85);
  }
  if (noVisionSignal) {
    confidence.name = clamp01(confidence.name * 0.75);
    confidence.cardType = clamp01(confidence.cardType * 0.7);
    confidence.affiliation = clamp01(confidence.affiliation * 0.7);
    confidence.isMainPersonality = clamp01(confidence.isMainPersonality * 0.7);
    confidence.isAlly = clamp01(confidence.isAlly * 0.7);
    confidence.powerStageValues = clamp01(confidence.powerStageValues * 0.7);
    confidence.endurance = clamp01(confidence.endurance * 0.75);
    confidence.considered_as_styled_card = clamp01(confidence.considered_as_styled_card * 0.8);
    confidence.limit_per_deck = clamp01(confidence.limit_per_deck * 0.85);
    confidence.banished_after_use = clamp01(confidence.banished_after_use * 0.8);
    confidence.shuffle_into_deck_after_use = clamp01(confidence.shuffle_into_deck_after_use * 0.8);
  }
  if (typeConflict) {
    confidence.cardType = clamp01(confidence.cardType * 0.6);
    confidence.affiliation = clamp01(confidence.affiliation * 0.75);
    confidence.isMainPersonality = clamp01(confidence.isMainPersonality * 0.75);
    confidence.isAlly = clamp01(confidence.isAlly * 0.75);
    confidence.personalityLevel = clamp01(confidence.personalityLevel * 0.6);
    confidence.powerStageValues = clamp01(confidence.powerStageValues * 0.6);
    confidence.pur = clamp01(confidence.pur * 0.6);
    confidence.endurance = clamp01(confidence.endurance * 0.7);
    confidence.considered_as_styled_card = clamp01(confidence.considered_as_styled_card * 0.8);
    confidence.limit_per_deck = clamp01(confidence.limit_per_deck * 0.85);
    confidence.banished_after_use = clamp01(confidence.banished_after_use * 0.8);
    confidence.shuffle_into_deck_after_use = clamp01(confidence.shuffle_into_deck_after_use * 0.8);
  }

  return confidence;
}

function computeOverallConfidence(fieldConfidence: Record<string, number>): number {
  const values = Object.values(fieldConfidence);
  if (values.length === 0) {
    return 0;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return clamp01(total / values.length);
}

function summarizeCandidate(candidate: Record<string, unknown> | Card): Record<string, unknown> {
  const candidateRecord = candidate as Record<string, unknown>;
  return {
    id: asNonEmptyString(candidateRecord.id),
    setCode: asNonEmptyString(candidateRecord.setCode),
    printedNumber: asNonEmptyString(candidateRecord.printedNumber),
    rarityPrefix: asNonEmptyString(candidateRecord.rarityPrefix),
    name: asNonEmptyString(candidateRecord.name),
    title: asNonEmptyString(candidateRecord.title),
    characterKey: asNonEmptyString(candidateRecord.characterKey),
    personalityFamilyId: asNonEmptyString(candidateRecord.personalityFamilyId),
    cardType: asNonEmptyString(candidateRecord.cardType),
    affiliation: asNonEmptyString(candidateRecord.affiliation),
    isMainPersonality: toNullableBoolean(candidateRecord.isMainPersonality),
    isAlly: toNullableBoolean(candidateRecord.isAlly),
    cardSubtypes: Array.isArray(candidateRecord.cardSubtypes) ? candidateRecord.cardSubtypes : [],
    powerStageValues: toIntArray(candidateRecord.powerStageValues),
    pur: toNullableInt(candidateRecord.pur),
    endurance: toNullableInt(candidateRecord.endurance),
    considered_as_styled_card: toNullableBoolean(candidateRecord.considered_as_styled_card),
    limit_per_deck: toNullableInt(candidateRecord.limit_per_deck),
    banished_after_use: toNullableBoolean(candidateRecord.banished_after_use),
    shuffle_into_deck_after_use: toNullableBoolean(candidateRecord.shuffle_into_deck_after_use),
    drill_not_discarded_when_changing_levels: toNullableBoolean(candidateRecord.drill_not_discarded_when_changing_levels),
    attach_limit: normalizeAttachLimit(candidateRecord.attach_limit),
    extraordinary_can_play_from_hand: toNullableBoolean(candidateRecord.extraordinary_can_play_from_hand),
    has_effect_when_discarded_combat: toNullableBoolean(candidateRecord.has_effect_when_discarded_combat),
    seaches_owner_life_deck: toNullableBoolean(candidateRecord.seaches_owner_life_deck),
    rejuvenates_amount: toNullableInt(candidateRecord.rejuvenates_amount),
    conditional_rejuvenate: toNullableBoolean(candidateRecord.conditional_rejuvenate),
    conditional_endurance: toNullableBoolean(candidateRecord.conditional_endurance),
    raise_your_anger: toNullableInt(candidateRecord.raise_your_anger),
    conditional_raise_your_anger: toNullableBoolean(candidateRecord.conditional_raise_your_anger),
    lower_your_anger: toNullableInt(candidateRecord.lower_your_anger),
    conditional_lower_your_anger: toNullableBoolean(candidateRecord.conditional_lower_your_anger),
    raise_or_lower_any_player_anger: toNullableInt(candidateRecord.raise_or_lower_any_player_anger),
    conditional_raise_or_lower_any_player_anger: toNullableBoolean(
      candidateRecord.conditional_raise_or_lower_any_player_anger
    ),
    when_drill_enters_play_during_combat: toNullableBoolean(candidateRecord.when_drill_enters_play_during_combat),
    when_drill_enters_play: toNullableBoolean(candidateRecord.when_drill_enters_play),
    attaches_own_main_personality: toNullableBoolean(candidateRecord.attaches_own_main_personality),
    attaches_opponent_main_personality: toNullableBoolean(candidateRecord.attaches_opponent_main_personality),
    personalityLevel: toNullableInt(candidateRecord.personalityLevel),
    mainPowerText: asNonEmptyString(candidateRecord.mainPowerText),
    cardTextRaw: asNonEmptyString(candidateRecord.cardTextRaw),
    style: asNonEmptyString(candidateRecord.style),
    tags: Array.isArray(candidateRecord.tags) ? candidateRecord.tags : [],
    rawWarnings: extractRawWarnings(candidateRecord)
  };
}

function detectSourceSignals(candidate: Record<string, unknown>): SourceSignals {
  const warnings = extractRawWarnings(candidate);
  const lowered = warnings.map((warning) => warning.toLowerCase());

  const llmUnavailable = lowered.some(
    (warning) =>
      warning.includes("codex invocation failed") ||
      warning.includes("codex timed out") ||
      warning.includes("codex returned non-zero") ||
      warning.includes("all codex parse attempts failed")
  );

  const ocrUnavailable = lowered.some(
    (warning) =>
      warning.includes("ocr failed") ||
      warning.includes("tesseract enonent") ||
      warning.includes("spawn tesseract")
  );

  return {
    llmUnavailable,
    ocrUnavailable
  };
}

function evaluateConsistencyFindings(candidate: Record<string, unknown>): ConsistencyFindings {
  const failedFields: string[] = [];
  const reasons: string[] = [];

  const printedNumber = asNonEmptyString(candidate.printedNumber);
  const rarityPrefix = asNonEmptyString(candidate.rarityPrefix);
  const expectedRarityPrefix = inferRarityPrefixFromPrintedNumber(printedNumber);
  if (printedNumber && expectedRarityPrefix !== null && rarityPrefix && rarityPrefix !== expectedRarityPrefix) {
    failedFields.push("rarityPrefix", "printedNumber");
    reasons.push("rarity_prefix_mismatch");
  }

  const cardType = asNonEmptyString(candidate.cardType);
  const affiliation = asNonEmptyString(candidate.affiliation);
  const isMainPersonality = toNullableBoolean(candidate.isMainPersonality);
  const isAlly = toNullableBoolean(candidate.isAlly);
  const style = asNonEmptyString(candidate.style);
  const text = asNonEmptyString(candidate.cardTextRaw)?.toLowerCase() ?? "";
  const personalityLevel = toNullableInt(candidate.personalityLevel);
  const powerStageValues = toIntArray(candidate.powerStageValues);
  const hasPersonalityStats = powerStageValues.length > 0 || toNullableInt(candidate.pur) !== null;
  const isPersonalityCard = cardType === "personality" || isMainPersonality === true || isAlly === true;

  if (cardType && cardType !== "personality" && personalityLevel !== null) {
    failedFields.push("personalityLevel");
    reasons.push("type_conflict:personalityLevel");
  }

  if (cardType && cardType !== "personality" && hasPersonalityStats && personalityLevel === null) {
    failedFields.push("powerStageValues", "pur");
    reasons.push("type_conflict:personalityStats");
  }

  if (isMainPersonality === true) {
    if (cardType && cardType !== "personality") {
      failedFields.push("cardType", "isMainPersonality");
      reasons.push("type_conflict:is_main_personality_non_personality_type");
    }
    const hasMainEvidence = personalityLevel !== null || /\blv\.\s*[1-4]\b/.test(text) || /\bmain personality\b/.test(text);
    if (!hasMainEvidence) {
      failedFields.push("cardType", "personalityLevel");
      reasons.push("type_conflict:personality_without_main_evidence");
    }
  }

  if (isPersonalityCard && (powerStageValues.length < 4 || !powerStageValues.includes(0))) {
    failedFields.push("powerStageValues");
    reasons.push("type_conflict:missing_power_stage_ladder");
  }
  if (/\bendurance\b/.test(text) && toNullableInt(candidate.endurance) === null) {
    failedFields.push("endurance");
    reasons.push("missing_endurance_value");
  }

  if (
    style &&
    cardType &&
    ["personality", "dragon_ball"].includes(cardType) &&
    !text.includes(`${style} style`) &&
    !text.includes(`${style} mastery`)
  ) {
    failedFields.push("style");
    reasons.push("style_type_conflict");
  }

  if (isAlly === true && cardType && cardType !== "personality") {
    failedFields.push("cardType", "isAlly");
    reasons.push("type_conflict:ally_flag_non_ally_type");
  }
  if (isMainPersonality === true && isAlly === true) {
    failedFields.push("isMainPersonality", "isAlly");
    reasons.push("type_conflict:ally_and_main_personality");
  }
  if (isPersonalityCard && (!affiliation || affiliation === "unknown")) {
    failedFields.push("affiliation");
    reasons.push("affiliation_missing_for_personality_or_ally");
  }

  return {
    failedFields: Array.from(new Set(failedFields)),
    reasons: Array.from(new Set(reasons))
  };
}

function inferRarityPrefixFromPrintedNumber(printedNumber: string | null): string | null {
  if (!printedNumber) {
    return null;
  }
  const normalized = printedNumber.toUpperCase();
  if (/^UR\d/.test(normalized)) {
    return "UR";
  }
  if (/^DR\d/.test(normalized)) {
    return "DR";
  }
  if (/^C\d/.test(normalized)) {
    return "C";
  }
  if (/^U\d/.test(normalized)) {
    return "U";
  }
  if (/^R\d/.test(normalized)) {
    return "R";
  }
  if (/^S\d/.test(normalized)) {
    return "S";
  }
  if (/^P\d/.test(normalized)) {
    return "P";
  }
  return "UNK";
}

function extractRawWarnings(candidate: Record<string, unknown>): string[] {
  const raw = candidate.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  const warnings = (raw as Record<string, unknown>).warnings;
  if (!Array.isArray(warnings)) {
    return [];
  }
  return warnings.filter((warning): warning is string => typeof warning === "string");
}

function toNumberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const map: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "number" || Number.isNaN(entry)) {
      continue;
    }
    map[key] = clamp01(entry);
  }
  return map;
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

function normalizeLegacyCardTypeFields(candidate: Record<string, unknown>): void {
  const cardType = asNonEmptyString(candidate.cardType)?.toLowerCase().replace(/\s+/g, "_");
  if (cardType === "main_personality" || cardType === "ally") {
    candidate.cardType = "personality";
  }

  if (cardType === "ally" && typeof candidate.isAlly !== "boolean") {
    candidate.isAlly = true;
  }

  if (typeof candidate.isMainPersonality !== "boolean") {
    if (cardType === "main_personality") {
      candidate.isMainPersonality = true;
    } else if (cardType === "ally") {
      candidate.isMainPersonality = false;
    }
  }
}

function toNullableBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

function normalizeAttachLimit(value: unknown): number | "infinity" | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "infinity") {
      return "infinity";
    }
    const parsed = Number(normalized);
    if (Number.isInteger(parsed) && parsed >= 1) {
      return parsed;
    }
    return null;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  return null;
}

function toIntArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry >= 0);
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
