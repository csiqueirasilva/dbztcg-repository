import { z } from "zod";
import { SetCodeSchema } from "./enums.js";

export const ReviewQueueItemSchema = z
  .object({
    cardId: z.string().min(1),
    setCode: SetCodeSchema,
    imagePath: z.string().min(1),
    failedFields: z.array(z.string()).default([]),
    reasons: z.array(z.string()).default([]),
    candidateValues: z.record(z.unknown()).default({}),
    confidenceSnapshot: z.object({
      overall: z.number().min(0).max(1),
      fields: z.record(z.number().min(0).max(1)).default({})
    }),
    createdAt: z.string().datetime()
  })
  .strict();
export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;
