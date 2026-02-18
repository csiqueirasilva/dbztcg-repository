import { CardSchema, ReviewQueueItemSchema, type Card, type ReviewQueueItem } from "@dbzccg/schema";
import type { DiscoveredImage, FilenamePriors } from "../types.js";

interface ReprintReference {
  sourceCardId: string;
  sourceSetCode: string;
  sourcePrintedNumber: string;
}

interface AcceptedReprintReference extends ReprintReference {
  kind: "accepted";
  card: Card;
}

interface ReviewReprintReference extends ReprintReference {
  kind: "review";
  reviewItem: ReviewQueueItem;
}

type ReprintLookupReference = AcceptedReprintReference | ReviewReprintReference;

export interface ReprintReuseState {
  acceptedByNameKey: Map<string, AcceptedReprintReference>;
  reviewByNameKey: Map<string, ReviewReprintReference>;
}

export interface ReprintReuseResultAccepted {
  kind: "accepted";
  sourceCardId: string;
  matchedNameKey: string;
  card: Card;
}

export interface ReprintReuseResultReview {
  kind: "review";
  sourceCardId: string;
  matchedNameKey: string;
  reviewItem: ReviewQueueItem;
}

export type ReprintReuseResult = ReprintReuseResultAccepted | ReprintReuseResultReview;

export interface TryReuseReprintInput {
  state: ReprintReuseState;
  image: DiscoveredImage;
  priors: FilenamePriors;
}

export function createReprintReuseState(input: {
  cards: Card[];
  reviewQueue: ReviewQueueItem[];
}): ReprintReuseState {
  const state: ReprintReuseState = {
    acceptedByNameKey: new Map(),
    reviewByNameKey: new Map()
  };

  for (const card of input.cards) {
    registerAcceptedCardForReuse(state, card);
  }
  for (const reviewItem of input.reviewQueue) {
    registerReviewItemForReuse(state, reviewItem);
  }

  return state;
}

export function registerAcceptedCardForReuse(state: ReprintReuseState, card: Card): void {
  const keys = buildNameKeys(card.name, card.title);
  if (keys.length === 0) {
    return;
  }
  const reference: AcceptedReprintReference = {
    kind: "accepted",
    sourceCardId: card.id,
    sourceSetCode: card.setCode,
    sourcePrintedNumber: card.printedNumber,
    card
  };
  for (const key of keys) {
    if (!state.acceptedByNameKey.has(key)) {
      state.acceptedByNameKey.set(key, reference);
    }
  }
}

export function registerReviewItemForReuse(state: ReprintReuseState, reviewItem: ReviewQueueItem): void {
  const sourcePrintedNumber = extractPrintedNumberFromCardId(reviewItem.cardId);
  if (!sourcePrintedNumber) {
    return;
  }
  const candidateValues = asRecord(reviewItem.candidateValues);
  const name = asNonEmptyString(candidateValues?.name);
  const title = asNonEmptyString(candidateValues?.title);
  if (!name) {
    return;
  }

  const keys = buildNameKeys(name, title);
  if (keys.length === 0) {
    return;
  }
  const reference: ReviewReprintReference = {
    kind: "review",
    sourceCardId: reviewItem.cardId,
    sourceSetCode: reviewItem.setCode,
    sourcePrintedNumber,
    reviewItem
  };
  for (const key of keys) {
    if (!state.reviewByNameKey.has(key)) {
      state.reviewByNameKey.set(key, reference);
    }
  }
}

export function tryReuseReprint(input: TryReuseReprintInput): ReprintReuseResult | null {
  const nameKeys = buildNameKeys(input.priors.nameGuess, null);
  if (nameKeys.length === 0) {
    return null;
  }

  for (const nameKey of nameKeys) {
    const acceptedReference = input.state.acceptedByNameKey.get(nameKey);
    if (acceptedReference && isDistinctPrint(acceptedReference, input.image, input.priors)) {
      return {
        kind: "accepted",
        sourceCardId: acceptedReference.sourceCardId,
        matchedNameKey: nameKey,
        card: cloneAcceptedCardForReprint(acceptedReference.card, input.image, input.priors)
      };
    }

    const reviewReference = input.state.reviewByNameKey.get(nameKey);
    if (reviewReference && isDistinctPrint(reviewReference, input.image, input.priors)) {
      return {
        kind: "review",
        sourceCardId: reviewReference.sourceCardId,
        matchedNameKey: nameKey,
        reviewItem: cloneReviewItemForReprint(reviewReference.reviewItem, input.image, input.priors)
      };
    }
  }

  return null;
}

function cloneAcceptedCardForReprint(sourceCard: Card, image: DiscoveredImage, priors: FilenamePriors): Card {
  const nextId = buildCardId(image.setCode, priors.printedNumber);
  return CardSchema.parse({
    ...sourceCard,
    id: nextId,
    setCode: image.setCode,
    setName: image.setName,
    printedNumber: priors.printedNumber,
    rarityPrefix: priors.rarityPrefix,
    personalityFamilyId: sourceCard.characterKey ? `${image.setCode}-${sourceCard.characterKey}` : null,
    source: {
      ...sourceCard.source,
      imagePath: image.imagePath,
      imageFileName: image.imageFileName
    }
  });
}

function cloneReviewItemForReprint(
  sourceReviewItem: ReviewQueueItem,
  image: DiscoveredImage,
  priors: FilenamePriors
): ReviewQueueItem {
  const nextCardId = buildCardId(image.setCode, priors.printedNumber);
  const nextCandidateValues = cloneCandidateValuesForReprint(sourceReviewItem.candidateValues, image, priors, nextCardId);

  return ReviewQueueItemSchema.parse({
    ...sourceReviewItem,
    cardId: nextCardId,
    setCode: image.setCode,
    imagePath: image.imagePath,
    candidateValues: nextCandidateValues,
    createdAt: new Date().toISOString()
  });
}

function cloneCandidateValuesForReprint(
  value: Record<string, unknown>,
  image: DiscoveredImage,
  priors: FilenamePriors,
  nextCardId: string
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...value,
    id: nextCardId,
    setCode: image.setCode,
    setName: image.setName,
    printedNumber: priors.printedNumber,
    rarityPrefix: priors.rarityPrefix
  };

  const sourceRecord = asRecord(next.source);
  next.source = {
    ...(sourceRecord ?? {}),
    imagePath: image.imagePath,
    imageFileName: image.imageFileName
  };

  const characterKey = asNonEmptyString(next.characterKey);
  if (characterKey) {
    next.personalityFamilyId = `${image.setCode}-${characterKey}`;
  }

  return next;
}

function isDistinctPrint(reference: ReprintLookupReference, image: DiscoveredImage, priors: FilenamePriors): boolean {
  return reference.sourceSetCode !== image.setCode || reference.sourcePrintedNumber !== priors.printedNumber;
}

function buildCardId(setCode: string, printedNumber: string): string {
  return `${setCode}-${printedNumber}`;
}

function buildNameKeys(name: string | null, title: string | null): string[] {
  const normalizedName = normalizeNameToken(name);
  const normalizedTitle = normalizeNameToken(title);
  if (!normalizedName) {
    return [];
  }

  const keys = new Set<string>([normalizedName]);
  if (normalizedTitle) {
    keys.add(normalizeNameToken(`${normalizedName} ${normalizedTitle}`));
    keys.add(normalizeNameToken(`${name ?? ""} ${title ?? ""}`));
  }

  return Array.from(keys).filter((key): key is string => Boolean(key));
}

function normalizeNameToken(value: string | null): string {
  if (!value) {
    return "";
  }
  return value
    .toLowerCase()
    .replace(/\blv\.?\s*\d+\b/g, " ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPrintedNumberFromCardId(cardId: string): string | null {
  const parts = cardId.split("-");
  if (parts.length < 2) {
    return null;
  }
  const printedNumber = parts.slice(1).join("-");
  return printedNumber.length > 0 ? printedNumber : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
