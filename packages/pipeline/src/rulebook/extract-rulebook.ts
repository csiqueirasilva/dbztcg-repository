import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import type { RulebookLexicon } from "../types.js";
import {
  DEFAULT_RULEBOOK_ICON_ASSETS_DIR,
  DEFAULT_RULEBOOK_ICON_PAGE_IMAGE,
  DEFAULT_RULEBOOK_ICON_PAGE_NUMBER,
  DEFAULT_RULEBOOK_ICON_REFERENCE,
  DEFAULT_RULEBOOK_PDF
} from "../constants.js";

const execFileAsync = promisify(execFile);

export interface ExtractRulebookOptions {
  pdfPath: string;
  outputTextPath: string;
  outputLexiconPath: string;
  outputIconReferencePath?: string;
  outputIconPageImagePath?: string;
  outputIconAssetsDir?: string;
  iconPageNumber?: number;
}

const ICON_MARKERS = {
  attack: "[attack icon]",
  defense: "[defense icon]",
  constant: "[constant icon]",
  quick: "[timing icon]"
} as const;

const ICON_BASE_DIMENSIONS = {
  width: 525,
  height: 844
};

const ICON_CROP_LAYOUT: Record<keyof RulebookLexicon["iconReference"]["icons"], { x: number; y: number; width: number; height: number }> = {
  attack: { x: 38, y: 111, width: 34, height: 23 },
  defense: { x: 40, y: 136, width: 30, height: 30 },
  constant: { x: 35, y: 157, width: 38, height: 26 },
  quick: { x: 40, y: 196, width: 30, height: 36 }
};

export async function extractRulebookArtifacts(options: ExtractRulebookOptions): Promise<RulebookLexicon> {
  const text = await extractRulebookText(options.pdfPath, options.outputTextPath);
  const iconReference = await extractRulebookIconReference({
    pdfPath: options.pdfPath,
    outputIconPageImagePath: options.outputIconPageImagePath ?? DEFAULT_RULEBOOK_ICON_PAGE_IMAGE,
    outputIconAssetsDir: options.outputIconAssetsDir ?? DEFAULT_RULEBOOK_ICON_ASSETS_DIR,
    iconPageNumber: options.iconPageNumber ?? DEFAULT_RULEBOOK_ICON_PAGE_NUMBER
  });
  const lexicon = buildRulebookLexicon(text, iconReference);

  await mkdir(path.dirname(options.outputLexiconPath), { recursive: true });
  await writeFile(options.outputLexiconPath, `${JSON.stringify(lexicon, null, 2)}\n`, "utf8");
  const iconReferencePath = options.outputIconReferencePath ?? DEFAULT_RULEBOOK_ICON_REFERENCE;
  await mkdir(path.dirname(iconReferencePath), { recursive: true });
  await writeFile(iconReferencePath, `${JSON.stringify(iconReference, null, 2)}\n`, "utf8");

  return lexicon;
}

export async function extractRulebookText(pdfPath: string, outputTextPath: string): Promise<string> {
  await mkdir(path.dirname(outputTextPath), { recursive: true });

  try {
    const { stdout } = await execFileAsync("pdftotext", ["-enc", "UTF-8", pdfPath, "-"], {
      maxBuffer: 64 * 1024 * 1024
    });
    const withMarkers = applyRulebookIconMarkers(stdout);
    await writeFile(outputTextPath, withMarkers, "utf8");
    return withMarkers;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Rulebook extraction failed for "${pdfPath}": ${message}`);
  }
}

export async function readLexiconFromFile(lexiconPath: string): Promise<RulebookLexicon | null> {
  try {
    const raw = await readFile(lexiconPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeLexicon(parsed);
  } catch {
    return null;
  }
}

async function extractRulebookIconReference(input: {
  pdfPath: string;
  outputIconPageImagePath: string;
  outputIconAssetsDir: string;
  iconPageNumber: number;
}): Promise<RulebookLexicon["iconReference"]> {
  await renderPdfPageToPng({
    pdfPath: input.pdfPath,
    pageNumber: input.iconPageNumber,
    outputImagePath: input.outputIconPageImagePath,
    dpi: 144
  });

  const pageText = await extractPdfPageText(input.pdfPath, input.iconPageNumber);
  const descriptions = parseIconDescriptions(pageText);
  const iconAssetPaths = await extractRulebookIconAssets({
    pdfPath: input.pdfPath,
    pageNumber: input.iconPageNumber,
    outputAssetsDir: input.outputIconAssetsDir
  });

  return {
    pageNumber: input.iconPageNumber,
    sourceImagePath: input.outputIconPageImagePath,
    sourcePdfPath: input.pdfPath,
    extractedAt: new Date().toISOString(),
    icons: {
      attack: {
        symbolName: "crossed-swords",
        marker: ICON_MARKERS.attack,
        meaning: descriptions.attack ?? "A card that performs an attack.",
        cues: [
          "attack",
          "physical attack",
          "energy attack",
          "damage",
          "combat card"
        ],
        assetPath: iconAssetPaths.attack
      },
      defense: {
        symbolName: "shield",
        marker: ICON_MARKERS.defense,
        meaning: descriptions.defense ?? "A defensive card that can be used against attacks.",
        cues: [
          "defensive card",
          "stops an attack",
          "prevent",
          "defense"
        ],
        assetPath: iconAssetPaths.defense
      },
      constant: {
        symbolName: "infinity",
        marker: ICON_MARKERS.constant,
        meaning: descriptions.constant ?? "A continuous effect that is constantly active while the card is in play.",
        cues: [
          "constant",
          "continuous effect",
          "while this card is in play",
          "while in play",
          "always active"
        ],
        assetPath: iconAssetPaths.constant
      },
      quick: {
        symbolName: "lightning-bolt",
        marker: ICON_MARKERS.quick,
        meaning: descriptions.quick ?? "An effect with contextual timing that can be instantly played or used.",
        cues: [
          "quick",
          "immediately",
          "instantly",
          "whenever appropriate",
          "contextual timing"
        ],
        assetPath: iconAssetPaths.quick
      }
    }
  };
}

async function renderPdfPageToPng(input: {
  pdfPath: string;
  pageNumber: number;
  outputImagePath: string;
  dpi: number;
}): Promise<void> {
  await mkdir(path.dirname(input.outputImagePath), { recursive: true });
  const outputPrefix = input.outputImagePath.endsWith(".png")
    ? input.outputImagePath.slice(0, -4)
    : input.outputImagePath;

  try {
    await execFileAsync("pdftocairo", [
      "-png",
      "-r",
      String(input.dpi),
      "-f",
      String(input.pageNumber),
      "-l",
      String(input.pageNumber),
      "-singlefile",
      input.pdfPath,
      outputPrefix
    ], {
      maxBuffer: 64 * 1024 * 1024
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Rulebook icon page render failed for "${input.pdfPath}" page ${input.pageNumber}: ${message}`);
  }
}

async function extractPdfPageText(pdfPath: string, pageNumber: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "pdftotext",
      ["-enc", "UTF-8", "-f", String(pageNumber), "-l", String(pageNumber), pdfPath, "-"],
      { maxBuffer: 64 * 1024 * 1024 }
    );
    return stdout;
  } catch {
    return "";
  }
}

function parseIconDescriptions(pageText: string): Partial<Record<keyof RulebookLexicon["iconReference"]["icons"], string>> {
  if (!pageText) {
    return {};
  }

  const cleaned = pageText
    .replace(/\s+/g, " ")
    .replace(/[–—]/g, "-")
    .trim()
    .toLowerCase();

  const capture = (pattern: RegExp): string | null => {
    const match = cleaned.match(pattern);
    if (!match || !match[1]) {
      return null;
    }
    const value = match[1].replace(/\s+/g, " ").trim();
    return value.length > 0 ? value : null;
  };

  return {
    attack: capture(/-\s*(a card that performs an attack)/i) ?? undefined,
    defense: capture(/-\s*(a defensive card that can be used against attacks)/i) ?? undefined,
    constant: capture(/-\s*(a continuous effect that is constantly active while the card is in play)/i) ?? undefined,
    quick:
      capture(/-\s*(an effect(?: with contextual timing)?[^)]*whenever appropriate\))/i) ??
      capture(/-\s*(an effect that may be used immediately, whenever appropriate)/i) ??
      undefined
  };
}

function applyRulebookIconMarkers(rawText: string): string {
  if (!rawText || rawText.trim().length === 0) {
    return rawText;
  }

  return rawText
    .replace(/-\s*A card that performs an attack/gi, `- ${ICON_MARKERS.attack} A card that performs an attack`)
    .replace(/-\s*A defensive card that can be used against attacks/gi, `- ${ICON_MARKERS.defense} A defensive card that can be used against attacks`)
    .replace(
      /-\s*A continuous effect that is constantly active while the\s+card is in play/gi,
      `- ${ICON_MARKERS.constant} A continuous effect that is constantly active while the card is in play`
    )
    .replace(
      /-\s*An effect with contextual timing that can be instantly\s+played or used \(whenever appropriate\)/gi,
      `- ${ICON_MARKERS.quick} An effect with contextual timing that can be instantly played or used (whenever appropriate)`
    )
    .replace(/\bHOW\s+AND\s+CARDS WORK\b/gi, `HOW ${ICON_MARKERS.attack} AND ${ICON_MARKERS.defense} CARDS WORK`)
    .replace(/Whenever you play an\s*,\s*your opponent may play or use/gi, `Whenever you play an ${ICON_MARKERS.attack}, your opponent may play or use`)
    .replace(/\bone\s+card by playing it from his or her hand/gi, `one ${ICON_MARKERS.defense} card by playing it from his or her hand`)
    .replace(
      /The\s+immediate effects of\s+and\s+cards always take place as/gi,
      `The immediate effects of ${ICON_MARKERS.attack} and ${ICON_MARKERS.defense} cards always take place as`
    );
}

async function extractRulebookIconAssets(input: {
  pdfPath: string;
  pageNumber: number;
  outputAssetsDir: string;
}): Promise<Record<keyof RulebookLexicon["iconReference"]["icons"], string>> {
  await mkdir(input.outputAssetsDir, { recursive: true });
  const highResPagePath = path.join(input.outputAssetsDir, `_rulebook-page-${input.pageNumber}-600.png`);

  await renderPdfPageToPng({
    pdfPath: input.pdfPath,
    pageNumber: input.pageNumber,
    outputImagePath: highResPagePath,
    dpi: 600
  });

  try {
    const sourcePng = PNG.sync.read(await readFile(highResPagePath));
    const outputPaths: Record<keyof RulebookLexicon["iconReference"]["icons"], string> = {
      attack: path.join(input.outputAssetsDir, "attack-icon.png"),
      defense: path.join(input.outputAssetsDir, "defense-icon.png"),
      constant: path.join(input.outputAssetsDir, "constant-icon.png"),
      quick: path.join(input.outputAssetsDir, "timing-icon.png")
    };

    for (const [key, box] of Object.entries(ICON_CROP_LAYOUT) as Array<
      [keyof RulebookLexicon["iconReference"]["icons"], (typeof ICON_CROP_LAYOUT)[keyof RulebookLexicon["iconReference"]["icons"]]]
    >) {
      const extracted = extractIconFromPage(sourcePng, box);
      await writeFile(outputPaths[key], PNG.sync.write(extracted));
    }

    return outputPaths;
  } finally {
    await rm(highResPagePath, { force: true });
  }
}

function extractIconFromPage(
  sourcePng: PNG,
  baseBox: { x: number; y: number; width: number; height: number }
): PNG {
  const scaleX = sourcePng.width / ICON_BASE_DIMENSIONS.width;
  const scaleY = sourcePng.height / ICON_BASE_DIMENSIONS.height;
  const x = clampInt(Math.round(baseBox.x * scaleX), 0, Math.max(0, sourcePng.width - 1));
  const y = clampInt(Math.round(baseBox.y * scaleY), 0, Math.max(0, sourcePng.height - 1));
  const width = clampInt(Math.round(baseBox.width * scaleX), 1, sourcePng.width - x);
  const height = clampInt(Math.round(baseBox.height * scaleY), 1, sourcePng.height - y);
  const crop = cropPng(sourcePng, x, y, width, height);

  const backgroundColor = estimateBackgroundColor(crop);
  const processed = new PNG({ width: crop.width, height: crop.height });

  for (let row = 0; row < crop.height; row += 1) {
    for (let col = 0; col < crop.width; col += 1) {
      const index = (row * crop.width + col) * 4;
      const r = crop.data[index];
      const g = crop.data[index + 1];
      const b = crop.data[index + 2];
      const distance = colorDistance(r, g, b, backgroundColor.r, backgroundColor.g, backgroundColor.b);
      const alpha = distance <= 16 ? 0 : distance >= 52 ? 255 : Math.round(((distance - 16) / (52 - 16)) * 255);
      processed.data[index] = r;
      processed.data[index + 1] = g;
      processed.data[index + 2] = b;
      processed.data[index + 3] = alpha;
    }
  }

  const denoised = removeDisconnectedArtifacts(processed);
  return trimTransparentBounds(denoised) ?? denoised;
}

function cropPng(sourcePng: PNG, x: number, y: number, width: number, height: number): PNG {
  const cropped = new PNG({ width, height });
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const sourceIndex = ((y + row) * sourcePng.width + (x + col)) * 4;
      const targetIndex = (row * width + col) * 4;
      cropped.data[targetIndex] = sourcePng.data[sourceIndex];
      cropped.data[targetIndex + 1] = sourcePng.data[sourceIndex + 1];
      cropped.data[targetIndex + 2] = sourcePng.data[sourceIndex + 2];
      cropped.data[targetIndex + 3] = sourcePng.data[sourceIndex + 3];
    }
  }
  return cropped;
}

function estimateBackgroundColor(png: PNG): { r: number; g: number; b: number } {
  const samples: Array<{ r: number; g: number; b: number }> = [];
  for (let x = 0; x < png.width; x += 1) {
    samples.push(readPixel(png, x, 0));
    samples.push(readPixel(png, x, png.height - 1));
  }
  for (let y = 1; y < png.height - 1; y += 1) {
    samples.push(readPixel(png, 0, y));
    samples.push(readPixel(png, png.width - 1, y));
  }
  samples.sort((left, right) => luminance(left.r, left.g, left.b) - luminance(right.r, right.g, right.b));
  return samples[Math.floor(samples.length / 2)] ?? { r: 255, g: 255, b: 255 };
}

function readPixel(png: PNG, x: number, y: number): { r: number; g: number; b: number } {
  const index = (y * png.width + x) * 4;
  return {
    r: png.data[index],
    g: png.data[index + 1],
    b: png.data[index + 2]
  };
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function trimTransparentBounds(png: PNG): PNG | null {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const alpha = png.data[(y * png.width + x) * 4 + 3];
      if (alpha <= 0) {
        continue;
      }
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  const padding = 4;
  const x = Math.max(0, minX - padding);
  const y = Math.max(0, minY - padding);
  const width = Math.min(png.width - x, maxX - minX + 1 + padding * 2);
  const height = Math.min(png.height - y, maxY - minY + 1 + padding * 2);
  return cropPng(png, x, y, width, height);
}

function removeDisconnectedArtifacts(png: PNG): PNG {
  const width = png.width;
  const height = png.height;
  const total = width * height;
  const visited = new Uint8Array(total);
  const components: number[][] = [];

  const inBounds = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height;
  const getAlpha = (index: number) => png.data[index * 4 + 3];

  for (let index = 0; index < total; index += 1) {
    if (visited[index] === 1 || getAlpha(index) === 0) {
      continue;
    }

    const queue: number[] = [index];
    const component: number[] = [];
    visited[index] = 1;

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      component.push(current);
      const x = current % width;
      const y = Math.floor(current / width);

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }
          const nx = x + dx;
          const ny = y + dy;
          if (!inBounds(nx, ny)) {
            continue;
          }
          const neighbor = ny * width + nx;
          if (visited[neighbor] === 1 || getAlpha(neighbor) === 0) {
            continue;
          }
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }

    components.push(component);
  }

  if (components.length <= 1) {
    return png;
  }

  const largest = components.reduce((best, component) => Math.max(best, component.length), 0);
  const minimumKeepSize = Math.max(8, Math.floor(largest * 0.4));

  for (const component of components) {
    if (component.length >= minimumKeepSize) {
      continue;
    }
    for (const pixelIndex of component) {
      const alphaIndex = pixelIndex * 4 + 3;
      png.data[alphaIndex] = 0;
    }
  }

  return png;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildRulebookLexicon(
  rulebookText: string,
  iconReference: RulebookLexicon["iconReference"]
): RulebookLexicon {
  const normalized = rulebookText.toLowerCase();

  const cardTypes = [
    "personality",
    "mastery",
    "physical combat",
    "energy combat",
    "event",
    "setup",
    "drill",
    "dragon ball",
    "non-combat"
  ].filter((token) => normalized.includes(token));

  const styles = ["black", "blue", "namekian", "orange", "red", "saiyan", "freestyle"].filter((token) =>
    normalized.includes(token)
  );

  const iconKeywords = {
    attack: Array.from(
      new Set(["attack", "physical attack", "energy attack", "combat", "damage", ...iconReference.icons.attack.cues])
    ),
    defense: Array.from(
      new Set(["defense", "defend", "block", "prevent", ...iconReference.icons.defense.cues])
    ),
    quick: Array.from(new Set(["quick", "immediate", "instant", "instantly", ...iconReference.icons.quick.cues])),
    constant: Array.from(
      new Set(["constant", "continuous", "while this card is in play", "while in play", ...iconReference.icons.constant.cues])
    )
  };

  const affiliationKeywords = {
    hero: ["hero", "heroes", "heroes only", "heroic"],
    villain: ["villain", "villains", "villains only", "villainous"],
    neutral: ["neutral", "non-aligned", "unaligned"]
  };
  const allyKeywords = ["ally", "allies", "ally card"];

  const keywords = Array.from(
    new Set([
      ...cardTypes,
      ...styles,
      "stages",
      "pur",
      "anger",
      "power",
      "level",
      "combat",
      "life deck",
      "dragon ball victory",
      ...affiliationKeywords.hero,
      ...affiliationKeywords.villain,
      ...affiliationKeywords.neutral,
      ...allyKeywords
    ])
  );

  return {
    cardTypes,
    styles,
    iconKeywords,
    affiliationKeywords,
    allyKeywords,
    iconReference,
    keywords
  };
}

function normalizeLexicon(raw: unknown): RulebookLexicon | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const cardTypes = normalizeStringArray(record.cardTypes);
  if (cardTypes.length === 0) {
    return null;
  }

  const styles = normalizeStringArray(record.styles);
  const iconKeywordsRaw = asRecord(record.iconKeywords);
  const iconKeywords = {
    attack: normalizeStringArray(iconKeywordsRaw?.attack),
    defense: normalizeStringArray(iconKeywordsRaw?.defense),
    quick: normalizeStringArray(iconKeywordsRaw?.quick),
    constant: normalizeStringArray(iconKeywordsRaw?.constant)
  };
  iconKeywords.defense = iconKeywords.defense.filter((value) => {
    const normalized = value.trim().toLowerCase();
    return normalized !== "stop" && normalized !== "stops";
  });
  const affiliationKeywordsRaw = asRecord(record.affiliationKeywords);
  const affiliationKeywords = {
    hero: normalizeStringArray(affiliationKeywordsRaw?.hero),
    villain: normalizeStringArray(affiliationKeywordsRaw?.villain),
    neutral: normalizeStringArray(affiliationKeywordsRaw?.neutral)
  };
  const allyKeywords = normalizeStringArray(record.allyKeywords);

  const iconReferenceRaw = asRecord(record.iconReference);
  const iconsRaw = asRecord(iconReferenceRaw?.icons);
  const attackRaw = asRecord(iconsRaw?.attack);
  const defenseRaw = asRecord(iconsRaw?.defense);
  const constantRaw = asRecord(iconsRaw?.constant);
  const quickRaw = asRecord(iconsRaw?.quick);

  const fallbackIconReference = buildFallbackIconReference();
  const iconReference: RulebookLexicon["iconReference"] = {
    pageNumber: toInteger(iconReferenceRaw?.pageNumber) ?? fallbackIconReference.pageNumber,
    sourceImagePath: toStringValue(iconReferenceRaw?.sourceImagePath) ?? fallbackIconReference.sourceImagePath,
    sourcePdfPath: toStringValue(iconReferenceRaw?.sourcePdfPath) ?? fallbackIconReference.sourcePdfPath,
    extractedAt: toStringValue(iconReferenceRaw?.extractedAt) ?? fallbackIconReference.extractedAt,
    icons: {
      attack: {
        symbolName: toStringValue(attackRaw?.symbolName) ?? fallbackIconReference.icons.attack.symbolName,
        marker: toStringValue(attackRaw?.marker) ?? fallbackIconReference.icons.attack.marker,
        meaning: toStringValue(attackRaw?.meaning) ?? fallbackIconReference.icons.attack.meaning,
        cues: normalizeStringArray(attackRaw?.cues),
        assetPath: toStringValue(attackRaw?.assetPath)
      },
      defense: {
        symbolName: toStringValue(defenseRaw?.symbolName) ?? fallbackIconReference.icons.defense.symbolName,
        marker: toStringValue(defenseRaw?.marker) ?? fallbackIconReference.icons.defense.marker,
        meaning: toStringValue(defenseRaw?.meaning) ?? fallbackIconReference.icons.defense.meaning,
        cues: normalizeStringArray(defenseRaw?.cues).filter((value) => {
          const normalized = value.trim().toLowerCase();
          return normalized !== "stop" && normalized !== "stops";
        }),
        assetPath: toStringValue(defenseRaw?.assetPath)
      },
      constant: {
        symbolName: toStringValue(constantRaw?.symbolName) ?? fallbackIconReference.icons.constant.symbolName,
        marker: toStringValue(constantRaw?.marker) ?? fallbackIconReference.icons.constant.marker,
        meaning: toStringValue(constantRaw?.meaning) ?? fallbackIconReference.icons.constant.meaning,
        cues: normalizeStringArray(constantRaw?.cues),
        assetPath: toStringValue(constantRaw?.assetPath)
      },
      quick: {
        symbolName: toStringValue(quickRaw?.symbolName) ?? fallbackIconReference.icons.quick.symbolName,
        marker: toStringValue(quickRaw?.marker) ?? fallbackIconReference.icons.quick.marker,
        meaning: toStringValue(quickRaw?.meaning) ?? fallbackIconReference.icons.quick.meaning,
        cues: normalizeStringArray(quickRaw?.cues),
        assetPath: toStringValue(quickRaw?.assetPath)
      }
    }
  };

  for (const key of ["attack", "defense", "quick", "constant"] as const) {
    if (iconKeywords[key].length === 0) {
      iconKeywords[key] = [...fallbackIconReference.icons[key].cues];
    }
    if (iconReference.icons[key].cues.length === 0) {
      iconReference.icons[key].cues = [...fallbackIconReference.icons[key].cues];
    }
  }
  if (affiliationKeywords.hero.length === 0) {
    affiliationKeywords.hero = ["hero", "heroes", "heroes only", "heroic"];
  }
  if (affiliationKeywords.villain.length === 0) {
    affiliationKeywords.villain = ["villain", "villains", "villains only", "villainous"];
  }
  if (affiliationKeywords.neutral.length === 0) {
    affiliationKeywords.neutral = ["neutral", "non-aligned", "unaligned"];
  }
  if (allyKeywords.length === 0) {
    allyKeywords.push("ally", "allies", "ally card");
  }

  const keywords = normalizeStringArray(record.keywords);
  if (keywords.length === 0) {
    keywords.push(...cardTypes, ...styles);
  }

  return {
    cardTypes,
    styles,
    iconKeywords,
    affiliationKeywords,
    allyKeywords,
    iconReference,
    keywords: Array.from(new Set(keywords))
  };
}

function buildFallbackIconReference(): RulebookLexicon["iconReference"] {
  return {
    pageNumber: DEFAULT_RULEBOOK_ICON_PAGE_NUMBER,
    sourceImagePath: DEFAULT_RULEBOOK_ICON_PAGE_IMAGE,
    sourcePdfPath: DEFAULT_RULEBOOK_PDF,
    extractedAt: new Date(0).toISOString(),
    icons: {
      attack: {
        symbolName: "crossed-swords",
        marker: ICON_MARKERS.attack,
        meaning: "A card that performs an attack.",
        cues: ["attack", "physical attack", "energy attack", "combat", "damage"],
        assetPath: null
      },
      defense: {
        symbolName: "shield",
        marker: ICON_MARKERS.defense,
        meaning: "A defensive card that can be used against attacks.",
        cues: ["defense", "defend", "block", "prevent", "stops an attack"],
        assetPath: null
      },
      constant: {
        symbolName: "infinity",
        marker: ICON_MARKERS.constant,
        meaning: "A continuous effect that is constantly active while the card is in play.",
        cues: ["constant", "continuous effect", "while this card is in play", "while in play"],
        assetPath: null
      },
      quick: {
        symbolName: "lightning-bolt",
        marker: ICON_MARKERS.quick,
        meaning: "An effect with contextual timing that can be instantly played or used.",
        cues: ["quick", "immediately", "instantly", "whenever appropriate", "contextual timing"],
        assetPath: null
      }
    }
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function toStringValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
