import type { Card, CardType, RarityPrefix, ReviewQueueItem, SetCode, SetRecord } from "@dbzccg/schema";

export interface DiscoveredImage {
  setCode: SetCode;
  setName: string;
  imagePath: string;
  imageFileName: string;
}

export interface FilenamePriors {
  canonicalFileStem: string;
  printedNumber: string;
  rarityPrefix: RarityPrefix;
  nameGuess: string;
  personalityLevel: number | null;
  characterKey: string | null;
  styleGuess: string | null;
  cardTypeGuess: CardType;
}

export interface OcrBlock {
  text: string;
  confidence?: number;
  bbox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface OcrResult {
  text: string;
  engine: string;
  warnings: string[];
  blocks: OcrBlock[];
}

export interface RulebookLexicon {
  cardTypes: string[];
  styles: string[];
  iconKeywords: {
    attack: string[];
    defense: string[];
    quick: string[];
    constant: string[];
  };
  affiliationKeywords: {
    hero: string[];
    villain: string[];
    neutral: string[];
  };
  allyKeywords: string[];
  iconReference: {
    pageNumber: number;
    sourceImagePath: string;
    sourcePdfPath: string;
    extractedAt: string;
    icons: {
      attack: {
        symbolName: string;
        marker: string;
        meaning: string;
        cues: string[];
        assetPath: string | null;
      };
      defense: {
        symbolName: string;
        marker: string;
        meaning: string;
        cues: string[];
        assetPath: string | null;
      };
      constant: {
        symbolName: string;
        marker: string;
        meaning: string;
        cues: string[];
        assetPath: string | null;
      };
      quick: {
        symbolName: string;
        marker: string;
        meaning: string;
        cues: string[];
        assetPath: string | null;
      };
    };
  };
  keywords: string[];
}

export interface LlmParseResult {
  data: Record<string, unknown>;
  llmUsed: boolean;
  warnings: string[];
  rawJson?: string;
}

export interface ValidationResult {
  accepted: boolean;
  card?: Card;
  reviewItem?: ReviewQueueItem;
}

export interface BuildDbResult {
  cards: Card[];
  sets: SetRecord[];
  reviewQueue: ReviewQueueItem[];
  startedAt: string;
  finishedAt: string;
}
