import { ReviewQueueItemSchema, type SetCode } from "@dbzccg/schema";

export interface CreateReviewQueueItemInput {
  cardId: string;
  setCode: SetCode;
  imagePath: string;
  failedFields: string[];
  reasons: string[];
  candidateValues: Record<string, unknown>;
  confidenceOverall: number;
  confidenceFields: Record<string, number>;
}

export function createReviewQueueItem(input: CreateReviewQueueItemInput) {
  return ReviewQueueItemSchema.parse({
    cardId: input.cardId,
    setCode: input.setCode,
    imagePath: input.imagePath,
    failedFields: input.failedFields,
    reasons: input.reasons,
    candidateValues: input.candidateValues,
    confidenceSnapshot: {
      overall: clamp01(input.confidenceOverall),
      fields: normalizeConfidenceMap(input.confidenceFields)
    },
    createdAt: new Date().toISOString()
  });
}

function normalizeConfidenceMap(fields: Record<string, number>): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [field, score] of Object.entries(fields)) {
    normalized[field] = clamp01(score);
  }
  return normalized;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
