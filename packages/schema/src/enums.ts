import { z } from "zod";

export const SetCodeSchema = z.enum(["AWA", "EVO", "HNV", "MOV", "PER", "PRE", "VEN"]);
export type SetCode = z.infer<typeof SetCodeSchema>;

export const RarityPrefixSchema = z.enum(["C", "U", "R", "UR", "DR", "S", "P", "UNK"]);
export type RarityPrefix = z.infer<typeof RarityPrefixSchema>;

export const CardTypeSchema = z.enum([
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
]);
export type CardType = z.infer<typeof CardTypeSchema>;

export const CardStyleSchema = z.enum([
  "black",
  "blue",
  "namekian",
  "orange",
  "red",
  "saiyan",
  "freestyle",
  "other",
  "unknown"
]);
export type CardStyle = z.infer<typeof CardStyleSchema>;

export const CardAffiliationSchema = z.enum(["hero", "villain", "neutral", "unknown"]);
export type CardAffiliation = z.infer<typeof CardAffiliationSchema>;

export const EffectChunkKindSchema = z.enum(["condition", "cost", "effect", "restriction", "timing", "other"]);
export type EffectChunkKind = z.infer<typeof EffectChunkKindSchema>;

export const ReviewReasonSchema = z.enum([
  "missing_critical_field",
  "low_confidence",
  "schema_validation_error",
  "set_code_mismatch",
  "printed_number_conflict",
  "insufficient_ocr",
  "llm_unavailable",
  "manual_check_required"
]);
export type ReviewReason = z.infer<typeof ReviewReasonSchema>;
