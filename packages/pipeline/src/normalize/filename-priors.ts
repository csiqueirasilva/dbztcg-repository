import type { CardType, RarityPrefix } from "@dbzccg/schema";
import type { FilenamePriors } from "../types.js";

const STYLE_BY_TOKEN: Record<string, string> = {
  black: "black",
  blue: "blue",
  namekian: "namekian",
  orange: "orange",
  red: "red",
  saiyan: "saiyan",
  freestyle: "freestyle"
};

export function inferFilenamePriors(imageFileName: string): FilenamePriors {
  const noExtension = imageFileName.replace(/\.[^.]+$/, "");
  const canonicalFileStem = removeDuplicateRunSuffix(noExtension);

  const splitMatch = canonicalFileStem.match(/^([A-Za-z]{1,3}\d{1,4})(?:-(.+))?$/);
  const printedNumber = splitMatch ? splitMatch[1].toUpperCase() : "UNK000";
  const titlePart = splitMatch?.[2] ?? canonicalFileStem;
  const rarityPrefix = extractRarityPrefix(printedNumber);
  const nameGuess = humanizeSlug(titlePart);
  const personalityLevel = extractPersonalityLevel(nameGuess);
  const characterKey = extractCharacterKey(nameGuess);
  const styleGuess = extractStyle(nameGuess);
  const cardTypeGuess = inferCardTypeGuess(nameGuess, personalityLevel);

  return {
    canonicalFileStem,
    printedNumber,
    rarityPrefix,
    nameGuess,
    personalityLevel,
    characterKey,
    styleGuess,
    cardTypeGuess
  };
}

function extractRarityPrefix(printedNumber: string): RarityPrefix {
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

function removeDuplicateRunSuffix(fileStem: string): string {
  // Keeps legitimate "Lv.-2" endings but strips duplicate scrape suffixes like "-2" in "...-Lv.-2-2".
  if (/-\d+$/.test(fileStem) && !/Lv\.-\d+$/i.test(fileStem)) {
    return fileStem.replace(/-\d+$/, "");
  }
  return fileStem;
}

function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bLv\.\s*(\d)\b/gi, "Lv. $1")
    .trim();
}

function extractPersonalityLevel(nameGuess: string): number | null {
  const levelMatch = nameGuess.match(/\bLv\.\s*(\d)\b/i);
  if (!levelMatch) {
    return null;
  }

  const level = Number(levelMatch[1]);
  if (!Number.isInteger(level) || level < 1 || level > 4) {
    return null;
  }

  return level;
}

function extractCharacterKey(nameGuess: string): string | null {
  const token = nameGuess
    .split(" ")
    .find((part) => /^[A-Za-z][A-Za-z.'-]*$/.test(part) && !/^Lv\.$/i.test(part) && !/^\d+$/.test(part));

  if (!token) {
    return null;
  }

  return token
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractStyle(nameGuess: string): string | null {
  const token = nameGuess.split(" ")[0]?.toLowerCase();
  if (!token) {
    return null;
  }

  return STYLE_BY_TOKEN[token] ?? null;
}

function inferCardTypeGuess(nameGuess: string, personalityLevel: number | null): CardType {
  if (personalityLevel !== null) {
    return "personality";
  }

  const normalizedName = nameGuess.toLowerCase();
  if (normalizedName.includes("mastery")) {
    return "mastery";
  }
  if (normalizedName.includes("dragon ball")) {
    return "dragon_ball";
  }
  if (normalizedName.includes("drill")) {
    return "drill";
  }

  return "unknown";
}
