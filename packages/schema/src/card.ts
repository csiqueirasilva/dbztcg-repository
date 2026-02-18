import { z } from "zod";
import {
  CardAffiliationSchema,
  CardStyleSchema,
  type CardType,
  CardTypeSchema,
  EffectChunkKindSchema,
  RarityPrefixSchema,
  ReviewReasonSchema,
  SetCodeSchema
} from "./enums.js";

export const CardIconSchema = z.object({
  isAttack: z.boolean().default(false),
  isDefense: z.boolean().default(false),
  isQuick: z.boolean().default(false),
  isConstant: z.boolean().default(false),
  rawIconEvidence: z.array(z.string()).default([])
});
export type CardIcon = z.infer<typeof CardIconSchema>;

export const CardEffectChunkSchema = z.object({
  kind: EffectChunkKindSchema,
  text: z.string().min(1),
  keywords: z.array(z.string()).default([])
});
export type CardEffectChunk = z.infer<typeof CardEffectChunkSchema>;

export const CardSourceSchema = z.object({
  imagePath: z.string().min(1),
  imageFileName: z.string().min(1),
  sourceUrl: z.string().url().nullable().default(null)
});
export type CardSource = z.infer<typeof CardSourceSchema>;

export const CardConfidenceSchema = z.object({
  overall: z.number().min(0).max(1),
  fields: z.record(z.number().min(0).max(1)).default({})
});
export type CardConfidence = z.infer<typeof CardConfidenceSchema>;

export const CardReviewSchema = z.object({
  required: z.boolean(),
  reasons: z.array(ReviewReasonSchema.or(z.string())).default([]),
  notes: z.array(z.string()).default([])
});
export type CardReview = z.infer<typeof CardReviewSchema>;

export const CardRawSchema = z.object({
  ocrText: z.string().default(""),
  ocrBlocks: z
    .array(
      z.object({
        text: z.string().min(1),
        confidence: z.number().min(0).max(1).optional(),
        bbox: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number()
          })
          .optional()
      })
    )
    .default([]),
  llmRawJson: z.string().optional(),
  warnings: z.array(z.string()).default([])
});
export type CardRaw = z.infer<typeof CardRawSchema>;

const LIMIT_ONE_CARD_TYPES = new Set<CardType>(["personality", "mastery", "dragon_ball"]);
const EXTRAORDINARY_PLAY_FROM_HAND_TYPES = new Set<CardType>(["setup", "drill", "dragon_ball"]);
const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10
};
const VALUE_TOKEN_PATTERN = "(\\d+|x|one|two|three|four|five|six|seven|eight|nine|ten)";
const DEFAULT_ATTACH_LIMIT = "infinity" as const;
type AttachLimit = number | typeof DEFAULT_ATTACH_LIMIT;

const REJUVENATE_PATTERNS = [
  new RegExp(`\\brejuvenate(?:\\s+the\\s+top)?\\s+${VALUE_TOKEN_PATTERN}\\b`, "i"),
  new RegExp(`\\brejuvenate\\s+up\\s+to\\s+${VALUE_TOKEN_PATTERN}\\b`, "i")
];
const ENDURANCE_PATTERNS = [new RegExp(`\\bendurance\\s+${VALUE_TOKEN_PATTERN}\\b`, "i")];
const RAISE_YOUR_ANGER_PATTERNS = [
  new RegExp(`\\braise\\s+your\\s+anger\\s+${VALUE_TOKEN_PATTERN}(?:\\s+levels?)?\\b`, "i")
];
const LOWER_YOUR_ANGER_PATTERNS = [
  new RegExp(`\\blower\\s+your\\s+anger\\s+${VALUE_TOKEN_PATTERN}(?:\\s+levels?)?\\b`, "i")
];
const RAISE_OR_LOWER_ANY_PLAYER_ANGER_PATTERNS = [
  new RegExp(
    `\\braise\\s+or\\s+lower\\s+(?:a|any)\\s+player'?s\\s+anger\\s+${VALUE_TOKEN_PATTERN}(?:\\s+levels?)?\\b`,
    "i"
  )
];

/**
 * Field semantics and derivation rules:
 * docs/card-schema.md
 */
export const CardSchema = z
  .object({
    id: z.string().regex(/^[A-Z]{3}-[A-Za-z0-9][A-Za-z0-9._-]*$/),
    setCode: SetCodeSchema,
    setName: z.string().min(1),
    printedNumber: z.string().regex(/^[A-Z]{1,3}\d{1,4}[A-Za-z0-9.-]*$/),
    rarityPrefix: RarityPrefixSchema,
    name: z.string().min(1),
    title: z.string().nullable().default(null),
    characterKey: z.string().min(1).nullable().default(null),
    personalityFamilyId: z.string().min(1).nullable().default(null),
    cardType: CardTypeSchema,
    affiliation: CardAffiliationSchema.default("unknown"),
    isMainPersonality: z.boolean().default(false),
    isAlly: z.boolean().default(false),
    cardSubtypes: z.array(z.string()).default([]),
    style: CardStyleSchema.nullable().default(null),
    icons: CardIconSchema.default({
      isAttack: false,
      isDefense: false,
      isQuick: false,
      isConstant: false,
      rawIconEvidence: []
    }),
    tags: z.array(z.string()).default([]),
    powerStageValues: z.array(z.number().int().min(0)).default([]),
    pur: z.number().int().min(0).nullable().default(null),
    endurance: z.number().int().min(0).nullable().default(null),
    personalityLevel: z.number().int().min(1).max(4).nullable().default(null),
    mainPowerText: z.string().nullable().default(null),
    cardTextRaw: z.string().min(1),
    considered_as_styled_card: z.boolean().nullish(),
    limit_per_deck: z.number().int().min(1).nullish(),
    banished_after_use: z.boolean().nullish(),
    shuffle_into_deck_after_use: z.boolean().nullish(),
    drill_not_discarded_when_changing_levels: z.boolean().nullish(),
    attach_limit: z.union([z.number().int().min(1), z.literal(DEFAULT_ATTACH_LIMIT)]).nullish(),
    extraordinary_can_play_from_hand: z.boolean().nullish(),
    has_effect_when_discarded_combat: z.boolean().nullish(),
    seaches_owner_life_deck: z.boolean().nullish(),
    rejuvenates_amount: z.number().int().min(0).nullish(),
    conditional_rejuvenate: z.boolean().nullish(),
    conditional_endurance: z.boolean().nullish(),
    raise_your_anger: z.number().int().min(0).nullish(),
    conditional_raise_your_anger: z.boolean().nullish(),
    lower_your_anger: z.number().int().min(0).nullish(),
    conditional_lower_your_anger: z.boolean().nullish(),
    raise_or_lower_any_player_anger: z.number().int().min(0).nullish(),
    conditional_raise_or_lower_any_player_anger: z.boolean().nullish(),
    when_drill_enters_play_during_combat: z.boolean().nullish(),
    when_drill_enters_play: z.boolean().nullish(),
    attaches_own_main_personality: z.boolean().nullish(),
    attaches_opponent_main_personality: z.boolean().nullish(),
    effectChunks: z.array(CardEffectChunkSchema).default([]),
    source: CardSourceSchema,
    confidence: CardConfidenceSchema,
    review: CardReviewSchema,
    raw: CardRawSchema
  })
  .strict()
  .transform((card) => {
    const signalText = buildMetadataSignalText(card.cardTextRaw, card.mainPowerText);
    const explicitEnduranceAmount = shouldDiscardExplicitEnduranceZero(
      card.endurance,
      card.conditional_endurance,
      signalText
    )
      ? null
      : card.endurance;
    const rejuvenate = resolveNumericAmountWithConditional({
      explicitAmount: card.rejuvenates_amount,
      explicitConditional: card.conditional_rejuvenate,
      text: signalText,
      patterns: REJUVENATE_PATTERNS
    });
    const endurance = resolveNumericAmountWithConditional({
      explicitAmount: explicitEnduranceAmount,
      explicitConditional: card.conditional_endurance,
      text: signalText,
      patterns: ENDURANCE_PATTERNS
    });
    const raiseYourAnger = resolveNumericAmountWithConditional({
      explicitAmount: card.raise_your_anger,
      explicitConditional: card.conditional_raise_your_anger,
      text: signalText,
      patterns: RAISE_YOUR_ANGER_PATTERNS
    });
    const lowerYourAnger = resolveNumericAmountWithConditional({
      explicitAmount: card.lower_your_anger,
      explicitConditional: card.conditional_lower_your_anger,
      text: signalText,
      patterns: LOWER_YOUR_ANGER_PATTERNS
    });
    const raiseOrLowerAnyPlayerAnger = resolveNumericAmountWithConditional({
      explicitAmount: card.raise_or_lower_any_player_anger,
      explicitConditional: card.conditional_raise_or_lower_any_player_anger,
      text: signalText,
      patterns: RAISE_OR_LOWER_ANY_PLAYER_ANGER_PATTERNS
    });
    const drillEnterPlayFlags = resolveDrillEnterPlayFlags({
      explicitDuringCombat: card.when_drill_enters_play_during_combat,
      explicitAnyCombat: card.when_drill_enters_play,
      cardType: card.cardType,
      text: signalText
    });

    return {
      ...card,
      considered_as_styled_card:
        normalizeBoolean(card.considered_as_styled_card) ?? detectConsideredAsStyledCard(signalText),
      limit_per_deck: resolveLimitPerDeck(card.limit_per_deck, card.cardType, signalText),
      banished_after_use: normalizeBoolean(card.banished_after_use) ?? detectBanishedAfterUse(signalText),
      shuffle_into_deck_after_use:
        normalizeBoolean(card.shuffle_into_deck_after_use) ?? detectShuffleIntoDeckAfterUse(signalText),
      drill_not_discarded_when_changing_levels:
        normalizeBoolean(card.drill_not_discarded_when_changing_levels) ??
        detectDrillNotDiscardedWhenChangingLevels(card.cardType, signalText),
      attach_limit: resolveAttachLimit(card.attach_limit, signalText),
      extraordinary_can_play_from_hand:
        normalizeBoolean(card.extraordinary_can_play_from_hand) ??
        detectExtraordinaryCanPlayFromHand({
          cardType: card.cardType,
          isAlly: card.isAlly,
          text: signalText
        }),
      has_effect_when_discarded_combat:
        normalizeBoolean(card.has_effect_when_discarded_combat) ?? detectEffectWhenDiscardedDuringCombat(signalText),
      seaches_owner_life_deck:
        normalizeBoolean(card.seaches_owner_life_deck) ?? detectSearchesOwnerLifeDeck(signalText),
      rejuvenates_amount: rejuvenate.amount,
      conditional_rejuvenate: rejuvenate.conditional,
      endurance: endurance.amount,
      conditional_endurance: endurance.conditional,
      raise_your_anger: raiseYourAnger.amount,
      conditional_raise_your_anger: raiseYourAnger.conditional,
      lower_your_anger: lowerYourAnger.amount,
      conditional_lower_your_anger: lowerYourAnger.conditional,
      raise_or_lower_any_player_anger: raiseOrLowerAnyPlayerAnger.amount,
      conditional_raise_or_lower_any_player_anger: raiseOrLowerAnyPlayerAnger.conditional,
      when_drill_enters_play_during_combat: drillEnterPlayFlags.when_drill_enters_play_during_combat,
      when_drill_enters_play: drillEnterPlayFlags.when_drill_enters_play,
      attaches_own_main_personality:
        normalizeBoolean(card.attaches_own_main_personality) ?? detectAttachesOwnMainPersonality(signalText),
      attaches_opponent_main_personality:
        normalizeBoolean(card.attaches_opponent_main_personality) ?? detectAttachesOpponentMainPersonality(signalText)
    };
  });
export type Card = z.infer<typeof CardSchema>;

interface NumericAmountConditionalInput {
  explicitAmount: number | null | undefined;
  explicitConditional: boolean | null | undefined;
  text: string;
  patterns: RegExp[];
}

interface NumericAmountConditionalResult {
  amount: number | null;
  conditional: boolean;
}

function resolveLimitPerDeck(explicitLimit: number | null | undefined, cardType: CardType, cardTextRaw: string): number {
  const normalized = normalizeNullableNonNegativeInt(explicitLimit);
  if (normalized !== null && normalized >= 1) {
    return normalized;
  }
  const fromText = extractLimitPerDeckFromText(cardTextRaw);
  if (fromText !== null) {
    return fromText;
  }
  return LIMIT_ONE_CARD_TYPES.has(cardType) ? 1 : 3;
}

function resolveAttachLimit(explicitLimit: unknown, text: string): AttachLimit {
  const normalized = normalizeAttachLimit(explicitLimit);
  if (normalized !== null) {
    return normalized;
  }
  const fromText = extractAttachLimitFromText(text);
  if (fromText !== null) {
    return fromText;
  }
  return DEFAULT_ATTACH_LIMIT;
}

function resolveNumericAmountWithConditional(input: NumericAmountConditionalInput): NumericAmountConditionalResult {
  const explicitConditional = normalizeBoolean(input.explicitConditional);
  const explicitAmount = normalizeNullableNonNegativeInt(input.explicitAmount);
  if (explicitConditional !== null || explicitAmount !== null) {
    if (explicitConditional === true) {
      return {
        amount: explicitAmount ?? 0,
        conditional: true
      };
    }
    return {
      amount: explicitAmount,
      conditional: false
    };
  }

  const normalized = normalizeInstructionText(input.text);
  const clauses = splitIntoClauses(normalized);
  let discoveredAmount: number | null = null;
  let hasConditional = false;
  let hasMatch = false;

  for (const clause of clauses) {
    for (const pattern of input.patterns) {
      const match = clause.match(pattern);
      if (!match) {
        continue;
      }
      hasMatch = true;
      const token = match[1]?.trim() ?? "";
      const parsed = parseNumberToken(token);
      const conditionalFromToken = parsed === null;
      const conditionalFromClause = hasConditionalCue(clause);
      if (!conditionalFromToken && !conditionalFromClause && parsed !== null) {
        discoveredAmount = discoveredAmount === null ? parsed : Math.max(discoveredAmount, parsed);
      } else {
        hasConditional = true;
      }
    }
  }

  if (discoveredAmount !== null) {
    return {
      amount: discoveredAmount,
      conditional: hasConditional
    };
  }

  if (hasMatch || hasConditional) {
    return {
      amount: 0,
      conditional: true
    };
  }

  return {
    amount: null,
    conditional: false
  };
}

function resolveDrillEnterPlayFlags(input: {
  explicitDuringCombat: boolean | null | undefined;
  explicitAnyCombat: boolean | null | undefined;
  cardType: CardType;
  text: string;
}): { when_drill_enters_play_during_combat: boolean; when_drill_enters_play: boolean } {
  if (input.cardType !== "drill") {
    return {
      when_drill_enters_play_during_combat: false,
      when_drill_enters_play: false
    };
  }

  const normalized = normalizeInstructionText(input.text);
  const detectedDuringCombat = /\bwhen this drill enters play during combat\b/.test(normalized);
  const detectedAnyCombat = /\bwhen this drill enters play\b/.test(normalized) || detectedDuringCombat;

  const duringCombat = normalizeBoolean(input.explicitDuringCombat) ?? detectedDuringCombat;
  let anyCombat = normalizeBoolean(input.explicitAnyCombat) ?? detectedAnyCombat;
  if (duringCombat && !anyCombat) {
    anyCombat = true;
  }

  return {
    when_drill_enters_play_during_combat: duringCombat,
    when_drill_enters_play: anyCombat
  };
}

function extractLimitPerDeckFromText(text: string): number | null {
  const normalized = normalizeInstructionText(text);
  const match = normalized.match(
    /\blimit(?:ed)?(?:\s+to)?\s+(\d{1,2})(?:\s+(?:copy|copies|card|cards))?\s+per\s+deck\b/
  );
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
}

function extractAttachLimitFromText(text: string): AttachLimit | null {
  const normalized = normalizeInstructionText(text);
  const match = normalized.match(
    /\byou may only have\s+([a-z0-9-]+)(?:\s+"[^"]+")?(?:\s+(?:card|cards|drill|drills|ally|allies|setup|setups))?\s+attached\b/
  );
  if (!match) {
    return null;
  }
  const parsed = parseNumberToken(match[1]);
  if (parsed === null || parsed < 1) {
    return null;
  }
  return parsed;
}

function detectConsideredAsStyledCard(text: string): boolean {
  const normalized = normalizeInstructionText(text);
  return (
    /\bthis card is considered styled for your card effects\b/.test(normalized) ||
    /\bconsidered styled for your card effects\b/.test(normalized) ||
    /\bis considered styled\b/.test(normalized)
  );
}

function detectBanishedAfterUse(text: string): boolean {
  const normalized = normalizeInstructionText(text);
  return (
    /\bbanish(?:ed|es)?(?: this card)? after use\b/.test(normalized) ||
    /\bremoved? from the game(?: this card)? after use\b/.test(normalized)
  );
}

function detectShuffleIntoDeckAfterUse(text: string): boolean {
  const normalized = normalizeInstructionText(text);
  return /\bshuffle(?:s|d)?(?: this card)? into (?:the )?(?:owner'?s?|your|its) (?:life )?deck after use\b/.test(
    normalized
  );
}

function detectDrillNotDiscardedWhenChangingLevels(cardType: CardType, text: string): boolean {
  if (cardType !== "drill") {
    return false;
  }
  const normalized = normalizeInstructionText(text);
  return /\bthis drill is not discarded when changing levels?\b/.test(normalized);
}

function detectExtraordinaryCanPlayFromHand(input: { cardType: CardType; isAlly: boolean; text: string }): boolean {
  if (!input.isAlly && !EXTRAORDINARY_PLAY_FROM_HAND_TYPES.has(input.cardType)) {
    return false;
  }
  const normalized = normalizeInstructionText(input.text);
  return /\byou may play this card from your hand\b/.test(normalized);
}

function detectEffectWhenDiscardedDuringCombat(text: string): boolean {
  const normalized = normalizeInstructionText(text);
  return /\bif this card is discarded from your hand during combat\b/.test(normalized);
}

function detectSearchesOwnerLifeDeck(text: string): boolean {
  const normalized = normalizeInstructionText(text);
  return /\bsearch (?:your|owner'?s) life deck\b/.test(normalized);
}

function detectAttachesOwnMainPersonality(text: string): boolean {
  const normalized = normalizeInstructionText(text);
  return /\battach(?:es|ed)?(?: this card)? to your (?:mp|main personality)\b/.test(normalized);
}

function detectAttachesOpponentMainPersonality(text: string): boolean {
  const normalized = normalizeInstructionText(text);
  return /\battach(?:es|ed)?(?: this card)? to your opponent'?s (?:mp|main personality)\b/.test(normalized);
}

function normalizeAttachLimit(value: unknown): AttachLimit | null {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === DEFAULT_ATTACH_LIMIT) {
      return DEFAULT_ATTACH_LIMIT;
    }
    const parsed = parseNumberToken(normalized);
    if (parsed !== null && parsed >= 1) {
      return parsed;
    }
    return null;
  }

  const parsed = normalizeNullableNonNegativeInt(value);
  if (parsed !== null && parsed >= 1) {
    return parsed;
  }
  return null;
}

function shouldDiscardExplicitEnduranceZero(
  explicitAmount: unknown,
  explicitConditional: unknown,
  text: string
): boolean {
  const normalizedAmount = normalizeNullableNonNegativeInt(explicitAmount);
  if (normalizedAmount !== 0) {
    return false;
  }
  if (normalizeBoolean(explicitConditional) === true) {
    return false;
  }
  const normalizedText = normalizeInstructionText(text);
  return !/\bendurance\s*[:+-]?\s*0\b/.test(normalizedText);
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

function normalizeNullableNonNegativeInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function parseNumberToken(token: string | null | undefined): number | null {
  if (!token) {
    return null;
  }
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (/^\d+$/.test(normalized)) {
    const parsed = Number(normalized);
    return Number.isInteger(parsed) ? parsed : null;
  }
  if (normalized === "x") {
    return null;
  }
  if (normalized in NUMBER_WORDS) {
    return NUMBER_WORDS[normalized];
  }
  return null;
}

function hasConditionalCue(text: string): boolean {
  return /\b(?:if|when|whenever|after|before|during|unless|instead|if able)\b/.test(text);
}

function splitIntoClauses(normalizedText: string): string[] {
  return normalizedText
    .split(/[\n.;]+/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function buildMetadataSignalText(cardTextRaw: string, mainPowerText: string | null): string {
  const parts = [cardTextRaw, mainPowerText ?? ""]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return parts.join("\n");
}

function normalizeInstructionText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
