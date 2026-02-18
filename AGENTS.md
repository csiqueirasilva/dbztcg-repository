# AGENTS.md

This repository is a **TypeScript monorepo** using **pnpm workspaces**. It is designed to support three major areas:

1) **Scraping** (download/collect images + metadata)  
2) **OCR / LLM parsing pipeline** (turn images into structured data)  
3) **UI applications** (React deck builder and related apps deployed on GitHub Pages)

The root `package.json` and `tsconfig.base.json` already exist and should stay **lean**. Add most dependencies inside the relevant workspace package/app.

---

## 1) Repository layout (target)

```
repo/
  package.json              # workspace + shared dev tooling only (keep small)
  pnpm-workspace.yaml       # workspace package globs
  tsconfig.base.json        # shared TS compiler defaults
  README.md
  .gitignore

  packages/
    core/                   # shared TS utilities (node+browser safe)
    schema/                 # zod schemas + inferred types (single source of truth)
    scraper/                # headless scraping + downloading (Node-only)
    pipeline/               # OCR + LLM parsing + DB building (Node-only)
    data/                   # versioned outputs (JSON/YAML) + helpers for apps

  apps/
    deck-builder/           # React UI (Vite recommended)
    (optional later) other-app/
```

### Workspace responsibilities

- **`packages/schema`** is the **contract** for everything: scraper outputs, pipeline normalized data, and UI expectations.
- **`packages/data`** is where the “built database” lives (e.g., `cards.v1.json`, `sets.v1.json`) and is consumed by the UI.
- **`packages/scraper`** should focus on extracting URLs and downloading assets (plus minimal metadata).
- **`packages/pipeline`** should do the heavy lifting: OCR, LLM parsing, validation against schemas, and DB outputs.
- **`apps/*`** are UIs. They should import types/schemas/data from packages instead of duplicating.

---

## 2) Setup (local)

### Requirements

- Node.js **18+** (prefer LTS)
- pnpm **8+** (prefer via Corepack)

Enable pnpm with Corepack (once):

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

### Install dependencies

From repo root:

```bash
pnpm install
```

If `packages/scraper` uses Playwright, install browsers (once):

```bash
pnpm --filter @dbzccg/scraper exec playwright install chromium
```

---

## 3) Scripts and how to run things

Run workspace scripts from root:

```bash
# Scraper
pnpm --filter @dbzccg/scraper run scrape

# Pipeline (OCR/LLM/DB build)
pnpm --filter @dbzccg/pipeline run build

# React deck builder (dev)
pnpm --filter @dbzccg/deck-builder run dev

# React deck builder (prod build)
pnpm --filter @dbzccg/deck-builder run build

# Database manager (Electron desktop app, local-only)
pnpm --filter @dbzccg/database-manager run dev
```

Root scripts may exist as shortcuts; the canonical way is `pnpm --filter <workspace> run <script>`.

### Local-only app note

- `@dbzccg/database-manager` must be executed locally (Electron).
- It is **not** a GitHub Pages deployment target and should not be treated as a static web app.

### Screenshot debugging workflow

- During development, screenshots can be placed in the repo-root `llm-screenshots/` directory.
- The agent may ask you to place screenshots there when visual debugging is needed.
- The agent must only read files from `llm-screenshots/` when you explicitly ask it to read them, or after it asks for confirmation.
- The agent should only read screenshots that are recent and clearly relevant to the active task, and should avoid scanning unrelated files.

---

## 4) Adding a new workspace (do this exactly)

1) Create a folder:
   - `packages/<name>/` for libraries/tools
   - `apps/<name>/` for UIs

2) Ensure `pnpm-workspace.yaml` includes the workspace globs (`packages/*`, `apps/*`) or update it if needed.

3) Add a `package.json` with a scoped name:
   - `@dbzccg/<name>`

4) Keep dependencies local to the workspace. Avoid adding runtime dependencies to the root.

5) Add a `tsconfig.json` in the workspace that extends root `tsconfig.base.json`.

---

## 5) Dependency rules (prevents root bloat)

### Root `package.json`

Allowed:
- shared dev tooling (TypeScript, lint tooling, formatting, etc.)
- workspace orchestration scripts

Avoid:
- Playwright, axios, OCR libs, React, etc. (those belong in each package/app)

### Workspace `package.json`

- **Node-only tools** live in `packages/scraper` and `packages/pipeline`
- **Browser-safe utilities** live in `packages/core`
- **Schemas** live in `packages/schema` only

---

## 6) Data contract and versioning

### Single source of truth

- All structural definitions live in **`packages/schema`** using Zod.
- Everything else validates against it.

### Suggested versioning convention

- Output files in `packages/data/data/` should be versioned:
  - `cards.v1.json`, `sets.v1.json`, `decks.v1.json`
- If the schema changes incompatibly:
  - create `v2` outputs rather than overwriting `v1`

### Validation rule

When reading data (pipeline or UI):
- validate with Zod
- fail fast with useful error messages

---

## 7) Image storage policy (choose one and stick to it)

Images can become large quickly. Pick a policy early:

### Option A (recommended): do NOT commit raw images

- Store scraped images locally only.
- Commit only:
  - scripts
  - schemas
  - built structured data (JSON/YAML)
- Add raw folders to `.gitignore` (example):
  - `packages/data/raw/`

### Option B: commit images (only if you must)

- Consider Git LFS for large sets.
- Keep them in `packages/data/raw/images/`.
- Be aware that repo size will grow and clone times will degrade.

---

## 8) CLI conventions (keep tasks consistent)

All Node tools should support CLI usage with consistent flags:

### Scraper example

- `dbzccg scrape --url <URL> --selector ".blocks-gallery-item img" --out <dir>`

### Pipeline examples

- `dbzccg ocr --in <imagesDir> --out <ocrJsonDir>`
- `dbzccg parse --in <ocrJsonDir> --out <structuredDir>`
- `dbzccg build-db --in <structuredDir> --out packages/data/data/cards.v1.json`

Keep CLI arguments explicit; avoid interactive prompts by default.

---

## 9) GitHub Pages deployment (multiple apps)

This repo is intended to deploy React apps to **GitHub Pages**.

### Base path rule (Vite)

Each app must set `base` so it works under a subpath:

- `https://<user>.github.io/<repo>/deck-builder/`
- `https://<user>.github.io/<repo>/viewer/`

Each app’s Vite config should set:

- deck builder: `base: "/<repo>/deck-builder/"`
- viewer: `base: "/<repo>/viewer/"`

### Single Pages site, multiple SPAs

Build output should publish a single static site containing:
- `/deck-builder/`
- `/viewer/`
- etc.

---

## 10) Sharing deck data across apps (important)

Yes, apps can share saved decks **if** they are served from the same origin.

### Works when:

- Both apps are under the same domain, e.g.
  - `https://<user>.github.io/<repo>/deck-builder/`
  - `https://<user>.github.io/<repo>/viewer/`

They share origin: `https://<user>.github.io`  
So they can share:
- `localStorage`
- `IndexedDB`

### Does NOT work when:

- different GitHub usernames/orgs (different host)
- different domains (custom domain vs github.io)

### Storage best practices

- Use namespaced keys:
  - `dbzccg:decks:v1`
- Include schema version in the stored payload
- Validate on read using `@dbzccg/schema`

---

## 11) Contribution checklist (before opening PR)

1) Code lives in the correct workspace (`packages/*` or `apps/*`)
2) New dependencies are added **only** in that workspace
3) Data structures are defined/updated in `packages/schema`
4) Pipeline/UI uses schemas rather than duplicating types
5) Scripts remain CLI-friendly (no hidden assumptions)

---

## 12) Implementation priority (recommended order)

1) `packages/schema` (minimal but stable: Card, Deck)
2) `packages/scraper` (download images reliably)
3) `packages/pipeline` (OCR + parsing + normalized outputs)
4) `packages/data` (versioned built DB artifacts)
5) `apps/deck-builder` (React UI consuming `@dbzccg/data`)
