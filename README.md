# dbztcg-repository

## Database Manager (Local-only)

`@dbzccg/database-manager` is an Electron desktop tool and must be run locally on your machine.

```bash
pnpm --filter @dbzccg/database-manager run dev
```

It is not meant for GitHub Pages deployment.

On Linux, the dev/start scripts already pass Electron sandbox flags (`--no-sandbox --disable-setuid-sandbox`) to avoid the `chrome-sandbox` SUID permission error in local development.

### Database Manager Scan Controls

- The app now exposes a `Scan` mode that lists all images under `packages/data/raw/images/`.
- Each image is marked as:
  - `accepted` (present in `cards.v1.json`)
  - `review` (present in `review-queue.v1.json`)
  - `unread` (not yet parsed)
- In the edit screen, `Rescan This Card` runs a single-card pipeline pass and incrementally upserts data.

## Data Model Notes

- Full card schema reference: `docs/card-schema.md` (source: `packages/schema/src/card.ts`).
- `cardType: "personality"` is used for both main personalities and allies.
- Use flags for personality identity:
  - `isMainPersonality: true` for main personalities.
  - `isAlly: true` for allies.
- Personality stage data is stored only in `powerStageValues` (descending ladder ending in `0`).
- `endurance` is nullable (`null` when absent on the card).
- Deck/rule derived fields:
  - `considered_as_styled_card`
  - `limit_per_deck`
  - `banished_after_use`
  - `shuffle_into_deck_after_use`
  - Extended metadata flags/values for attach limits, drill enter-play triggers, combat discard triggers, life deck search,
    rejuvenate/endurance/anger conditional amounts, and MP-attach targets (see `docs/card-schema.md`).
- `rarityPrefix` is inferred from `printedNumber` prefix:
  - `C` Common, `U` Uncommon, `R` Rare, `UR` Ultra Rare, `DR` Dragon Rare, `S` Starter, `P` Promo.
  - A card has a single rarity value.

## Personality Migration / Reset

After switching older data from legacy `main_personality` / `ally` values:

```bash
pnpm run migrate:personality
```

To wipe `cards.v1.json` and `review-queue.v1.json` before a fully fresh run:

```bash
pnpm run reset:data
```

## Incremental Single-Card Parse (CLI)

You can rescan and upsert one card image without rebuilding the whole set/database:

```bash
pnpm --filter @dbzccg/pipeline run rescan:card -- --image <absolute-or-relative-image-path>
```

Reprint reuse is enabled by default for both full builds and single-card rescans:
- It matches by normalized filename-inferred name/title against already parsed cards/review items.
- If matched, it clones the existing structured result (or review item) for the new print and skips OCR/LLM.
- Disable with `--no-reprint-reuse` when you want a fresh parse.

## Metadata-Only Migration (No Rescan)

When you add new metadata fields derived from existing card text, you can backfill `cards.v1.json` without rerunning OCR/LLM:

```bash
pnpm run migrate:metadata
```

Dry run:

```bash
pnpm run migrate:metadata -- --dry-run
```

## OCR Strategy: Ollama First (`glm-ocr`)

See `docs/ollama-ocr-workflow.md` for setup, env strategy (`auto`/`ollama`/`hybrid`), dry-run commands, and the `HNV-C02` before/after example.

## Local Env Defaults (`.env.local`)

- Repo root supports `.env.local` for local OCR defaults.
- `apps/database-manager` loads `.env.local` on startup and passes it to pipeline rescan commands.
- `@dbzccg/pipeline` CLI/tools also load `.env.local` automatically.
- Start from the template:

```bash
cp .env.local.example .env.local
```

## Rulebook Icon Markers And Assets

- Rulebook text extraction now injects explicit icon markers:
  - `[attack icon]`
  - `[defense icon]`
  - `[constant icon]`
  - `[timing icon]`
- High-resolution transparent PNG assets are generated at:
  - `packages/data/raw/intermediate/rulebook-icons/`
- To regenerate rulebook text + lexicon + icon assets:

```bash
pnpm --filter @dbzccg/pipeline run extract:rulebook
```
