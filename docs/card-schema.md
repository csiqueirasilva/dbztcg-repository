# Card Schema Reference

Canonical Zod source: `packages/schema/src/card.ts`

This document defines the DB contract for `packages/data/data/cards.v1.json`.

## Core card fields

- Identity:
  - `id`, `setCode`, `setName`, `printedNumber`, `rarityPrefix`
- Naming:
  - `name`, `title`, `characterKey`, `personalityFamilyId`
- Type model:
  - `cardType` (`personality` is used for both main personalities and allies)
  - `affiliation`, `isMainPersonality`, `isAlly`
  - `cardSubtypes`, `style`, `tags`
- Gameplay text/stats:
  - `powerStageValues`, `pur`, `endurance`, `personalityLevel`
  - `mainPowerText`, `cardTextRaw`, `effectChunks`, `icons`
- Source/audit:
  - `source`, `confidence`, `review`, `raw`

## Derived metadata fields

All fields below are accepted as optional/nullish on input, then normalized to deterministic persisted values by `CardSchema` transform rules in `packages/schema/src/card.ts`.

- `considered_as_styled_card: boolean`
  - Default: `false`
  - True when text indicates the card is considered styled.
- `limit_per_deck: number`
  - Text override: `Limit X per deck` variants.
  - Default: `1` for `personality`, `mastery`, `dragon_ball`; otherwise `3`.
- `banished_after_use: boolean`
  - Default: `false`
  - True when text says banish/remove after use.
- `shuffle_into_deck_after_use: boolean`
  - Default: `false`
  - True when text says shuffle into owner/your deck after use.

- `drill_not_discarded_when_changing_levels: boolean`
  - Default: `false`
  - Auto-detected only for `drill` cards.
- `attach_limit: number | "infinity"`
  - Default: `"infinity"`
  - Parsed from text like `You may only have X ... attached`.
- `extraordinary_can_play_from_hand: boolean`
  - Default: `false`
  - Auto-detected for ally/setup/drill/dragon ball language.
- `has_effect_when_discarded_combat: boolean`
  - Default: `false`
  - True for patterns like `If this card is discarded from your hand during combat...`.
- `seaches_owner_life_deck: boolean`
  - Default: `false`
  - True for `Search your Life Deck`/owner deck patterns.

- `rejuvenates_amount: number | null`
  - Default: `null` (absent).
- `conditional_rejuvenate: boolean`
  - Default: `false`.
  - Conditional rejuvenate resolves amount to `0` with flag `true`.

- `endurance: number | null`
  - Default: `null` (absent).
- `conditional_endurance: boolean`
  - Default: `false`.
  - Conditional endurance resolves amount to `0` with flag `true`.

- `raise_your_anger: number | null`
  - Default: `null` (absent).
- `conditional_raise_your_anger: boolean`
  - Default: `false`.

- `lower_your_anger: number | null`
  - Default: `null` (absent).
- `conditional_lower_your_anger: boolean`
  - Default: `false`.

- `raise_or_lower_any_player_anger: number | null`
  - Default: `null` (absent).
- `conditional_raise_or_lower_any_player_anger: boolean`
  - Default: `false`.

- `when_drill_enters_play_during_combat: boolean`
  - Default: `false`.
- `when_drill_enters_play: boolean`
  - Default: `false`.

- `attaches_own_main_personality: boolean`
  - Default: `false`.
- `attaches_opponent_main_personality: boolean`
  - Default: `false`.

## Normalization priority

For derived fields:

1. Use explicit parsed value when valid.
2. Otherwise infer from `cardTextRaw`/`mainPowerText`.
3. Otherwise apply deterministic default.

This keeps older records loadable while enforcing consistent persisted shape.

## Migration workflow (no OCR/LLM rerun)

After adding new metadata fields or detection logic, re-normalize existing cards with:

```bash
pnpm run migrate:metadata
```

This revalidates and rewrites `packages/data/data/cards.v1.json` via `CardSchema` transforms only.
