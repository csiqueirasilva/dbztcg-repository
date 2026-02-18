export interface CardEffectChunk {
  kind: string;
  text: string;
  keywords: string[];
}

export interface CardRecord {
  id: string;
  setCode: string;
  setName: string;
  printedNumber: string;
  rarityPrefix: string;
  name: string;
  title: string | null;
  characterKey: string | null;
  personalityFamilyId: string | null;
  cardType: string;
  affiliation: string;
  isMainPersonality: boolean;
  isAlly: boolean;
  cardSubtypes: string[];
  style: string | null;
  icons: {
    isAttack: boolean;
    isDefense: boolean;
    isQuick: boolean;
    isConstant: boolean;
    rawIconEvidence: string[];
  };
  tags: string[];
  powerStageValues: number[];
  pur: number | null;
  endurance: number | null;
  considered_as_styled_card: boolean;
  limit_per_deck: number;
  banished_after_use: boolean;
  shuffle_into_deck_after_use: boolean;
  drill_not_discarded_when_changing_levels: boolean;
  attach_limit: number | "infinity";
  extraordinary_can_play_from_hand: boolean;
  has_effect_when_discarded_combat: boolean;
  seaches_owner_life_deck: boolean;
  rejuvenates_amount: number | null;
  conditional_rejuvenate: boolean;
  conditional_endurance: boolean;
  raise_your_anger: number | null;
  conditional_raise_your_anger: boolean;
  lower_your_anger: number | null;
  conditional_lower_your_anger: boolean;
  raise_or_lower_any_player_anger: number | null;
  conditional_raise_or_lower_any_player_anger: boolean;
  when_drill_enters_play_during_combat: boolean;
  when_drill_enters_play: boolean;
  attaches_own_main_personality: boolean;
  attaches_opponent_main_personality: boolean;
  personalityLevel: number | null;
  mainPowerText: string | null;
  cardTextRaw: string;
  effectChunks: CardEffectChunk[];
  source: {
    imagePath: string;
    imageFileName: string;
    sourceUrl: string | null;
  };
  confidence: {
    overall: number;
    fields: Record<string, number>;
  };
  review: {
    required: boolean;
    reasons: string[];
    notes: string[];
  };
  raw: {
    ocrText: string;
    ocrBlocks: unknown[];
    llmRawJson?: string;
    warnings: string[];
  };
}

export interface ReviewQueueItem {
  cardId: string;
  setCode: string;
  imagePath: string;
  failedFields: string[];
  reasons: string[];
  candidateValues: Record<string, unknown>;
  confidenceSnapshot: {
    overall: number;
    fields: Record<string, number>;
  };
  createdAt: string;
}

export interface SetRecord {
  setCode: string;
  setName: string;
  cardCountExpected: number | null;
  cardCountParsed: number;
  sourceFolders: string[];
  parseRunMetadata: {
    startedAt: string;
    finishedAt: string;
    acceptedCards: number;
    reviewCards: number;
    parseModel: string;
    minConfidence: number;
  };
}

export type ImageReadStatus = "unread" | "accepted" | "review";

export interface ImageInventoryItem {
  setCode: string;
  setName: string;
  imagePath: string;
  imageFileName: string;
  status: ImageReadStatus;
  cardId: string | null;
}

export interface RescanSummary {
  imagePath: string;
  status: ImageReadStatus | "unknown";
  cardId: string | null;
  commandOutput: string;
}

export interface LoadPayload {
  paths: {
    repoRoot: string;
    cardsPath: string;
    reviewQueuePath: string;
    setsPath: string;
  };
  cards: CardRecord[];
  reviewQueue: ReviewQueueItem[];
  sets: SetRecord[];
  imageInventory: ImageInventoryItem[];
}
