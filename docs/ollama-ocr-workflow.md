# Ollama OCR Workflow (`glm-ocr`)

This project supports local OCR via Ollama and treats it as the preferred OCR source when available.

## Runtime strategy

- `DBZCCG_OCR_ENGINE=auto`
  - tries Ollama first
  - falls back to Tesseract when Ollama fails or returns empty text
- `DBZCCG_OCR_ENGINE=ollama-glm-ocr`
  - forces Ollama only
- `DBZCCG_OCR_ENGINE=hybrid`
  - runs Ollama and Tesseract, then merges text lines
  - recommended when icon markers are flaky on one engine alone
- `DBZCCG_OCR_ENGINE=tesseract-cli`
  - forces Tesseract only
- `DBZCCG_OCR_ENGINE=none`
  - disables OCR

## Setup

```bash
ollama pull glm-ocr
ollama serve
```

You can also keep these defaults in repo-root `.env.local` (see `.env.local.example`).

## Rescan example (Ollama-first)

```bash
DBZCCG_OCR_ENGINE=auto \
DBZCCG_OCR_OLLAMA_MODEL=glm-ocr:latest \
pnpm --filter @dbzccg/pipeline run rescan:card -- --image "packages/data/raw/images/Heroes & Villains/C02-Nail-Protector-Lv.-2-2.jpg"
```

## Rescan example (Hybrid OCR for icon robustness)

```bash
DBZCCG_OCR_ENGINE=hybrid \
DBZCCG_OCR_OLLAMA_MODEL=glm-ocr:latest \
pnpm --filter @dbzccg/pipeline run rescan:card -- --image "packages/data/raw/images/Heroes & Villains/C02-Nail-Protector-Lv.-2-2.jpg"
```

## Dry OCR check example

```bash
DBZCCG_OCR_ENGINE=ollama-glm-ocr \
DBZCCG_OCR_OLLAMA_MODEL=glm-ocr:latest \
pnpm --filter @dbzccg/pipeline exec tsx -e "import { runOcr } from './src/ocr/run-ocr.ts'; import path from 'node:path'; (async()=>{ const image=path.resolve('../data/raw/images/Heroes & Villains/C02-Nail-Protector-Lv.-2-2.jpg'); const result=await runOcr(image); console.log(result.text); })();"
```

## HNV-C02 example: before and after

### Before (low OCR/LLM signal)

`HNV-C02` in review had:

- `powerStageValues: [2, 0]`
- `pur: null`
- `mainPowerText: null`
- reasons included:
  - `missing_critical_field`
  - `type_conflict:missing_power_stage_ladder`

### After (using `glm-ocr`)

OCR text includes:

- `2 LEVEL`, `NAIL`, `PROTECTOR`
- full stage ladder `40,000 ... 0`
- `3 PUR`
- power text:
  - `Whenever your opponent stops one of your attacks...`
  - `After your opponent takes damage ... Endurance ...`

This gives the parser enough signal to recover personality-critical fields:

- `personalityLevel`
- full `powerStageValues`
- `pur`
- `mainPowerText`

Additionally, icon inference uses strict icon-presence signals:

- LLM icon booleans (when available)
- normalized OCR/text markers (`[attack icon]`, `[defense icon]`, `[constant icon]`, `[timing icon]`)

It no longer flips icons on from generic text cues alone (for example, text containing "attacks" without the attack icon).

## Optional environment variables

- `DBZCCG_OCR_OLLAMA_ENDPOINT` (default `http://127.0.0.1:11434`)
- `DBZCCG_OCR_OLLAMA_TIMEOUT_MS` (default `300000`)
- `DBZCCG_OCR_OLLAMA_ATTEMPTS` (default `3`)
- `DBZCCG_OCR_OLLAMA_RETRY_DELAY_MS` (default `3000`)
- `DBZCCG_OCR_OLLAMA_KEEP_ALIVE` (default `10m`)
- `DBZCCG_OCR_OLLAMA_MODEL` (default `glm-ocr`)
- `DBZCCG_OCR_OLLAMA_PROMPT` (custom OCR prompt text)

For lower-end GPUs, prefer a higher timeout and at least 2 attempts to avoid aborting during long generations.
