import { z } from "zod";
import { SetCodeSchema } from "./enums.js";

export const SetSchema = z
  .object({
    setCode: SetCodeSchema,
    setName: z.string().min(1),
    cardCountExpected: z.number().int().min(0).nullable().default(null),
    cardCountParsed: z.number().int().min(0),
    sourceFolders: z.array(z.string()).default([]),
    parseRunMetadata: z.object({
      startedAt: z.string().datetime(),
      finishedAt: z.string().datetime(),
      acceptedCards: z.number().int().min(0),
      reviewCards: z.number().int().min(0),
      parseModel: z.string().min(1),
      minConfidence: z.number().min(0).max(1)
    })
  })
  .strict();
export type SetRecord = z.infer<typeof SetSchema>;
