import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { OcrResult } from "../types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TESSERACT_TIMEOUT_MS = 45_000;
const DEFAULT_OLLAMA_TIMEOUT_MS = 300_000;
const DEFAULT_OLLAMA_ATTEMPTS = 3;
const DEFAULT_OLLAMA_RETRY_DELAY_MS = 3_000;
const DEFAULT_OLLAMA_KEEP_ALIVE = "10m";
const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "glm-ocr";
const DEFAULT_OLLAMA_PROMPT =
  "Extract all readable text from this Dragon Ball Z TCG card image. Return plain text only, preserving line breaks.";

export async function runOcr(imagePath: string): Promise<OcrResult> {
  const configuredEngine = (process.env.DBZCCG_OCR_ENGINE ?? "tesseract-cli").trim().toLowerCase();
  if (configuredEngine === "none") {
    return {
      text: "",
      engine: "none",
      warnings: ["OCR disabled via DBZCCG_OCR_ENGINE=none"],
      blocks: []
    };
  }

  if (configuredEngine === "ollama" || configuredEngine === "ollama-glm-ocr") {
    return runOllamaOcr(imagePath);
  }

  if (configuredEngine === "hybrid" || configuredEngine === "ollama+tesseract") {
    return runHybridOcr(imagePath);
  }

  if (configuredEngine === "auto") {
    const ollamaResult = await runOllamaOcr(imagePath);
    if (ollamaResult.text.trim().length > 0) {
      return ollamaResult;
    }
    const tesseractResult = await runTesseractOcr(imagePath);
    return {
      ...tesseractResult,
      warnings: [...ollamaResult.warnings, ...tesseractResult.warnings]
    };
  }

  return runTesseractOcr(imagePath);
}

async function runTesseractOcr(imagePath: string): Promise<OcrResult> {
  try {
    const { stdout } = await execFileAsync(
      "tesseract",
      [imagePath, "stdout", "--psm", "6", "--dpi", "300"],
      {
        timeout: DEFAULT_TESSERACT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024
      }
    );

    return {
      text: stdout.trim(),
      engine: "tesseract-cli",
      warnings: [],
      blocks: []
    };
  } catch (error) {
    return {
      text: "",
      engine: "tesseract-cli",
      warnings: [`OCR failed for ${imagePath}: ${error instanceof Error ? error.message : String(error)}`],
      blocks: []
    };
  }
}

async function runOllamaOcr(imagePath: string): Promise<OcrResult> {
  const endpoint = (process.env.DBZCCG_OCR_OLLAMA_ENDPOINT ?? DEFAULT_OLLAMA_ENDPOINT).trim().replace(/\/+$/g, "");
  const model = (process.env.DBZCCG_OCR_OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;
  const prompt = (process.env.DBZCCG_OCR_OLLAMA_PROMPT ?? DEFAULT_OLLAMA_PROMPT).trim() || DEFAULT_OLLAMA_PROMPT;
  const timeoutMs = parsePositiveInt(process.env.DBZCCG_OCR_OLLAMA_TIMEOUT_MS, DEFAULT_OLLAMA_TIMEOUT_MS);
  const attempts = Math.max(1, parsePositiveInt(process.env.DBZCCG_OCR_OLLAMA_ATTEMPTS, DEFAULT_OLLAMA_ATTEMPTS));
  const retryDelayMs = parsePositiveInt(
    process.env.DBZCCG_OCR_OLLAMA_RETRY_DELAY_MS,
    DEFAULT_OLLAMA_RETRY_DELAY_MS
  );
  const keepAlive = (process.env.DBZCCG_OCR_OLLAMA_KEEP_ALIVE ?? DEFAULT_OLLAMA_KEEP_ALIVE).trim();
  let imageBuffer: Buffer;
  try {
    imageBuffer = await readFile(imagePath);
  } catch (error) {
    return {
      text: "",
      engine: "ollama-glm-ocr",
      warnings: [
        `Ollama OCR failed for ${imagePath} (model=${model}, endpoint=${endpoint}): ${stringifyError(error)}`
      ],
      blocks: []
    };
  }
  const warnings: string[] = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetch(`${endpoint}/api/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          images: [imageBuffer.toString("base64")],
          ...(keepAlive.length > 0 ? { keep_alive: keepAlive } : {})
        }),
        signal: abortController.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const payload = (await response.json()) as {
        response?: unknown;
        error?: unknown;
      };
      const payloadError = asNonEmptyString(payload.error);
      if (payloadError) {
        throw new Error(payloadError);
      }

      const text = asNonEmptyString(payload.response) ?? "";
      if (!text) {
        const emptyWarning =
          `Ollama OCR attempt ${attempt}/${attempts} returned empty text for ${imagePath} ` +
          `(model=${model}, timeout=${timeoutMs}ms).`;
        if (attempt < attempts) {
          warnings.push(emptyWarning);
          await delay(retryDelayMs * attempt);
          continue;
        }
        return {
          text: "",
          engine: "ollama-glm-ocr",
          warnings: [...warnings, emptyWarning],
          blocks: []
        };
      }

      const elapsedMs = Date.now() - startedAt;
      const retryWarnings =
        attempt > 1
          ? [`Ollama OCR succeeded on retry ${attempt}/${attempts} (${elapsedMs}ms).`, ...warnings]
          : warnings;
      return {
        text,
        engine: "ollama-glm-ocr",
        warnings: retryWarnings,
        blocks: []
      };
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const errorText = stringifyError(error);
      const attemptWarning =
        `Ollama OCR attempt ${attempt}/${attempts} failed for ${imagePath} ` +
        `(model=${model}, endpoint=${endpoint}, timeout=${timeoutMs}ms, elapsed=${elapsedMs}ms): ${errorText}`;
      const retryable = isRetryableOllamaError(errorText);
      if (retryable && attempt < attempts) {
        warnings.push(attemptWarning);
        await delay(retryDelayMs * attempt);
        continue;
      }

      warnings.push(attemptWarning);
      return {
        text: "",
        engine: "ollama-glm-ocr",
        warnings: [
          ...warnings,
          `Ollama OCR failed for ${imagePath} (model=${model}, endpoint=${endpoint}) after ${attempt} attempt(s).`
        ],
        blocks: []
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    text: "",
    engine: "ollama-glm-ocr",
    warnings: [`Ollama OCR failed for ${imagePath} (model=${model}, endpoint=${endpoint})`],
    blocks: []
  };
}

async function runHybridOcr(imagePath: string): Promise<OcrResult> {
  const [ollamaResult, tesseractResult] = await Promise.all([runOllamaOcr(imagePath), runTesseractOcr(imagePath)]);
  const mergedText = mergeOcrTexts(ollamaResult.text, tesseractResult.text);
  const warnings: string[] = [];
  const ollamaHasText = ollamaResult.text.trim().length > 0;
  const tesseractHasText = tesseractResult.text.trim().length > 0;

  if (ollamaHasText) {
    if (tesseractResult.warnings.length > 0 && !tesseractHasText) {
      warnings.push("Hybrid OCR note: secondary engine returned no text; primary output was used.");
    }
  } else {
    warnings.push(...ollamaResult.warnings);
    warnings.push(...tesseractResult.warnings);
  }

  if (!mergedText.trim()) {
    warnings.unshift(`Hybrid OCR produced empty text for ${imagePath}.`);
  }

  return {
    text: mergedText,
    engine: "hybrid-ocr",
    warnings,
    blocks: []
  };
}

function mergeOcrTexts(primaryText: string, secondaryText: string): string {
  const lines = [...splitTextLines(primaryText), ...splitTextLines(secondaryText)];
  if (lines.length === 0) {
    return "";
  }
  const uniqueLines: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const normalized = line.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    uniqueLines.push(line);
  }
  return uniqueLines.join("\n");
}

function splitTextLines(value: string): string[] {
  return value
    .split(/\r?\n/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message.trim().length > 0) {
      return `${error.message} (${cause.message})`;
    }
    if (typeof cause === "string" && cause.trim().length > 0) {
      return `${error.message} (${cause.trim()})`;
    }
    return error.message;
  }
  return String(error);
}

function isRetryableOllamaError(errorText: string): boolean {
  const normalized = errorText.toLowerCase();
  return (
    normalized.includes("operation was aborted") ||
    normalized.includes("aborterror") ||
    normalized.includes("fetch failed") ||
    normalized.includes("socket hang up") ||
    normalized.includes("econnreset") ||
    normalized.includes("etimedout") ||
    normalized.includes("http 429") ||
    normalized.includes("http 500") ||
    normalized.includes("http 502") ||
    normalized.includes("http 503") ||
    normalized.includes("http 504")
  );
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
