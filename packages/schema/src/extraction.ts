import { z } from "zod";
import { CardAffiliationSchema, CardStyleSchema, CardTypeSchema, EffectChunkKindSchema } from "./enums.js";

export const CardExtractionIconsSchema = z
  .object({
    isAttack: z.boolean(),
    isDefense: z.boolean(),
    isQuick: z.boolean(),
    isConstant: z.boolean(),
    rawIconEvidence: z.array(z.string())
  })
  .strict();
export type CardExtractionIcons = z.infer<typeof CardExtractionIconsSchema>;

export const CardExtractionEffectChunkSchema = z
  .object({
    kind: EffectChunkKindSchema,
    text: z.string().min(1),
    keywords: z.array(z.string())
  })
  .strict();
export type CardExtractionEffectChunk = z.infer<typeof CardExtractionEffectChunkSchema>;

export const CardExtractionFieldConfidenceSchema = z
  .object({
    name: z.number().min(0).max(1),
    cardType: z.number().min(0).max(1),
    affiliation: z.number().min(0).max(1),
    isMainPersonality: z.number().min(0).max(1),
    isAlly: z.number().min(0).max(1),
    cardTextRaw: z.number().min(0).max(1),
    powerStageValues: z.number().min(0).max(1),
    endurance: z.number().min(0).max(1),
    personalityLevel: z.number().min(0).max(1),
    pur: z.number().min(0).max(1),
    mainPowerText: z.number().min(0).max(1)
  })
  .strict();
export type CardExtractionFieldConfidence = z.infer<typeof CardExtractionFieldConfidenceSchema>;

export const CardExtractionSchema = z
  .object({
    name: z.string().nullable(),
    title: z.string().nullable(),
    characterKey: z.string().nullable(),
    cardType: CardTypeSchema,
    affiliation: CardAffiliationSchema.nullable(),
    isMainPersonality: z.boolean(),
    isAlly: z.boolean(),
    cardSubtypes: z.array(z.string()),
    style: CardStyleSchema.nullable(),
    tags: z.array(z.string()),
    personalityLevel: z.number().int().min(1).max(4).nullable(),
    powerStageValues: z.array(z.number().int().min(0)),
    pur: z.number().int().min(0).nullable(),
    endurance: z.number().int().min(0).nullable(),
    mainPowerText: z.string().nullable(),
    cardTextRaw: z.string().nullable(),
    effectChunks: z.array(CardExtractionEffectChunkSchema),
    icons: CardExtractionIconsSchema,
    fieldConfidence: CardExtractionFieldConfidenceSchema
  })
  .strict();
export type CardExtraction = z.infer<typeof CardExtractionSchema>;
