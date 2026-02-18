import {
  DEFAULT_RULEBOOK_ICON_PAGE_IMAGE,
  DEFAULT_RULEBOOK_ICON_PAGE_NUMBER,
  DEFAULT_RULEBOOK_ICON_REFERENCE,
  DEFAULT_RULEBOOK_LEXICON,
  DEFAULT_RULEBOOK_PDF,
  DEFAULT_RULEBOOK_TEXT
} from "../constants.js";
import { resolveRepoPath } from "../io/repo-paths.js";
import type { RulebookLexicon } from "../types.js";
import { extractRulebookArtifacts, readLexiconFromFile } from "./extract-rulebook.js";

export interface LoadRulebookLexiconOptions {
  pdfPath?: string;
  lexiconPath?: string;
  textPath?: string;
  forceRefresh?: boolean;
}

export async function loadRulebookLexicon(options: LoadRulebookLexiconOptions = {}): Promise<RulebookLexicon> {
  const pdfPath = resolveRepoPath(options.pdfPath ?? DEFAULT_RULEBOOK_PDF);
  const lexiconPath = resolveRepoPath(options.lexiconPath ?? DEFAULT_RULEBOOK_LEXICON);
  const textPath = resolveRepoPath(options.textPath ?? DEFAULT_RULEBOOK_TEXT);
  const iconReferencePath = resolveRepoPath(DEFAULT_RULEBOOK_ICON_REFERENCE);
  const iconPageImagePath = resolveRepoPath(DEFAULT_RULEBOOK_ICON_PAGE_IMAGE);
  const forceRefresh = options.forceRefresh ?? false;

  if (!forceRefresh) {
    const existingLexicon = await readLexiconFromFile(lexiconPath);
    if (existingLexicon) {
      return existingLexicon;
    }
  }

  return extractRulebookArtifacts({
    pdfPath,
    outputTextPath: textPath,
    outputLexiconPath: lexiconPath,
    outputIconReferencePath: iconReferencePath,
    outputIconPageImagePath: iconPageImagePath,
    iconPageNumber: DEFAULT_RULEBOOK_ICON_PAGE_NUMBER
  });
}
