import type { SetCode } from "@dbzccg/schema";

export interface SetDefinition {
  code: SetCode;
  name: string;
  folderName: string;
}

export const SET_DEFINITIONS: Record<SetCode, SetDefinition> = {
  AWA: { code: "AWA", name: "Awakening", folderName: "Awakening" },
  EVO: { code: "EVO", name: "Evolution", folderName: "Evolution" },
  HNV: { code: "HNV", name: "Heroes & Villains", folderName: "Heroes & Villains" },
  MOV: { code: "MOV", name: "Movie Collection", folderName: "Movie Collection" },
  PER: { code: "PER", name: "Perfection", folderName: "Perfection" },
  PRE: { code: "PRE", name: "Premiere Set", folderName: "Premiere Set" },
  VEN: { code: "VEN", name: "Vengeance", folderName: "Vengeance" }
};

export const ALL_SET_CODES = Object.keys(SET_DEFINITIONS) as SetCode[];

export const DEFAULT_IMAGES_ROOT = "packages/data/raw/images";
export const DEFAULT_OUTPUT_CARDS = "packages/data/data/cards.v1.json";
export const DEFAULT_OUTPUT_SETS = "packages/data/data/sets.v1.json";
export const DEFAULT_OUTPUT_REVIEW = "packages/data/raw/review-queue.v1.json";
export const DEFAULT_RULEBOOK_PDF = "packages/data/panini-rule-book-3-0.pdf";
export const DEFAULT_RULEBOOK_TEXT = "packages/data/raw/intermediate/rulebook.txt";
export const DEFAULT_RULEBOOK_LEXICON = "packages/data/raw/intermediate/rulebook-lexicon.v1.json";
export const DEFAULT_RULEBOOK_ICON_REFERENCE = "packages/data/raw/intermediate/rulebook-icons.v1.json";
export const DEFAULT_RULEBOOK_ICON_PAGE_IMAGE = "packages/data/raw/intermediate/rulebook-page-12.png";
export const DEFAULT_RULEBOOK_ICON_ASSETS_DIR = "packages/data/raw/intermediate/rulebook-icons";
export const DEFAULT_RULEBOOK_ICON_PAGE_NUMBER = 12;
export const DEFAULT_PARSE_MODEL = process.env.CODEX_MODEL ?? "";
