import type { CardAffiliation, CardType, RarityPrefix } from "@dbzccg/schema";
import type { DiscoveredImage, FilenamePriors, OcrResult, RulebookLexicon } from "../types.js";

export interface NormalizeCardInput {
  image: DiscoveredImage;
  priors: FilenamePriors;
  ocr: OcrResult;
  llmData: Record<string, unknown>;
  llmUsed: boolean;
  llmRawJson?: string;
  warnings: string[];
  lexicon: RulebookLexicon;
}

const NORMALIZED_STYLE_VALUES = [
  "black",
  "blue",
  "namekian",
  "orange",
  "red",
  "saiyan",
  "freestyle",
  "other",
  "unknown"
] as const;

const STYLE_ALIASES: Record<string, (typeof NORMALIZED_STYLE_VALUES)[number]> = {
  black: "black",
  blue: "blue",
  namek: "namekian",
  namekian: "namekian",
  orange: "orange",
  red: "red",
  saiyan: "saiyan",
  freestyle: "freestyle",
  "free style": "freestyle",
  other: "other",
  unknown: "unknown"
};

const NAMED_FREESTYLE_CARD_TYPES = new Set<CardType>([
  "physical_combat",
  "energy_combat",
  "event",
  "setup",
  "drill",
  "non_combat",
  "other",
  "unknown"
]);
const LIMIT_ONE_CARD_TYPES = new Set<CardType>(["personality", "mastery", "dragon_ball"]);

const NON_NAMED_OWNER_TOKENS = new Set<string>([
  "black",
  "blue",
  "namekian",
  "orange",
  "red",
  "saiyan",
  "freestyle",
  "heroes",
  "villains",
  "dragon",
  "mastery"
]);

const SUBTYPE_ALIASES: Record<string, string> = {
  noncombat: "non_combat",
  "non-combat": "non_combat",
  "non combat": "non_combat",
  mainpersonality: "personality",
  "main personality": "personality",
  heroes: "hero",
  "heroes only": "hero",
  "heroes-only": "hero",
  villains: "villain",
  "villains only": "villain",
  "villains-only": "villain",
  "non aligned": "neutral",
  "non-aligned": "neutral",
  nonaligned: "neutral",
  allyonly: "ally",
  "ally only": "ally",
  "ally-only": "ally",
  allies: "ally",
  hero: "hero",
  villain: "villain",
  neutral: "neutral",
  ally: "ally",
  villainous: "villain",
  heroic: "hero"
};

export function normalizeCardCandidate(input: NormalizeCardInput): Record<string, unknown> {
  const llmCardTextRaw = normalizedString(input.llmData.cardTextRaw);
  const normalizedOcrText = replaceInlineIconSymbols(input.ocr.text.trim());
  const text = replaceInlineIconSymbols(llmCardTextRaw ?? input.ocr.text.trim() ?? input.priors.nameGuess);
  const iconSignalText = buildIconSignalText(text, normalizedOcrText);
  const normalizedCardType = normalizeCardType(
    input.llmData.cardType,
    input.priors.cardTypeGuess,
    text,
    input.lexicon
  );
  const initialName = normalizeCardName(normalizedString(input.llmData.name) ?? input.priors.nameGuess);
  const initialTitle = normalizeCardTitle({
    llmTitle: normalizedNullableString(input.llmData.title),
    normalizedName: initialName,
    priorNameGuess: input.priors.nameGuess,
    personalityLevel: input.priors.personalityLevel
  });
  const provisionalCharacterKey = normalizeCharacterKey(
    normalizedNullableString(input.llmData.characterKey) ?? input.priors.characterKey ?? initialName
  );
  const refinedIdentity = refinePersonalityIdentity({
    cardType: normalizedCardType,
    initialName,
    initialTitle,
    priorNameGuess: input.priors.nameGuess,
    characterKey: provisionalCharacterKey
  });
  const normalizedName = refinedIdentity.name;
  const normalizedTitle = refinedIdentity.title;
  const normalizedCharacterKey = normalizeCharacterKey(
    normalizedNullableString(input.llmData.characterKey) ?? input.priors.characterKey ?? normalizedName
  );
  const normalizedStyle = normalizeStyle(input.llmData.style, input.priors.styleGuess, normalizedCardType, text);
  const normalizedSubtypes = normalizeCardSubtypes(input.llmData.cardSubtypes);
  const namedCardSignals = inferNamedCardSignals({
    cardType: normalizedCardType,
    normalizedName,
    priorNameGuess: input.priors.nameGuess,
    normalizedCharacterKey
  });
  const effectiveCharacterKey = namedCardSignals.namedCharacterKey ?? normalizedCharacterKey;
  const effectiveCardSubtypes = namedCardSignals.isNamed
    ? appendSubtype(normalizedSubtypes, "named")
    : normalizedSubtypes;
  const freestyleFromName = shouldDefaultFreestyleFromName(normalizedCardType, normalizedName);
  const effectiveStyle =
    normalizedStyle ?? (namedCardSignals.defaultFreestyle || freestyleFromName ? "freestyle" : null);
  const icons = normalizeIcons(input.llmData.icons, iconSignalText, input.lexicon);
  const baseTags = mergeTags(
    normalizeStringArray(input.llmData.tags),
    inferTagsFromText(iconSignalText, input.lexicon, icons)
  );
  const tags = normalizeTags(namedCardSignals.isNamed ? mergeTags(baseTags, ["named-card"]) : baseTags);
  const affiliation = normalizeAffiliation({
    rawAffiliation: input.llmData.affiliation,
    subtypes: effectiveCardSubtypes,
    tags,
    text,
    lexicon: input.lexicon
  });
  const isAlly = normalizeIsAlly({
    rawCardType: input.llmData.cardType,
    rawIsAlly: input.llmData.isAlly,
    cardType: normalizedCardType,
    subtypes: effectiveCardSubtypes,
    tags,
    text,
    lexicon: input.lexicon
  });
  const isMainPersonality = normalizeIsMainPersonality({
    rawIsMainPersonality: input.llmData.isMainPersonality,
    rawCardType: input.llmData.cardType,
    cardType: normalizedCardType,
    isAlly,
    text,
    priorPersonalityLevel: input.priors.personalityLevel
  });
  const powerStageValues = normalizePowerStageValues(
    input.llmData.powerStageValues,
    text,
    normalizedCardType,
    isAlly,
    input.priors.personalityLevel,
    isMainPersonality
  );

  return {
    setCode: input.image.setCode,
    setName: input.image.setName,
    printedNumber: input.priors.printedNumber,
    rarityPrefix: normalizeRarityPrefix(input.priors.rarityPrefix),
    name: normalizedName,
    title: normalizedTitle,
    characterKey: effectiveCharacterKey,
    personalityFamilyId: buildPersonalityFamilyId(input.image.setCode, effectiveCharacterKey),
    cardType: normalizedCardType,
    affiliation,
    isMainPersonality,
    isAlly,
    cardSubtypes: effectiveCardSubtypes,
    style: effectiveStyle,
    icons,
    tags,
    powerStageValues,
    pur: normalizeNullableInt(input.llmData.pur),
    endurance: normalizeEndurance(input.llmData.endurance, text),
    personalityLevel: normalizeNullableInt(input.llmData.personalityLevel),
    mainPowerText: normalizeMainPowerText(input.llmData.mainPowerText, text),
    cardTextRaw: text.length > 0 ? text : input.priors.nameGuess,
    considered_as_styled_card: normalizeConsideredAsStyledCard(
      input.llmData.considered_as_styled_card ?? input.llmData.consideredAsStyledCard,
      text
    ),
    limit_per_deck: normalizeLimitPerDeck(
      input.llmData.limit_per_deck ?? input.llmData.limitPerDeck,
      text,
      normalizedCardType
    ),
    banished_after_use: normalizeBanishedAfterUse(
      input.llmData.banished_after_use ?? input.llmData.banishedAfterUse,
      text
    ),
    shuffle_into_deck_after_use: normalizeShuffleIntoDeckAfterUse(
      input.llmData.shuffle_into_deck_after_use ?? input.llmData.shuffleIntoDeckAfterUse,
      text
    ),
    effectChunks: normalizeEffectChunks(input.llmData.effectChunks, text),
    source: {
      imagePath: input.image.imagePath,
      imageFileName: input.image.imageFileName,
      sourceUrl: null
    },
    raw: {
      ocrText: input.ocr.text,
      ocrBlocks: input.ocr.blocks,
      llmRawJson: input.llmRawJson,
      warnings: [...input.ocr.warnings, ...input.warnings]
    },
    _fieldConfidenceHint: normalizeFieldConfidenceHints(input.llmData.fieldConfidence),
    _llmUsed: input.llmUsed
  };
}

function normalizeCardType(rawValue: unknown, priorCardType: CardType, text: string, lexicon: RulebookLexicon): CardType {
  const normalized = normalizedString(rawValue)?.toLowerCase().replace(/\s+/g, "_");
  const allowed: CardType[] = [
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
  ];

  const aliased = normalized === "main_personality" || normalized === "ally" ? "personality" : normalized;

  if (aliased && allowed.includes(aliased as CardType)) {
    if (priorCardType === "personality" && aliased !== "personality") {
      return "personality";
    }
    if (aliased === "unknown" && priorCardType !== "unknown") {
      return priorCardType;
    }
    return aliased as CardType;
  }

  const lowerText = text.toLowerCase();
  if (/\bmain personality\b/.test(lowerText) || /\blv\.\s*[1-4]\b/.test(lowerText)) {
    return "personality";
  }
  if (/\bmastery\b/.test(lowerText)) {
    return "mastery";
  }
  if (/\bdragon ball\b/.test(lowerText)) {
    return "dragon_ball";
  }
  if (/\bdrill\b/.test(lowerText)) {
    return "drill";
  }
  if (lexicon.cardTypes.some((value) => lowerText.includes(value) && value.includes("event"))) {
    return "event";
  }

  return priorCardType;
}

function normalizeStyle(rawValue: unknown, priorStyle: string | null, cardType: CardType, text: string): string | null {
  const normalized = normalizeStyleToken(rawValue) ?? normalizeStyleToken(priorStyle);
  if (!normalized) {
    return null;
  }

  if (!isStyleApplicableToType(normalized, cardType, text)) {
    return null;
  }

  return normalized;
}

function normalizeRarityPrefix(value: string): RarityPrefix {
  const normalized = value.toUpperCase();
  const allowed = new Set<RarityPrefix>(["C", "U", "R", "UR", "P", "DR", "S", "UNK"]);
  return allowed.has(normalized as RarityPrefix) ? (normalized as RarityPrefix) : "UNK";
}

function normalizeIcons(rawValue: unknown, text: string, _lexicon: RulebookLexicon): {
  isAttack: boolean;
  isDefense: boolean;
  isQuick: boolean;
  isConstant: boolean;
  rawIconEvidence: string[];
} {
  void rawValue;
  const attackEvidence = findContextualIconEvidence(text, ["[attack icon]"], "[attack icon]");
  const defenseEvidence = findContextualIconEvidence(text, ["[defense icon]"], "[defense icon]");
  const quickEvidence = findContextualIconEvidence(text, ["[timing icon]", "[quick icon]"], "[timing icon]");
  const constantEvidence = findContextualIconEvidence(text, ["[constant icon]"], "[constant icon]");

  return {
    isAttack: attackEvidence.length > 0,
    isDefense: defenseEvidence.length > 0,
    isQuick: quickEvidence.length > 0,
    isConstant: constantEvidence.length > 0,
    rawIconEvidence: Array.from(
      new Set([...attackEvidence, ...defenseEvidence, ...quickEvidence, ...constantEvidence])
    )
  };
}

function findContextualIconEvidence(text: string, markers: string[], canonicalMarker: string): string[] {
  const normalizedText = text.toLowerCase();
  for (const marker of markers) {
    let cursor = normalizedText.indexOf(marker);
    while (cursor >= 0) {
      const context = extractMarkerContext(normalizedText, cursor, marker.length);
      if (isLikelyCardIconContext(context)) {
        return [`text-marker:${canonicalMarker}`];
      }
      cursor = normalizedText.indexOf(marker, cursor + marker.length);
    }
  }
  return [];
}

interface MarkerContext {
  line: string;
  prefix: string;
  suffix: string;
}

function extractMarkerContext(text: string, markerOffset: number, markerLength: number): MarkerContext {
  const lineStart = text.lastIndexOf("\n", markerOffset) + 1;
  const lineEnd = text.indexOf("\n", markerOffset);
  const normalizedLineEnd = lineEnd >= 0 ? lineEnd : text.length;
  const line = text.slice(lineStart, normalizedLineEnd).trim();
  const markerOffsetInLine = markerOffset - lineStart;
  const prefix = line.slice(0, Math.max(0, markerOffsetInLine)).trim();
  const suffix = line.slice(Math.max(0, markerOffsetInLine + markerLength)).trim();
  return { line, prefix, suffix };
}

function isLikelyCardIconContext(context: MarkerContext): boolean {
  let score = 0;
  const prefix = context.prefix;
  const suffix = context.suffix;
  const line = context.line;

  if (!prefix || /^[("'\[]+$/.test(prefix)) {
    score += 3;
  }
  if (/\b(?:power|hit|damage)\s*:\s*$/.test(prefix)) {
    score += 2;
  }
  if (
    /^(?::|-|power\b|physical attack\b|energy attack\b|stops?\b|use\b|when\b|if\b|prevent\b|reduce\b|your\b)/.test(
      suffix
    )
  ) {
    score += 2;
  }
  if (/(^|\s)(physical|energy)\s+attack\b/.test(suffix)) {
    score += 2;
  }

  if (/^cards?\b/.test(suffix)) {
    score -= 3;
  }
  if (/\bstyled\s*$/.test(prefix) && /^cards?\b/.test(suffix)) {
    score -= 3;
  }
  if (/\b(?:a|an|any)\s*(?:styled)?\s*$/.test(prefix) && /^cards?\b/.test(suffix)) {
    score -= 2;
  }
  if (/\bcards have different icons\b/.test(line) || /\bhow \[attack icon\] and \[defense icon\] cards work\b/.test(line)) {
    score -= 4;
  }

  return score >= 2;
}

function normalizeAffiliation(input: {
  rawAffiliation: unknown;
  subtypes: string[];
  tags: string[];
  text: string;
  lexicon: RulebookLexicon;
}): CardAffiliation {
  const affinitySet = new Set<string>();
  const direct = normalizedString(input.rawAffiliation)?.toLowerCase();
  if (direct) {
    affinitySet.add(direct);
  }

  for (const token of input.subtypes) {
    affinitySet.add(token.toLowerCase());
  }
  for (const tag of input.tags) {
    affinitySet.add(tag.toLowerCase());
  }

  const lowered = input.text.toLowerCase();
  if (/\bheroes?\s+only\b/.test(lowered)) {
    affinitySet.add("heroes only");
  }
  if (/\bvillains?\s+only\b/.test(lowered)) {
    affinitySet.add("villains only");
  }
  if (/\bheroic\b/.test(lowered)) {
    affinitySet.add("heroic");
  }
  if (/\bvillainous\b/.test(lowered)) {
    affinitySet.add("villainous");
  }

  const hasHero = hasAnyAffiliationToken(affinitySet, input.lexicon.affiliationKeywords.hero, [
    "hero",
    "heroes",
    "heroes only",
    "heroic",
    "hero-only"
  ]);
  const hasVillain = hasAnyAffiliationToken(affinitySet, input.lexicon.affiliationKeywords.villain, [
    "villain",
    "villains",
    "villains only",
    "villainous",
    "villain-only"
  ]);
  const hasNeutral = hasAnyAffiliationToken(affinitySet, input.lexicon.affiliationKeywords.neutral, [
    "neutral",
    "non-aligned",
    "non aligned",
    "unaligned"
  ]);

  if (hasHero && !hasVillain) {
    return "hero";
  }
  if (hasVillain && !hasHero) {
    return "villain";
  }
  if (hasNeutral && !hasHero && !hasVillain) {
    return "neutral";
  }
  return "unknown";
}

function normalizeIsAlly(input: {
  rawCardType: unknown;
  rawIsAlly: unknown;
  cardType: CardType;
  subtypes: string[];
  tags: string[];
  text: string;
  lexicon: RulebookLexicon;
}): boolean {
  if (typeof input.rawIsAlly === "boolean") {
    return input.rawIsAlly;
  }

  const rawCardType = normalizedString(input.rawCardType)?.toLowerCase().replace(/\s+/g, "_");
  if (rawCardType === "ally") {
    return true;
  }

  const loweredSubtypes = input.subtypes.map((value) => value.toLowerCase());
  const loweredTags = input.tags.map((value) => value.toLowerCase());
  if (loweredSubtypes.some((value) => value === "ally")) {
    return true;
  }
  if (
    loweredTags.some(
      (value) =>
        value === "ally" ||
        value.startsWith("ally-") ||
        value.endsWith("-ally") ||
        value.includes("ally-only") ||
        value.includes("allies")
    )
  ) {
    return true;
  }

  const loweredText = input.text.toLowerCase();
  if (input.lexicon.allyKeywords.some((keyword) => loweredText.includes(keyword.toLowerCase()))) {
    return true;
  }
  if (/\bheroes?\s+only\b/.test(loweredText) || /\bvillains?\s+only\b/.test(loweredText)) {
    if (input.cardType === "personality" && !/\blv\.\s*[1-4]\b/.test(loweredText)) {
      return true;
    }
  }

  return /\bally\b/.test(loweredText);
}

function normalizeIsMainPersonality(input: {
  rawIsMainPersonality: unknown;
  rawCardType: unknown;
  cardType: CardType;
  isAlly: boolean;
  text: string;
  priorPersonalityLevel: number | null;
}): boolean {
  const normalizedRawType = normalizedString(input.rawCardType)?.toLowerCase().replace(/\s+/g, "_");
  if (typeof input.rawIsMainPersonality === "boolean") {
    return input.rawIsMainPersonality && !input.isAlly;
  }

  if (normalizedRawType === "ally") {
    return false;
  }

  if (input.cardType !== "personality" || input.isAlly) {
    return false;
  }

  const loweredText = input.text.toLowerCase();
  const hasMainEvidence =
    input.priorPersonalityLevel !== null ||
    /\blv\.\s*[1-4]\b/.test(loweredText) ||
    /\blevel\s*[1-4]\b/.test(loweredText) ||
    /\bmain personality\b/.test(loweredText);

  if (normalizedRawType === "main_personality" || normalizedRawType === "personality") {
    return true;
  }

  return hasMainEvidence;
}

function hasAnyAffiliationToken(tokenPool: Set<string>, primary: string[], fallback: string[]): boolean {
  const merged = [...primary, ...fallback].map((value) => value.toLowerCase());
  return merged.some((value) => {
    if (tokenPool.has(value)) {
      return true;
    }
    const normalized = value.replace(/\s+/g, "-");
    return tokenPool.has(normalized) || tokenPool.has(normalized.replace(/-/g, " "));
  });
}

function normalizeEffectChunks(rawValue: unknown, text: string): Array<{ kind: string; text: string; keywords: string[] }> {
  if (Array.isArray(rawValue)) {
    const normalizedChunks = rawValue
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return null;
        }
        const candidate = entry as Record<string, unknown>;
        const chunkText = normalizedString(candidate.text);
        if (!chunkText) {
          return null;
        }
        return {
          kind: normalizeEffectChunkKind(candidate.kind, chunkText),
          text: chunkText,
          keywords: normalizeTags(normalizeStringArray(candidate.keywords))
        };
      })
      .filter((entry): entry is { kind: string; text: string; keywords: string[] } => entry !== null);

    if (normalizedChunks.length > 0) {
      return normalizedChunks;
    }
  }

  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 12)
    .map((line) => ({
      kind: normalizeEffectChunkKind("other", line),
      text: line,
      keywords: []
    }));
}

function normalizeFieldConfidenceHints(rawValue: unknown): Record<string, number> {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return {};
  }

  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawValue as Record<string, unknown>)) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      continue;
    }
    result[key] = Math.max(0, Math.min(1, value));
  }
  return result;
}

function inferTagsFromText(
  text: string,
  lexicon: RulebookLexicon,
  icons: { isAttack: boolean; isDefense: boolean; isQuick: boolean; isConstant: boolean }
): string[] {
  const lowered = text.toLowerCase();
  const tags: string[] = [];

  if (icons.isAttack) {
    tags.push("attack-icon");
  }
  if (icons.isDefense) {
    tags.push("defense-icon");
  }
  if (icons.isQuick) {
    tags.push("quick-icon");
  }
  if (icons.isConstant) {
    tags.push("constant-icon");
  }
  if (/\bendurance\b/.test(lowered)) {
    tags.push("endurance");
  }

  for (const keyword of lexicon.keywords) {
    if (keyword.length > 3 && lowered.includes(keyword)) {
      tags.push(`keyword:${keyword}`);
    }
  }

  return tags;
}

function mergeTags(primary: string[], secondary: string[]): string[] {
  return Array.from(new Set([...primary, ...secondary])).filter((item) => item.length > 0);
}

function normalizeCardName(rawName: string): string {
  const withoutLevel = rawName.replace(/\bLv\.\s*[1-4]\b/gi, "").replace(/\s+/g, " ").trim();
  const cleaned = withoutLevel.replace(/\s*[-:]\s*$/, "").trim();
  return cleaned.length > 0 ? cleaned : rawName;
}

function normalizeCardTitle(input: {
  llmTitle: string | null;
  normalizedName: string;
  priorNameGuess: string;
  personalityLevel: number | null;
}): string | null {
  const cleanedTitle = input.llmTitle
    ?.replace(/\bLv\.\s*[1-4]\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleanedTitle && cleanedTitle.length > 0) {
    return cleanedTitle;
  }

  if (input.personalityLevel === null) {
    return null;
  }

  const priorNoLevel = input.priorNameGuess.replace(/\bLv\.\s*[1-4]\b/gi, "").trim();
  if (!priorNoLevel) {
    return null;
  }

  const priorWords = priorNoLevel.split(/\s+/);
  if (priorWords.length < 2) {
    return null;
  }

  const normalizedNameWords = input.normalizedName.split(/\s+/);
  if (normalizedNameWords.length === 0) {
    return null;
  }

  const suffix = priorWords.slice(normalizedNameWords.length).join(" ").trim();
  return suffix.length > 0 ? suffix : null;
}

function refinePersonalityIdentity(input: {
  cardType: CardType;
  initialName: string;
  initialTitle: string | null;
  priorNameGuess: string;
  characterKey: string | null;
}): { name: string; title: string | null } {
  if (input.cardType !== "personality") {
    return {
      name: input.initialName,
      title: input.initialTitle
    };
  }

  if (input.initialTitle) {
    return {
      name: input.initialName,
      title: input.initialTitle
    };
  }

  const priorNoLevel = input.priorNameGuess
    .replace(/\bLv\.\s*[1-4]\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!priorNoLevel) {
    return {
      name: input.initialName,
      title: null
    };
  }

  const priorWords = priorNoLevel.split(/\s+/);
  if (priorWords.length < 2) {
    return {
      name: input.initialName,
      title: null
    };
  }

  const keyWords = input.characterKey ? input.characterKey.split("-").filter((word) => word.length > 0) : [];
  if (keyWords.length > 0 && priorWords.length > keyWords.length) {
    const lowerPriorWords = priorWords.map((word) => word.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const matchesCharacter = keyWords.every((word, index) => lowerPriorWords[index] === word);
    if (matchesCharacter) {
      const name = priorWords.slice(0, keyWords.length).join(" ").trim();
      const title = priorWords.slice(keyWords.length).join(" ").trim();
      if (name.length > 0 && title.length > 0) {
        return { name, title };
      }
    }
  }

  if (input.initialName.split(/\s+/).length >= 3) {
    const words = input.initialName.split(/\s+/);
    const fallbackName = words.slice(0, words.length - 1).join(" ");
    const fallbackTitle = words[words.length - 1];
    if (fallbackName.length > 0 && fallbackTitle.length > 0) {
      return { name: fallbackName, title: fallbackTitle };
    }
  }

  return {
    name: input.initialName,
    title: null
  };
}

function normalizeCharacterKey(rawValue: string | null): string | null {
  if (!rawValue) {
    return null;
  }

  const normalized = rawValue
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  return normalized.length > 0 ? normalized : null;
}

function normalizeCardSubtypes(rawValue: unknown): string[] {
  return Array.from(
    new Set(
      normalizeStringArray(rawValue)
        .map((entry) => entry.toLowerCase())
        .map((entry) => SUBTYPE_ALIASES[entry] ?? entry)
        .map((entry) =>
          entry
            .replace(/[^a-z0-9\s_-]+/g, "")
            .replace(/\s+/g, "_")
            .replace(/_+/g, "_")
            .replace(/^_+|_+$/g, "")
        )
        .filter((entry) => entry.length > 0)
    )
  );
}

function inferNamedCardSignals(input: {
  cardType: CardType;
  normalizedName: string;
  priorNameGuess: string;
  normalizedCharacterKey: string | null;
}): { isNamed: boolean; namedCharacterKey: string | null; defaultFreestyle: boolean } {
  if (input.cardType === "personality" || input.cardType === "dragon_ball") {
    return { isNamed: false, namedCharacterKey: null, defaultFreestyle: false };
  }

  const ownerFromName = extractNamedOwnerKey(input.normalizedName, input.normalizedCharacterKey);
  const ownerFromPrior = extractNamedOwnerKey(input.priorNameGuess, input.normalizedCharacterKey);
  const namedCharacterKey = ownerFromName ?? ownerFromPrior;
  if (!namedCharacterKey) {
    return { isNamed: false, namedCharacterKey: null, defaultFreestyle: false };
  }

  return {
    isNamed: true,
    namedCharacterKey,
    defaultFreestyle: NAMED_FREESTYLE_CARD_TYPES.has(input.cardType)
  };
}

function shouldDefaultFreestyleFromName(cardType: CardType, normalizedName: string): boolean {
  if (!NAMED_FREESTYLE_CARD_TYPES.has(cardType)) {
    return false;
  }
  const firstToken = normalizedName
    .split(/\s+/)[0]
    ?.toLowerCase()
    .replace(/[^a-z]/g, "");
  if (!firstToken) {
    return false;
  }
  if (STYLE_ALIASES[firstToken]) {
    return false;
  }
  return true;
}

function extractNamedOwnerKey(candidateName: string, currentCharacterKey: string | null): string | null {
  const normalizedCandidate = candidateName.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalizedCandidate) {
    return null;
  }

  const words = normalizedCandidate.split(" ").filter((entry) => entry.length > 0);
  if (words.length < 2) {
    return null;
  }

  const firstToken = words[0].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9'’.-]+$/g, "");
  if (!firstToken) {
    return null;
  }
  const lowerFirstToken = firstToken.toLowerCase();
  const normalizedCurrentKey = normalizeCharacterKey(currentCharacterKey);

  let ownerBaseToken: string | null = null;
  if (/(?:'|’|\u02bc)s$/i.test(firstToken)) {
    ownerBaseToken = firstToken.replace(/(?:'|’|\u02bc)s$/i, "");
  } else if (/s$/i.test(firstToken)) {
    const singular = firstToken.slice(0, -1);
    const normalizedSingular = normalizeCharacterKey(singular);
    if (normalizedSingular) {
      const normalizedPlural = normalizeCharacterKey(firstToken);
      const canUseSingular =
        normalizedCurrentKey === normalizedPlural ||
        normalizedCurrentKey === normalizedSingular ||
        words[1] === words[1]?.toUpperCase();
      if (canUseSingular) {
        ownerBaseToken = singular;
      }
    }
  }

  const ownerKey = normalizeCharacterKey(ownerBaseToken);
  if (!ownerKey || NON_NAMED_OWNER_TOKENS.has(ownerKey)) {
    return null;
  }
  return ownerKey;
}

function appendSubtype(subtypes: string[], subtype: string): string[] {
  if (subtypes.includes(subtype)) {
    return subtypes;
  }
  return [...subtypes, subtype];
}

function normalizeTags(tags: string[]): string[] {
  const ignored = new Set(["card", "dbz", "tcg", "dragonballz"]);
  return Array.from(
    new Set(
      tags
        .map((tag) => tag.toLowerCase())
        .map((tag) =>
          tag
            .replace(/[^a-z0-9\s:_-]+/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-+|-+$/g, "")
        )
        .filter((tag) => tag.length > 1 && !ignored.has(tag))
    )
  );
}

function normalizeMainPowerText(rawValue: unknown, cardTextRaw: string): string | null {
  const direct = normalizedNullableString(rawValue);
  if (direct && direct.length > 5) {
    return replaceInlineIconSymbols(direct.replace(/\s+/g, " ").trim());
  }

  const fromTextMatch = cardTextRaw.match(/(?:main personality power|power)\s*[:.-]\s*(.+)$/i);
  if (!fromTextMatch) {
    return null;
  }

  const extracted = replaceInlineIconSymbols(fromTextMatch[1].replace(/\s+/g, " ").trim());
  return extracted.length > 5 ? extracted : null;
}

function normalizePowerStageValues(
  rawValue: unknown,
  text: string,
  cardType: CardType,
  isAlly: boolean,
  priorPersonalityLevel: number | null,
  isMainPersonality: boolean
): number[] {
  const shouldTryExtract =
    cardType === "personality" || isMainPersonality || isAlly || priorPersonalityLevel !== null;
  if (!shouldTryExtract) {
    return [];
  }

  const fromArray = Array.isArray(rawValue)
    ? rawValue
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry >= 0)
    : [];
  if (fromArray.length > 0) {
    return normalizeStageSequence(fromArray);
  }

  const fromText = extractPowerStageValuesFromText(text);
  if (fromText.length > 0) {
    return normalizeStageSequence(fromText);
  }

  return [];
}

function extractPowerStageValuesFromText(text: string): number[] {
  const matches = text.match(/\b\d{1,3}(?:,\d{3})*\b/g) ?? [];
  const numbers = matches
    .map((value) => Number(value.replace(/,/g, "")))
    .filter((value) => Number.isInteger(value) && value >= 0);

  if (numbers.length === 0) {
    return [];
  }

  let best: number[] = [];
  for (let start = 0; start < numbers.length; start += 1) {
    const candidate = [numbers[start]];
    let previous = numbers[start];
    for (let index = start + 1; index < numbers.length; index += 1) {
      const current = numbers[index];
      if (current <= previous) {
        candidate.push(current);
        previous = current;
      }
      if (current === 0) {
        break;
      }
    }
    if (candidate.length > best.length) {
      best = candidate;
    }
  }

  return best;
}

function normalizeStageSequence(values: number[]): number[] {
  if (values.length === 0) {
    return [];
  }

  const normalized = values
    .map((value) => Math.trunc(value))
    .filter((value) => Number.isInteger(value) && value >= 0);

  if (normalized.length === 0) {
    return [];
  }

  const descending: number[] = [normalized[0]];
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

  return descending.filter((value, index) => index === 0 || value !== descending[index - 1]);
}

function normalizeEndurance(rawValue: unknown, text: string): number | null {
  const direct = normalizeNullableInt(rawValue);
  if (direct !== null && direct >= 0) {
    if (direct === 0 && !/\bendurance\s*[:+-]?\s*0\b/i.test(text)) {
      return null;
    }
    return direct;
  }

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

function normalizeConsideredAsStyledCard(rawValue: unknown, text: string): boolean {
  if (typeof rawValue === "boolean") {
    return rawValue;
  }
  return detectConsideredAsStyledCard(text);
}

function normalizeLimitPerDeck(rawValue: unknown, text: string, cardType: CardType): number {
  const direct = normalizeNullableInt(rawValue);
  if (direct !== null && direct >= 1) {
    return direct;
  }

  const fromText = extractLimitPerDeckFromText(text);
  if (fromText !== null) {
    return fromText;
  }

  return LIMIT_ONE_CARD_TYPES.has(cardType) ? 1 : 3;
}

function normalizeBanishedAfterUse(rawValue: unknown, text: string): boolean {
  if (typeof rawValue === "boolean") {
    return rawValue;
  }
  return detectBanishedAfterUse(text);
}

function normalizeShuffleIntoDeckAfterUse(rawValue: unknown, text: string): boolean {
  if (typeof rawValue === "boolean") {
    return rawValue;
  }
  return detectShuffleIntoDeckAfterUse(text);
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

function normalizeInstructionText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeEffectChunkKind(rawKind: unknown, text: string): string {
  const normalizedKind = normalizedString(rawKind)?.toLowerCase();
  const allowedKinds = new Set(["condition", "cost", "effect", "restriction", "timing", "other"]);
  if (normalizedKind && allowedKinds.has(normalizedKind)) {
    return normalizedKind;
  }

  const loweredText = text.toLowerCase();
  if (/\bif\b|\bwhen\b|\bwhenever\b/.test(loweredText)) {
    return "condition";
  }
  if (/\bdiscard\b|\bpay\b|\bcost\b/.test(loweredText)) {
    return "cost";
  }
  if (/\bcannot\b|\bcan't\b|\bonly\b|\bexcept\b/.test(loweredText)) {
    return "restriction";
  }
  if (/\bbefore\b|\bafter\b|\bduring\b/.test(loweredText)) {
    return "timing";
  }
  return "effect";
}

function normalizeStyleToken(rawValue: unknown): (typeof NORMALIZED_STYLE_VALUES)[number] | null {
  const normalized = normalizedString(rawValue)?.toLowerCase().replace(/[_-]+/g, " ");
  if (!normalized) {
    return null;
  }

  const aliased = STYLE_ALIASES[normalized];
  if (!aliased) {
    return null;
  }

  return aliased;
}

function isStyleApplicableToType(style: string, cardType: CardType, text: string): boolean {
  if (["physical_combat", "energy_combat", "event", "setup", "drill", "mastery", "unknown"].includes(cardType)) {
    return true;
  }

  const lowered = text.toLowerCase();
  return lowered.includes(`${style} style`) || lowered.includes(`${style} mastery`);
}

function buildPersonalityFamilyId(setCode: string, characterKeyRaw: unknown): string | null {
  const characterKey = normalizedNullableString(characterKeyRaw);
  if (!characterKey) {
    return null;
  }
  return `${setCode}-${characterKey}`;
}

function normalizeStringArray(rawValue: unknown): string[] {
  if (!Array.isArray(rawValue)) {
    return [];
  }

  return rawValue
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function normalizeNullableInt(rawValue: unknown): number | null {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return null;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  return parsed;
}

function normalizedString(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") {
    return null;
  }
  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizedNullableString(rawValue: unknown): string | null {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }
  return normalizedString(rawValue);
}

function replaceInlineIconSymbols(value: string): string {
  return value
    .replace(/\[quick icon\]/gi, "[timing icon]")
    .replace(/[⚔✠✖⨯]/g, "[attack icon]")
    .replace(/[♥❤]/g, "[defense icon]")
    .replace(/∞/g, "[constant icon]")
    .replace(/[⚡⛭]/g, "[timing icon]")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildIconSignalText(primaryText: string, normalizedOcrText: string): string {
  const primary = primaryText.trim();
  const ocr = normalizedOcrText.trim().slice(0, 8_000);
  if (!ocr) {
    return primary;
  }
  if (!primary) {
    return ocr;
  }

  const normalizedPrimary = normalizeComparableText(primary);
  const normalizedOcr = normalizeComparableText(ocr);
  if (normalizedPrimary === normalizedOcr) {
    return primary;
  }

  return `${primary}\n${ocr}`;
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
