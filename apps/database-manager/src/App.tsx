import { useEffect, useMemo, useRef, useState } from "react";
import type { CardRecord, ImageInventoryItem, LoadPayload, ReviewQueueItem } from "./types";

type Mode = "review" | "database" | "scan";
type ScanStatusFilter = "all" | "unread" | "accepted" | "review";

const SET_NAME_BY_CODE: Record<string, string> = {
  AWA: "Awakening",
  EVO: "Evolution",
  HNV: "Heroes & Villains",
  MOV: "Movie Collection",
  PER: "Perfection",
  PRE: "Premiere Set",
  VEN: "Vengeance"
};
const SET_ORDER = ["AWA", "EVO", "HNV", "MOV", "PER", "PRE", "VEN"];
const RARITY_ORDER = ["C", "U", "R", "UR", "DR", "S", "P", "UNK"] as const;
const RARITY_SET = new Set<string>(RARITY_ORDER);
const RARITY_RANK: Record<string, number> = Object.fromEntries(
  RARITY_ORDER.map((rarity, index) => [rarity, index])
) as Record<string, number>;
const SCAN_PAGE_SIZE_OPTIONS = [40, 80, 120, 200] as const;
const ICON_MARKER_TO_ASSET_FILE: Record<string, string> = {
  "[attack icon]": "attack-icon.png",
  "[defense icon]": "defense-icon.png",
  "[constant icon]": "constant-icon.png",
  "[timing icon]": "timing-icon.png",
  "[quick icon]": "timing-icon.png"
};

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-ink shadow-sm outline-none transition focus:border-sea focus:ring-2 focus:ring-sea/20";
const TEXTAREA_CLASS = `${INPUT_CLASS} min-h-[110px] resize-y`;
const imageSourceCache = new Map<string, string>();

interface AdvancedEditorErrors {
  effectChunks?: string;
  confidenceFields?: string;
  rawBlocks?: string;
}

interface ScanProgressState {
  current: number;
  total: number;
  imageFileName: string;
}

export default function App() {
  const [mode, setMode] = useState<Mode>("review");
  const [cards, setCards] = useState<CardRecord[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>([]);
  const [imageInventory, setImageInventory] = useState<ImageInventoryItem[]>([]);
  const [payloadPaths, setPayloadPaths] = useState<LoadPayload["paths"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [scanStatusFilter, setScanStatusFilter] = useState<ScanStatusFilter>("all");
  const [scanPageSize, setScanPageSize] = useState<number>(80);
  const [scanPage, setScanPage] = useState<number>(1);
  const [selectedCardId, setSelectedCardId] = useState("");
  const [selectedReviewKey, setSelectedReviewKey] = useState("");
  const [selectedScanImagePath, setSelectedScanImagePath] = useState("");
  const [selectedScanImagePaths, setSelectedScanImagePaths] = useState<string[]>([]);
  const [draft, setDraft] = useState<CardRecord | null>(null);
  const [iconMarkerDataUrls, setIconMarkerDataUrls] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [rescanBusy, setRescanBusy] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgressState | null>(null);
  const [powerStageValuesText, setPowerStageValuesText] = useState("");
  const [effectChunksText, setEffectChunksText] = useState("[]");
  const [confidenceFieldsText, setConfidenceFieldsText] = useState("{}");
  const [rawBlocksText, setRawBlocksText] = useState("[]");
  const [advancedErrors, setAdvancedErrors] = useState<AdvancedEditorErrors>({});
  const [showIconEvidence, setShowIconEvidence] = useState(false);
  const [showTechnicalScan, setShowTechnicalScan] = useState(false);
  const editorPanelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    void loadDatabase();
  }, []);

  useEffect(() => {
    if (!payloadPaths || !window.databaseManagerApi?.readImageDataUrl) {
      setIconMarkerDataUrls({});
      return;
    }
    const repoRoot = payloadPaths.repoRoot;
    let cancelled = false;
    const iconEntries = Object.entries(ICON_MARKER_TO_ASSET_FILE);

    async function loadMarkerIcons() {
      const loadedEntries: Array<[string, string]> = [];
      for (const [marker, fileName] of iconEntries) {
        const assetPath = `${repoRoot}/packages/data/raw/intermediate/rulebook-icons/${fileName}`;
        try {
          const dataUrl = await window.databaseManagerApi.readImageDataUrl(assetPath);
          loadedEntries.push([marker, dataUrl]);
        } catch {
          // Ignore missing icon assets; text fallback remains visible.
        }
      }
      if (!cancelled) {
        setIconMarkerDataUrls(Object.fromEntries(loadedEntries));
      }
    }

    void loadMarkerIcons();
    return () => {
      cancelled = true;
    };
  }, [payloadPaths]);

  useEffect(() => {
    setShowIconEvidence(false);
    setShowTechnicalScan(false);
  }, [draft?.id]);

  const filteredCards = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) {
      return cards;
    }
    return cards.filter((card) =>
      [
        card.id,
        card.name,
        card.title ?? "",
        card.mainPowerText ?? "",
        card.cardTextRaw ?? "",
        card.printedNumber,
        card.rarityPrefix,
        card.characterKey ?? "",
        card.cardType,
        card.isMainPersonality ? "main-personality" : "not-main-personality",
        card.affiliation,
        card.isAlly ? "ally" : "non-ally",
        card.considered_as_styled_card ? "considered-styled" : "not-considered-styled",
        `limit-${card.limit_per_deck}`,
        card.banished_after_use ? "banished-after-use" : "not-banished-after-use",
        card.shuffle_into_deck_after_use ? "shuffle-into-deck-after-use" : "not-shuffle-into-deck-after-use",
        card.setCode
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [cards, search]);

  const cardsBySet = useMemo(() => {
    const grouped = new Map<string, CardRecord[]>();
    for (const card of filteredCards) {
      const key = card.setCode || "OTHER";
      const current = grouped.get(key) ?? [];
      current.push(card);
      grouped.set(key, current);
    }

    const orderedSetCodes = Array.from(new Set([...SET_ORDER, ...Array.from(grouped.keys())]));
    return orderedSetCodes
      .map((setCode) => ({
        setCode,
        setName: SET_NAME_BY_CODE[setCode] ?? setCode,
        cards: (grouped.get(setCode) ?? []).sort((left, right) => compareCardsByRarity(left, right))
      }))
      .filter((entry) => entry.cards.length > 0);
  }, [filteredCards]);

  const filteredReviewQueue = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) {
      return reviewQueue;
    }
    return reviewQueue.filter((item) => {
      const candidateName = typeof item.candidateValues.name === "string" ? item.candidateValues.name : "";
      const candidateTitle = typeof item.candidateValues.title === "string" ? item.candidateValues.title : "";
      const candidateMainPowerText =
        typeof item.candidateValues.mainPowerText === "string" ? item.candidateValues.mainPowerText : "";
      const candidateCardTextRaw =
        typeof item.candidateValues.cardTextRaw === "string" ? item.candidateValues.cardTextRaw : "";
      const candidateDeckLimit =
        typeof item.candidateValues.limit_per_deck === "number"
          ? String(item.candidateValues.limit_per_deck)
          : typeof item.candidateValues.limitPerDeck === "number"
            ? String(item.candidateValues.limitPerDeck)
            : "";
      return [
        item.cardId,
        item.setCode,
        candidateName,
        candidateTitle,
        candidateMainPowerText,
        candidateCardTextRaw,
        candidateDeckLimit,
        item.reasons.join(" ")
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [reviewQueue, search]);

  const cardById = useMemo(() => {
    const index = new Map<string, CardRecord>();
    for (const card of cards) {
      index.set(card.id, card);
    }
    return index;
  }, [cards]);

  const cardByImagePath = useMemo(() => {
    const index = new Map<string, CardRecord>();
    for (const card of cards) {
      index.set(normalizePath(card.source.imagePath), card);
    }
    return index;
  }, [cards]);

  const filteredImageInventory = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return imageInventory.filter((item) => {
      if (scanStatusFilter !== "all" && item.status !== scanStatusFilter) {
        return false;
      }
      if (!needle) {
        return true;
      }
      const linkedCard =
        (item.cardId ? cardById.get(item.cardId) : undefined) ?? cardByImagePath.get(normalizePath(item.imagePath));
      return [
        item.setCode,
        item.setName,
        item.imageFileName,
        item.cardId ?? "",
        item.status,
        linkedCard?.name ?? "",
        linkedCard?.title ?? "",
        linkedCard?.mainPowerText ?? "",
        linkedCard?.cardTextRaw ?? ""
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [cardById, cardByImagePath, imageInventory, scanStatusFilter, search]);
  const scanTotalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredImageInventory.length / scanPageSize)),
    [filteredImageInventory.length, scanPageSize]
  );
  const pagedImageInventory = useMemo(() => {
    const startIndex = (scanPage - 1) * scanPageSize;
    return filteredImageInventory.slice(startIndex, startIndex + scanPageSize);
  }, [filteredImageInventory, scanPage, scanPageSize]);
  const scanPageStart = filteredImageInventory.length === 0 ? 0 : (scanPage - 1) * scanPageSize + 1;
  const scanPageEnd = Math.min(scanPage * scanPageSize, filteredImageInventory.length);
  const unreadImageCount = useMemo(
    () => imageInventory.filter((item) => item.status === "unread").length,
    [imageInventory]
  );
  const selectedScanPathSet = useMemo(
    () => new Set(selectedScanImagePaths.map((entry) => normalizePath(entry))),
    [selectedScanImagePaths]
  );
  const selectedScanItemsOrdered = useMemo(() => {
    if (selectedScanPathSet.size === 0) {
      return [] as ImageInventoryItem[];
    }
    const fromFiltered = filteredImageInventory.filter((item) => selectedScanPathSet.has(normalizePath(item.imagePath)));
    if (fromFiltered.length === selectedScanPathSet.size) {
      return fromFiltered;
    }
    const seenPaths = new Set(fromFiltered.map((item) => normalizePath(item.imagePath)));
    const fromInventory = imageInventory.filter((item) => {
      const normalized = normalizePath(item.imagePath);
      return selectedScanPathSet.has(normalized) && !seenPaths.has(normalized);
    });
    return [...fromFiltered, ...fromInventory];
  }, [filteredImageInventory, imageInventory, selectedScanPathSet]);
  const selectedScanCount = selectedScanItemsOrdered.length;
  const selectedScanCountOnPage = useMemo(
    () =>
      pagedImageInventory.reduce(
        (count, item) => (selectedScanPathSet.has(normalizePath(item.imagePath)) ? count + 1 : count),
        0
      ),
    [pagedImageInventory, selectedScanPathSet]
  );

  useEffect(() => {
    if (mode !== "scan") {
      return;
    }
    setScanPage(1);
  }, [mode, scanStatusFilter, search, scanPageSize]);

  useEffect(() => {
    setScanPage((current) => Math.min(current, scanTotalPages));
  }, [scanTotalPages]);

  useEffect(() => {
    if (!selectedScanImagePath) {
      return;
    }
    const selectedIndex = filteredImageInventory.findIndex((item) => item.imagePath === selectedScanImagePath);
    if (selectedIndex < 0) {
      return;
    }
    const targetPage = Math.floor(selectedIndex / scanPageSize) + 1;
    setScanPage((current) => (current === targetPage ? current : targetPage));
  }, [filteredImageInventory, scanPageSize, selectedScanImagePath]);

  useEffect(() => {
    if (imageInventory.length === 0) {
      setSelectedScanImagePaths([]);
      return;
    }
    const availablePaths = new Set(imageInventory.map((item) => normalizePath(item.imagePath)));
    setSelectedScanImagePaths((current) => {
      const next = current.filter((entry) => availablePaths.has(normalizePath(entry)));
      return next.length === current.length ? current : next;
    });
  }, [imageInventory]);

  const selectedReviewItem = useMemo(() => {
    if (!selectedReviewKey) {
      return null;
    }
    return filteredReviewQueue.find((item) => toReviewKey(item) === selectedReviewKey) ?? null;
  }, [filteredReviewQueue, selectedReviewKey]);

  const selectedScanItem = useMemo(() => {
    if (!selectedScanImagePath) {
      return null;
    }
    return filteredImageInventory.find((item) => item.imagePath === selectedScanImagePath) ?? null;
  }, [filteredImageInventory, selectedScanImagePath]);
  const draftMatchesSelectedReview = useMemo(() => {
    if (!draft || !selectedReviewItem) {
      return false;
    }
    if (draft.id === selectedReviewItem.cardId) {
      return true;
    }
    return normalizePath(draft.source.imagePath) === normalizePath(selectedReviewItem.imagePath);
  }, [draft, selectedReviewItem]);

  const selectedDraftImagePath = draft?.source.imagePath ?? selectedReviewItem?.imagePath ?? selectedScanItem?.imagePath ?? null;

  async function loadDatabase() {
    if (!window.databaseManagerApi) {
      setLoading(false);
      setError("Electron bridge unavailable. Launch with `pnpm --filter @dbzccg/database-manager run dev`.");
      return;
    }
    setLoading(true);
    setError("");
    setStatus("Loading database files...");
    try {
      const payload = await window.databaseManagerApi.load();
      const normalizedCards = payload.cards.map((card) => normalizeCardRecord(card));
      setCards(normalizedCards);
      setReviewQueue(payload.reviewQueue);
      setImageInventory(payload.imageInventory);
      setPayloadPaths(payload.paths);

      if (payload.reviewQueue.length > 0) {
        const first = payload.reviewQueue[0];
        setSelectedReviewKey(toReviewKey(first));
        const firstDraft = findOrCreateCardForReview(first, normalizedCards);
        setSelectedScanImagePath(firstDraft.source.imagePath);
        prepareDraft(firstDraft);
      } else if (normalizedCards.length > 0) {
        setSelectedCardId(normalizedCards[0].id);
        setSelectedScanImagePath(normalizedCards[0].source.imagePath);
        prepareDraft(normalizedCards[0]);
      } else if (payload.imageInventory.length > 0) {
        const firstImage = payload.imageInventory[0];
        setSelectedScanImagePath(firstImage.imagePath);
        setMode("scan");
        prepareDraft(findOrCreateCardForImage(firstImage, normalizedCards));
      } else {
        setDraft(null);
      }
      setStatus("Database loaded.");
    } catch (loadError) {
      setError(stringifyError(loadError));
      setStatus("");
    } finally {
      setLoading(false);
    }
  }

  function prepareDraft(card: CardRecord) {
    const cloned = deepClone(normalizeCardRecord(card));
    setDraft(cloned);
    setPowerStageValuesText(toTextLines(cloned.powerStageValues.map((value) => value.toString())));
    setEffectChunksText(prettyJson(cloned.effectChunks));
    setConfidenceFieldsText(prettyJson(cloned.confidence.fields));
    setRawBlocksText(prettyJson(cloned.raw.ocrBlocks));
    setAdvancedErrors({});
    setDirty(false);
  }

  function onSelectDatabaseCard(cardId: string) {
    const card = cards.find((entry) => entry.id === cardId);
    if (!card) {
      return;
    }
    setSelectedCardId(cardId);
    setSelectedScanImagePath(card.source.imagePath);
    setMode("database");
    prepareDraft(card);
    scrollEditorIntoView();
  }

  function onSelectReviewItem(reviewKey: string) {
    const reviewItem = filteredReviewQueue.find((entry) => toReviewKey(entry) === reviewKey);
    if (!reviewItem) {
      return;
    }
    setSelectedReviewKey(reviewKey);
    setMode("review");
    const reviewDraft = findOrCreateCardForReview(reviewItem, cards);
    setSelectedScanImagePath(reviewDraft.source.imagePath);
    prepareDraft(reviewDraft);
    scrollEditorIntoView();
  }

  function onSelectScanItem(imagePath: string) {
    const item = filteredImageInventory.find((entry) => entry.imagePath === imagePath);
    if (!item) {
      return;
    }
    setSelectedScanImagePath(imagePath);
    setMode("scan");
    const matchingCard = cards.find((card) => normalizePath(card.source.imagePath) === normalizePath(item.imagePath));
    if (matchingCard) {
      setSelectedCardId(matchingCard.id);
      prepareDraft(matchingCard);
    } else {
      prepareDraft(findOrCreateCardForImage(item, cards));
    }
    scrollEditorIntoView();
  }

  function onOpenReviewMode() {
    setMode("review");
    setSelectedCardId("");
    setSelectedScanImagePath("");
    setSelectedReviewKey("");
    setDraft(null);
    setDirty(false);
    setAdvancedErrors({});
    setStatus("Select a review item to edit.");
  }

  function updateScanSelection(imagePath: string, checked: boolean) {
    const normalizedTarget = normalizePath(imagePath);
    setSelectedScanImagePaths((current) => {
      const currentSet = new Set(current.map((entry) => normalizePath(entry)));
      if (checked) {
        if (currentSet.has(normalizedTarget)) {
          return current;
        }
        return [...current, imagePath];
      }
      if (!currentSet.has(normalizedTarget)) {
        return current;
      }
      return current.filter((entry) => normalizePath(entry) !== normalizedTarget);
    });
  }

  function addScanSelections(imagePaths: string[]) {
    if (imagePaths.length === 0) {
      return;
    }
    setSelectedScanImagePaths((current) => mergeUniqueImagePaths(current, imagePaths));
  }

  function removeScanSelections(imagePaths: string[]) {
    if (imagePaths.length === 0) {
      return;
    }
    const removalSet = new Set(imagePaths.map((entry) => normalizePath(entry)));
    setSelectedScanImagePaths((current) => {
      const next = current.filter((entry) => !removalSet.has(normalizePath(entry)));
      return next.length === current.length ? current : next;
    });
  }

  function scrollEditorIntoView() {
    window.requestAnimationFrame(() => {
      editorPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function updateDraft(mutator: (current: CardRecord) => CardRecord) {
    setDraft((previous) => {
      if (!previous) {
        return previous;
      }
      const next = mutator(previous);
      return next;
    });
    setDirty(true);
  }

  function parseAndApplyAdvancedEditors(): CardRecord | null {
    if (!draft) {
      return null;
    }

    const nextErrors: AdvancedEditorErrors = {};
    let parsedEffectChunks = draft.effectChunks;
    let parsedConfidenceFields = draft.confidence.fields;
    let parsedRawBlocks = draft.raw.ocrBlocks;

    try {
      const parsed = JSON.parse(effectChunksText);
      if (!Array.isArray(parsed)) {
        throw new Error("effectChunks must be a JSON array.");
      }
      parsedEffectChunks = parsed as CardRecord["effectChunks"];
    } catch (parseError) {
      nextErrors.effectChunks = stringifyError(parseError);
    }

    try {
      const parsed = JSON.parse(confidenceFieldsText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("confidence.fields must be a JSON object.");
      }
      parsedConfidenceFields = parsed as Record<string, number>;
    } catch (parseError) {
      nextErrors.confidenceFields = stringifyError(parseError);
    }

    try {
      const parsed = JSON.parse(rawBlocksText);
      if (!Array.isArray(parsed)) {
        throw new Error("raw.ocrBlocks must be a JSON array.");
      }
      parsedRawBlocks = parsed as unknown[];
    } catch (parseError) {
      nextErrors.rawBlocks = stringifyError(parseError);
    }

    setAdvancedErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setStatus("Fix JSON fields before saving.");
      return null;
    }

    const normalized: CardRecord = {
      ...draft,
      effectChunks: parsedEffectChunks,
      confidence: {
        ...draft.confidence,
        fields: parsedConfidenceFields
      },
      raw: {
        ...draft.raw,
        ocrBlocks: parsedRawBlocks
      }
    };

    setDraft(normalized);
    return normalized;
  }

  async function saveDraftCard() {
    if (!draft) {
      return;
    }
    if (!window.databaseManagerApi) {
      setStatus("Electron bridge unavailable.");
      return;
    }
    const normalized = parseAndApplyAdvancedEditors();
    if (!normalized) {
      return;
    }

    const nextCards = upsertCard(cards, normalized);
    try {
      await window.databaseManagerApi.saveAll({
        cards: nextCards,
        reviewQueue
      });
      setCards(nextCards);
      setDirty(false);
      setStatus(`Saved card ${normalized.id}.`);
    } catch (saveError) {
      setStatus(`Save failed: ${stringifyError(saveError)}`);
    }
  }

  async function resolveCurrentReviewItem() {
    if (!selectedReviewItem || !draftMatchesSelectedReview || !draft) {
      setStatus("Select a review item before resolving.");
      return;
    }
    if (!window.databaseManagerApi) {
      setStatus("Electron bridge unavailable.");
      return;
    }
    const normalized = parseAndApplyAdvancedEditors();
    if (!normalized) {
      return;
    }

    const nextCards = upsertCard(cards, normalized);
    const nextReviewQueue = reviewQueue.filter((item) => toReviewKey(item) !== toReviewKey(selectedReviewItem));

    try {
      await window.databaseManagerApi.saveAll({
        cards: nextCards,
        reviewQueue: nextReviewQueue
      });

      setCards(nextCards);
      setReviewQueue(nextReviewQueue);
      setDirty(false);
      setStatus(`Resolved review item ${selectedReviewItem.cardId}.`);

      const nextVisibleReview = filteredReviewQueue.filter((item) => toReviewKey(item) !== toReviewKey(selectedReviewItem));
      if (nextVisibleReview.length > 0) {
        const nextItem = nextVisibleReview[0];
        setSelectedReviewKey(toReviewKey(nextItem));
        prepareDraft(findOrCreateCardForReview(nextItem, nextCards));
      } else {
        setSelectedReviewKey("");
        setMode("database");
        if (nextCards.length > 0) {
          setSelectedCardId(nextCards[0].id);
          prepareDraft(nextCards[0]);
        } else {
          setDraft(null);
        }
      }
    } catch (saveError) {
      setStatus(`Resolve failed: ${stringifyError(saveError)}`);
    }
  }

  async function rescanImagePaths(imagePaths: string[]) {
    const queue = dedupeImagePaths(imagePaths);
    if (queue.length === 0) {
      setStatus("No images selected for scan.");
      return;
    }
    if (!window.databaseManagerApi) {
      setStatus("Electron bridge unavailable.");
      return;
    }

    setRescanBusy(true);
    let lastPayload: LoadPayload | null = null;
    let lastSummary: { cardId: string | null; status: string } | null = null;
    let failedIndex = -1;
    try {
      for (let index = 0; index < queue.length; index += 1) {
        const imagePath = queue[index];
        const imageFileName = pathBaseName(imagePath);
        failedIndex = index;
        setScanProgress({ current: index + 1, total: queue.length, imageFileName });
        setStatus(`Scanning card ${index + 1}/${queue.length} (${imageFileName})...`);

        const result = await window.databaseManagerApi.rescanCard({ imagePath });
        lastPayload = result.payload;
        lastSummary = {
          cardId: result.summary.cardId,
          status: result.summary.status
        };

        const normalizedCards = result.payload.cards.map((card) => normalizeCardRecord(card));
        setCards(normalizedCards);
        setReviewQueue(result.payload.reviewQueue);
        setImageInventory(result.payload.imageInventory);
        setPayloadPaths(result.payload.paths);
        const matchedImage = result.payload.imageInventory.find(
          (item) => normalizePath(item.imagePath) === normalizePath(imagePath)
        );
        if (matchedImage) {
          setSelectedScanImagePath(matchedImage.imagePath);
        }
      }

      if (!lastPayload) {
        setStatus("Scan completed with no payload updates.");
        return;
      }

      const normalizedCards = lastPayload.cards.map((card) => normalizeCardRecord(card));
      const lastImagePath = queue[queue.length - 1];
      const summaryCardId = lastSummary?.cardId ?? null;
      const cardFromSummary = summaryCardId
        ? normalizedCards.find((card) => card.id === summaryCardId)
        : undefined;
      const cardFromImage = normalizedCards.find(
        (card) => normalizePath(card.source.imagePath) === normalizePath(lastImagePath)
      );
      const selectedCard = cardFromSummary ?? cardFromImage;

      if (selectedCard) {
        setSelectedCardId(selectedCard.id);
        setSelectedScanImagePath(selectedCard.source.imagePath);
        prepareDraft(selectedCard);
      } else {
        const imageItem = lastPayload.imageInventory.find(
          (item) => normalizePath(item.imagePath) === normalizePath(lastImagePath)
        );
        if (imageItem) {
          setSelectedScanImagePath(imageItem.imagePath);
          prepareDraft(findOrCreateCardForImage(imageItem, normalizedCards));
        }
      }

      if (queue.length === 1 && lastSummary) {
        setStatus(`Rescan complete: ${lastSummary.status}${lastSummary.cardId ? ` (${lastSummary.cardId})` : ""}.`);
      } else {
        let acceptedCount = 0;
        let reviewCount = 0;
        for (const imagePath of queue) {
          const item = lastPayload.imageInventory.find((entry) => normalizePath(entry.imagePath) === normalizePath(imagePath));
          if (item?.status === "accepted") {
            acceptedCount += 1;
          } else if (item?.status === "review") {
            reviewCount += 1;
          }
        }
        setStatus(`Scan complete: ${queue.length} card(s) processed (${acceptedCount} accepted, ${reviewCount} review).`);
      }
    } catch (scanError) {
      const errorIndex = failedIndex >= 0 ? failedIndex + 1 : 0;
      const errorImageName = failedIndex >= 0 ? pathBaseName(queue[failedIndex]) : "unknown";
      setStatus(`Scan failed at ${errorIndex}/${queue.length} (${errorImageName}): ${stringifyError(scanError)}`);
    } finally {
      setScanProgress(null);
      setRescanBusy(false);
    }
  }

  async function rescanCurrentCard() {
    const imagePath = selectedDraftImagePath;
    if (!imagePath) {
      setStatus("No image selected for rescan.");
      return;
    }
    await rescanImagePaths([imagePath]);
  }

  async function rescanSelectedCards() {
    if (selectedScanItemsOrdered.length === 0) {
      setStatus("Select at least one image from Scan before starting.");
      return;
    }
    await rescanImagePaths(selectedScanItemsOrdered.map((item) => item.imagePath));
  }

  return (
    <div className="grid h-screen overflow-hidden grid-rows-[auto_minmax(0,1fr)_auto] bg-[radial-gradient(circle_at_top_left,_rgba(81,183,166,0.25),_rgba(238,244,247,0.95)_35%,_rgba(238,244,247,1)_70%)] text-ink">
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/80 backdrop-blur-md">
        <div className="grid grid-cols-1 items-center gap-3 px-4 py-3 lg:grid-cols-[1fr_auto_auto]">
          <div>
            <h1 className="text-lg font-bold tracking-tight">Database Manager</h1>
            <p className="text-xs text-slate-600">
              Desktop editor for `cards.v1.json` and `review-queue.v1.json`
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
            <button
              type="button"
              onClick={() => onOpenReviewMode()}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                mode === "review" ? "bg-sea text-white" : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              Review Queue ({reviewQueue.length})
            </button>
            <button
              type="button"
              onClick={() => setMode("database")}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                mode === "database" ? "bg-sea text-white" : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              Database ({cards.length})
            </button>
            <button
              type="button"
              onClick={() => setMode("scan")}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                mode === "scan" ? "bg-sea text-white" : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              Scan ({unreadImageCount} unread)
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadDatabase()}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-sea hover:text-sea"
            >
              Reload
            </button>
            <button
              type="button"
              disabled={!draft || loading}
              onClick={() => void saveDraftCard()}
              className="rounded-lg bg-ember px-3 py-2 text-xs font-semibold text-white shadow transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Save Card
            </button>
            <button
              type="button"
              disabled={!selectedDraftImagePath || loading || rescanBusy}
              onClick={() => void rescanCurrentCard()}
              className="rounded-lg bg-slate-700 px-3 py-2 text-xs font-semibold text-white shadow transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {rescanBusy ? "Rescanning..." : "Rescan This Card"}
            </button>
          </div>
        </div>
      </header>

      <div className="grid min-h-0 overflow-hidden grid-cols-1 gap-4 p-4 lg:grid-cols-[320px_1fr] xl:grid-cols-[360px_1fr]">
        <aside className="animate-riseIn min-h-0 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-panel lg:h-full">
          <div className="flex h-full min-h-0 flex-col gap-3">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={INPUT_CLASS}
              placeholder={
                mode === "review" ? "Search review queue..." : mode === "scan" ? "Search images..." : "Search cards..."
              }
            />
            <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-mist/70">
              {mode === "review" ? (
                filteredReviewQueue.length > 0 ? (
                  <ul className="divide-y divide-slate-200">
                    {filteredReviewQueue.map((item) => {
                      const active = selectedReviewKey === toReviewKey(item);
                      const linkedCard = cards.find((card) => card.id === item.cardId);
                      const imagePath = linkedCard?.source.imagePath ?? item.imagePath;
                      return (
                        <li key={toReviewKey(item)}>
                          <button
                            type="button"
                            className={`grid w-full grid-cols-[74px_1fr] gap-2 px-2 py-2 text-left transition ${
                              active ? "bg-sea/10" : "hover:bg-white/80"
                            }`}
                            onClick={() => onSelectReviewItem(toReviewKey(item))}
                          >
                            <ImageThumb
                              imagePath={imagePath}
                              alt={item.cardId}
                              className={`h-24 rounded-lg border ${active ? "border-sea" : "border-slate-300"}`}
                            />
                            <div>
                              <p className="text-sm font-semibold text-ink">{item.cardId}</p>
                              <p className="mt-0.5 text-xs text-slate-600">{item.reasons.join(", ")}</p>
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="p-3 text-xs text-slate-600">No review items match your search.</p>
                )
              ) : mode === "database" ? (
                cardsBySet.length > 0 ? (
                <div className="space-y-3 p-2">
                  {cardsBySet.map((setEntry) => (
                    <section key={setEntry.setCode} className="rounded-lg border border-slate-200 bg-white/80 p-2">
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-700">
                        {setEntry.setName} ({setEntry.cards.length})
                      </h3>
                      <div className="grid grid-cols-3 gap-2">
                        {setEntry.cards.map((card) => {
                          const active = selectedCardId === card.id;
                          return (
                            <button
                              key={card.id}
                              type="button"
                              onClick={() => onSelectDatabaseCard(card.id)}
                              className={`group rounded-lg border p-1 text-left transition ${
                                active
                                  ? "border-sea bg-sea/10 shadow-sm"
                                  : "border-slate-300 bg-white hover:border-sea/70 hover:bg-white"
                              }`}
                            >
                              <ImageThumb imagePath={card.source.imagePath} alt={card.id} className="h-24 rounded-md" />
                              <p className="mt-1 truncate text-[11px] font-semibold text-ink">
                                {card.printedNumber} · {card.rarityPrefix}
                              </p>
                              <p className="truncate text-[10px] text-slate-600">{card.name}</p>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </div>
                ) : (
                  <p className="p-3 text-xs text-slate-600">No cards match your search.</p>
                )
              ) : (
                <div className="space-y-2 p-2">
                  <div className="grid grid-cols-2 gap-1 rounded-lg border border-slate-200 bg-white p-1">
                    {(["all", "unread", "accepted", "review"] as const).map((statusFilter) => (
                      <button
                        key={statusFilter}
                        type="button"
                        onClick={() => setScanStatusFilter(statusFilter)}
                        className={`rounded-md px-2 py-1 text-xs font-semibold capitalize transition ${
                          scanStatusFilter === statusFilter ? "bg-sea text-white" : "text-slate-700 hover:bg-slate-100"
                        }`}
                      >
                        {statusFilter}
                      </button>
                    ))}
                  </div>
                  <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-2">
                    <div className="flex items-center justify-between gap-2 text-[11px] text-slate-600">
                      <span>
                        Showing {scanPageStart}-{scanPageEnd} of {filteredImageInventory.length}
                      </span>
                      <label className="flex items-center gap-1">
                        <span>Page size</span>
                        <select
                          value={scanPageSize}
                          onChange={(event) => {
                            const parsed = Number(event.target.value);
                            if (Number.isFinite(parsed) && parsed > 0) {
                              setScanPageSize(Math.trunc(parsed));
                            }
                          }}
                          className="rounded-md border border-slate-300 bg-white px-1.5 py-1 text-[11px] text-slate-700"
                        >
                          {SCAN_PAGE_SIZE_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setScanPage((current) => Math.max(1, current - 1))}
                        disabled={scanPage <= 1}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 transition hover:border-sea hover:text-sea disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Prev
                      </button>
                      <span className="text-xs text-slate-700">
                        Page {scanPage} / {scanTotalPages}
                      </span>
                      <button
                        type="button"
                        onClick={() => setScanPage((current) => Math.min(scanTotalPages, current + 1))}
                        disabled={scanPage >= scanTotalPages}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 transition hover:border-sea hover:text-sea disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Next
                      </button>
                    </div>
                    <div className="space-y-1 rounded-md border border-slate-200 bg-mist/50 p-2 text-[11px]">
                      <div className="flex items-center justify-between gap-2 text-slate-700">
                        <span>
                          Selected {selectedScanCount}
                          {pagedImageInventory.length > 0 ? ` (${selectedScanCountOnPage} on this page)` : ""}
                        </span>
                        <button
                          type="button"
                          onClick={() => setSelectedScanImagePaths([])}
                          disabled={selectedScanCount === 0 || rescanBusy}
                          className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-semibold text-slate-700 transition hover:border-sea hover:text-sea disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Clear all
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-1">
                        <button
                          type="button"
                          onClick={() => addScanSelections(pagedImageInventory.map((item) => item.imagePath))}
                          disabled={pagedImageInventory.length === 0 || rescanBusy}
                          className="rounded border border-slate-300 px-1.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:border-sea hover:text-sea disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Select page
                        </button>
                        <button
                          type="button"
                          onClick={() => removeScanSelections(pagedImageInventory.map((item) => item.imagePath))}
                          disabled={selectedScanCountOnPage === 0 || rescanBusy}
                          className="rounded border border-slate-300 px-1.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:border-sea hover:text-sea disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Clear page
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => void rescanSelectedCards()}
                        disabled={selectedScanCount === 0 || loading || rescanBusy}
                        className="w-full rounded bg-slate-700 px-2 py-1 text-[11px] font-semibold text-white shadow transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {rescanBusy ? "Scanning..." : `Scan Selected (${selectedScanCount})`}
                      </button>
                    </div>
                  </div>
                  {filteredImageInventory.length > 0 ? (
                    <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
                      {pagedImageInventory.map((item) => {
                        const active = selectedScanImagePath === item.imagePath;
                        const checked = selectedScanPathSet.has(normalizePath(item.imagePath));
                        return (
                          <li key={item.imagePath}>
                            <button
                              type="button"
                              className={`grid w-full grid-cols-[18px_70px_1fr] gap-2 px-2 py-2 text-left transition ${
                                active ? "bg-sea/10" : "hover:bg-slate-50"
                              }`}
                              onClick={() => onSelectScanItem(item.imagePath)}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) => updateScanSelection(item.imagePath, event.target.checked)}
                                className="mt-1 h-4 w-4 rounded border-slate-300 accent-sea"
                                aria-label={`Select ${item.imageFileName}`}
                              />
                              <ImageThumb
                                imagePath={item.imagePath}
                                alt={item.imageFileName}
                                className={`h-20 rounded-md border ${active ? "border-sea" : "border-slate-300"}`}
                              />
                              <div>
                                <p className="truncate text-xs font-semibold text-ink">{item.imageFileName}</p>
                                <p className="text-[11px] text-slate-600">{item.setCode}</p>
                                <p className="text-[11px] font-semibold">
                                  <span
                                    className={
                                      item.status === "accepted"
                                        ? "text-emerald-700"
                                        : item.status === "review"
                                          ? "text-amber-700"
                                          : "text-slate-600"
                                    }
                                  >
                                    {item.status}
                                  </span>
                                  {item.cardId ? ` · ${item.cardId}` : ""}
                                </p>
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="p-2 text-xs text-slate-600">No images match your filters.</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </aside>

        <main
          ref={editorPanelRef}
          className="min-h-0 overflow-auto rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-panel xl:overflow-hidden"
        >
          {loading && <p className="animate-pulseSoft text-sm text-slate-600">Loading data...</p>}
          {!loading && !draft && <p className="text-sm text-slate-600">Select a card or review item to edit.</p>}

          {!loading && draft && (
            <div className="animate-riseIn grid min-h-0 items-start gap-4 xl:h-full xl:overflow-hidden xl:grid-cols-[minmax(0,1fr)_360px] xl:grid-rows-[minmax(0,1fr)]">
              <div className="min-w-0 space-y-4 xl:h-full xl:min-h-0 xl:overflow-y-auto xl:pr-2">
                {mode === "review" && selectedReviewItem && (
                  <section className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    <p className="font-semibold">Review Context</p>
                    <p>Card: {selectedReviewItem.cardId}</p>
                    <p>Reasons: {selectedReviewItem.reasons.join(", ")}</p>
                    <p>Failed fields: {selectedReviewItem.failedFields.join(", ") || "-"}</p>
                  </section>
                )}
                {mode === "scan" && selectedScanItem && (
                  <section className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800">
                    <p className="font-semibold">Scan Context</p>
                    <p>Image: {selectedScanItem.imageFileName}</p>
                    <p>Status: {selectedScanItem.status}</p>
                    <p>Linked card: {selectedScanItem.cardId ?? "-"}</p>
                  </section>
                )}

                <section className="grid gap-4 xl:grid-cols-2">
                  <div className="space-y-3 rounded-xl border border-slate-200 p-3">
                    <h2 className="text-sm font-semibold text-ink">Identity</h2>
                    <Field label="Card ID" value={draft.id} onChange={(value) => updateDraft((card) => ({ ...card, id: value }))} />
                    <Field
                      label="Set Code"
                      value={draft.setCode}
                      onChange={(value) =>
                        updateDraft((card) => ({
                          ...card,
                          setCode: value.toUpperCase(),
                          setName: SET_NAME_BY_CODE[value.toUpperCase()] ?? card.setName
                        }))
                      }
                    />
                    <Field
                      label="Set Name"
                      value={draft.setName}
                      onChange={(value) => updateDraft((card) => ({ ...card, setName: value }))}
                    />
                    <Field
                      label="Printed Number"
                      value={draft.printedNumber}
                      onChange={(value) =>
                        updateDraft((card) => ({
                          ...card,
                          printedNumber: value,
                          rarityPrefix: normalizeRarityPrefixValue(card.rarityPrefix, value)
                        }))
                      }
                    />
                    <Field
                      label="Rarity Prefix"
                      value={draft.rarityPrefix}
                      onChange={(value) =>
                        updateDraft((card) => ({
                          ...card,
                          rarityPrefix: normalizeRarityPrefixValue(value, card.printedNumber)
                        }))
                      }
                    />
                  </div>

                  <div className="space-y-3 rounded-xl border border-slate-200 p-3">
                    <h2 className="text-sm font-semibold text-ink">Name & Type</h2>
                    <Field label="Name" value={draft.name} onChange={(value) => updateDraft((card) => ({ ...card, name: value }))} />
                    <Field
                      label="Title"
                      value={draft.title ?? ""}
                      onChange={(value) => updateDraft((card) => ({ ...card, title: normalizeNullableString(value) }))}
                    />
                    <Field
                      label="Character Key"
                      value={draft.characterKey ?? ""}
                      onChange={(value) => updateDraft((card) => ({ ...card, characterKey: normalizeNullableString(value) }))}
                    />
                    <Field
                      label="Personality Family ID"
                      value={draft.personalityFamilyId ?? ""}
                      onChange={(value) =>
                        updateDraft((card) => ({ ...card, personalityFamilyId: normalizeNullableString(value) }))
                      }
                    />
                    <Field
                      label="Card Type"
                      value={draft.cardType}
                      onChange={(value) =>
                        updateDraft((card) => {
                          const normalizedCardType = normalizeCardTypeValue(value) ?? normalizeRawCardTypeToken(value) ?? "unknown";
                          if (normalizedCardType === "personality") {
                            return { ...card, cardType: normalizedCardType };
                          }
                          return {
                            ...card,
                            cardType: normalizedCardType,
                            isMainPersonality: false,
                            isAlly: false
                          };
                        })
                      }
                    />
                    <Field
                      label="Affiliation (hero|villain|neutral|unknown)"
                      value={draft.affiliation}
                      onChange={(value) => updateDraft((card) => ({ ...card, affiliation: value.toLowerCase() }))}
                    />
                    <BooleanField
                      label="Is Main Personality"
                      checked={draft.isMainPersonality}
                      onChange={(checked) =>
                        updateDraft((card) => ({
                          ...card,
                          isMainPersonality: checked,
                          cardType: checked || card.isAlly ? "personality" : card.cardType
                        }))
                      }
                    />
                    <BooleanField
                      label="Is Ally"
                      checked={draft.isAlly}
                      onChange={(checked) =>
                        updateDraft((card) => ({
                          ...card,
                          isAlly: checked,
                          isMainPersonality: checked ? false : card.isMainPersonality,
                          cardType: checked || card.isMainPersonality ? "personality" : card.cardType
                        }))
                      }
                    />
                    <Field
                      label="Style"
                      value={draft.style ?? ""}
                      onChange={(value) => updateDraft((card) => ({ ...card, style: normalizeNullableString(value) }))}
                    />
                  </div>
                </section>

                <section className="grid gap-4">
                  <div className="space-y-3 rounded-xl border border-slate-200 p-3">
                    <h2 className="text-sm font-semibold text-ink">Stats</h2>
                    <Field
                      label="Personality Level"
                      value={draft.personalityLevel?.toString() ?? ""}
                      onChange={(value) => updateDraft((card) => ({ ...card, personalityLevel: parseNullableInt(value) }))}
                    />
                    <TextAreaField
                      label="Power Stage Values (one per line)"
                      value={powerStageValuesText}
                      onChange={(value) => {
                        setPowerStageValuesText(value);
                        updateDraft((card) => {
                          const nextPowerStageValues = fromTextLines(value)
                            .map((entry) => Number(entry))
                            .filter((entry) => Number.isInteger(entry) && entry >= 0);
                          return {
                            ...card,
                            powerStageValues: nextPowerStageValues
                          };
                        });
                      }}
                    />
                    <Field
                      label="PUR"
                      value={draft.pur?.toString() ?? ""}
                      onChange={(value) => updateDraft((card) => ({ ...card, pur: parseNullableInt(value) }))}
                    />
                    <Field
                      label="Endurance"
                      value={draft.endurance?.toString() ?? ""}
                      onChange={(value) => updateDraft((card) => ({ ...card, endurance: parseNullableInt(value) }))}
                    />
                    <BooleanField
                      label="Considered As Styled Card"
                      checked={draft.considered_as_styled_card}
                      onChange={(checked) =>
                        updateDraft((card) => ({
                          ...card,
                          considered_as_styled_card: checked
                        }))
                      }
                    />
                    <Field
                      label="Limit Per Deck"
                      value={draft.limit_per_deck.toString()}
                      onChange={(value) =>
                        updateDraft((card) => ({
                          ...card,
                          limit_per_deck: parseLimitPerDeckInput(value, card.limit_per_deck)
                        }))
                      }
                    />
                    <BooleanField
                      label="Banished After Use"
                      checked={draft.banished_after_use}
                      onChange={(checked) =>
                        updateDraft((card) => ({
                          ...card,
                          banished_after_use: checked
                        }))
                      }
                    />
                    <BooleanField
                      label="Shuffle Into Deck After Use"
                      checked={draft.shuffle_into_deck_after_use}
                      onChange={(checked) =>
                        updateDraft((card) => ({
                          ...card,
                          shuffle_into_deck_after_use: checked
                        }))
                      }
                    />
                    <Field
                      label="Confidence Overall"
                      value={draft.confidence.overall.toString()}
                      onChange={(value) =>
                        updateDraft((card) => ({
                          ...card,
                          confidence: {
                            ...card.confidence,
                            overall: clamp01(parseFloat(value) || 0)
                          }
                        }))
                      }
                    />
                    <Field
                      label="Source URL"
                      value={draft.source.sourceUrl ?? ""}
                      onChange={(value) =>
                        updateDraft((card) => ({
                          ...card,
                          source: {
                            ...card.source,
                            sourceUrl: normalizeNullableString(value)
                          }
                        }))
                      }
                    />
                  </div>
                </section>

                <section className="grid gap-4 xl:grid-cols-2">
                  <div className="space-y-3 rounded-xl border border-slate-200 p-3">
                    <h2 className="text-sm font-semibold text-ink">Icons</h2>
                    <BooleanField
                      label="Attack Icon"
                      checked={draft.icons.isAttack}
                      onChange={(checked) =>
                        updateDraft((card) => ({ ...card, icons: { ...card.icons, isAttack: checked } }))
                      }
                    />
                    <BooleanField
                      label="Defense Icon"
                      checked={draft.icons.isDefense}
                      onChange={(checked) =>
                        updateDraft((card) => ({ ...card, icons: { ...card.icons, isDefense: checked } }))
                      }
                    />
                    <BooleanField
                      label="Quick Icon"
                      checked={draft.icons.isQuick}
                      onChange={(checked) =>
                        updateDraft((card) => ({ ...card, icons: { ...card.icons, isQuick: checked } }))
                      }
                    />
                    <BooleanField
                      label="Constant Icon"
                      checked={draft.icons.isConstant}
                      onChange={(checked) =>
                        updateDraft((card) => ({ ...card, icons: { ...card.icons, isConstant: checked } }))
                      }
                    />
                    <button
                      type="button"
                      onClick={() => setShowIconEvidence((current) => !current)}
                      className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-mist/40 px-3 py-2 text-left text-sm"
                    >
                      <span className="font-medium text-slate-700">Icon Evidence</span>
                      <span className="text-xs font-semibold text-slate-600">{showIconEvidence ? "Hide" : "Show"}</span>
                    </button>
                    {showIconEvidence && (
                      <TextAreaField
                        label="Icon Evidence (one per line)"
                        value={toTextLines(draft.icons.rawIconEvidence)}
                        onChange={(value) =>
                          updateDraft((card) => ({
                            ...card,
                            icons: {
                              ...card.icons,
                              rawIconEvidence: fromTextLines(value)
                            }
                          }))
                        }
                      />
                    )}
                  </div>
                  <div className="space-y-3">
                    <TextAreaField
                      label="Card Text Raw"
                      value={draft.cardTextRaw}
                      onChange={(value) => updateDraft((card) => ({ ...card, cardTextRaw: value }))}
                    />
                    <IconMarkerPreview text={draft.cardTextRaw} iconMarkerDataUrls={iconMarkerDataUrls} />
                  </div>
                </section>

                <section className="grid gap-4 xl:grid-cols-2">
                  <TextAreaField
                    label="Card Subtypes (one per line)"
                    value={toTextLines(draft.cardSubtypes)}
                    onChange={(value) => updateDraft((card) => ({ ...card, cardSubtypes: fromTextLines(value) }))}
                  />
                  <TextAreaField
                    label="Tags (one per line)"
                    value={toTextLines(draft.tags)}
                    onChange={(value) => updateDraft((card) => ({ ...card, tags: fromTextLines(value) }))}
                  />
                </section>

                <section className="rounded-xl border border-slate-200 p-3">
                  <button
                    type="button"
                    onClick={() => setShowTechnicalScan((current) => !current)}
                    className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-mist/40 px-3 py-2 text-left"
                  >
                    <h2 className="text-sm font-semibold text-ink">Technical Scan</h2>
                    <span className="text-xs font-semibold text-slate-600">{showTechnicalScan ? "Hide" : "Show"}</span>
                  </button>
                  {showTechnicalScan && (
                    <div className="mt-3 space-y-4">
                      <section className="grid gap-4 xl:grid-cols-2">
                        <TextAreaField
                          label="Review Reasons (one per line)"
                          value={toTextLines(draft.review.reasons)}
                          onChange={(value) =>
                            updateDraft((card) => ({
                              ...card,
                              review: { ...card.review, reasons: fromTextLines(value) }
                            }))
                          }
                        />
                        <TextAreaField
                          label="Review Notes (one per line)"
                          value={toTextLines(draft.review.notes)}
                          onChange={(value) =>
                            updateDraft((card) => ({
                              ...card,
                              review: { ...card.review, notes: fromTextLines(value) }
                            }))
                          }
                        />
                      </section>

                      <section className="grid gap-4 xl:grid-cols-2">
                        <TextAreaField
                          label="Effect Chunks JSON"
                          value={effectChunksText}
                          onChange={setEffectChunksText}
                          error={advancedErrors.effectChunks}
                        />
                        <TextAreaField
                          label="Confidence Fields JSON"
                          value={confidenceFieldsText}
                          onChange={setConfidenceFieldsText}
                          error={advancedErrors.confidenceFields}
                        />
                      </section>

                      <section className="grid gap-4 xl:grid-cols-2">
                        <TextAreaField
                          label="OCR Blocks JSON"
                          value={rawBlocksText}
                          onChange={setRawBlocksText}
                          error={advancedErrors.rawBlocks}
                        />
                        <div className="space-y-3 rounded-xl border border-slate-200 p-3">
                          <h2 className="text-sm font-semibold text-ink">Raw Source</h2>
                          <Field
                            label="Image Path"
                            value={draft.source.imagePath}
                            onChange={(value) =>
                              updateDraft((card) => ({
                                ...card,
                                source: { ...card.source, imagePath: value }
                              }))
                            }
                          />
                          <Field
                            label="Image File Name"
                            value={draft.source.imageFileName}
                            onChange={(value) =>
                              updateDraft((card) => ({
                                ...card,
                                source: { ...card.source, imageFileName: value }
                              }))
                            }
                          />
                          <BooleanField
                            label="Review Required"
                            checked={draft.review.required}
                            onChange={(checked) =>
                              updateDraft((card) => ({
                                ...card,
                                review: { ...card.review, required: checked }
                              }))
                            }
                          />
                          <TextAreaField
                            label="Raw Warnings (one per line)"
                            value={toTextLines(draft.raw.warnings)}
                            onChange={(value) =>
                              updateDraft((card) => ({
                                ...card,
                                raw: {
                                  ...card.raw,
                                  warnings: fromTextLines(value)
                                }
                              }))
                            }
                          />
                          <TextAreaField
                            label="OCR Text"
                            value={draft.raw.ocrText}
                            onChange={(value) =>
                              updateDraft((card) => ({
                                ...card,
                                raw: { ...card.raw, ocrText: value }
                              }))
                            }
                          />
                          <TextAreaField
                            label="LLM Raw JSON"
                            value={draft.raw.llmRawJson ?? ""}
                            onChange={(value) =>
                              updateDraft((card) => ({
                                ...card,
                                raw: {
                                  ...card.raw,
                                  llmRawJson: normalizeNullableString(value) ?? undefined
                                }
                              }))
                            }
                          />
                        </div>
                      </section>
                    </div>
                  )}
                </section>
              </div>

              <aside className="space-y-3 self-start">
                <section className="rounded-xl border border-slate-200 bg-mist/40 p-3">
                  <ImageThumb
                    imagePath={selectedDraftImagePath}
                    alt={draft.id}
                    className="h-[68vh] min-h-[420px] rounded-lg border border-slate-300 bg-slate-100"
                  />
                  <div className="mt-3 space-y-1">
                    <p className="text-sm font-semibold text-ink">{draft.id}</p>
                    <p className="text-xs text-slate-700">
                      {draft.setCode} · {draft.setName} · {draft.printedNumber}
                    </p>
                    <p className="text-xs text-slate-700">{draft.name}</p>
                    <p className="text-xs text-slate-600">
                      {draft.affiliation} · {draft.isMainPersonality ? "main personality" : "not main"} ·{" "}
                      {draft.isAlly ? "ally" : "non-ally"}
                    </p>
                  </div>
                  {mode === "review" && draftMatchesSelectedReview && (
                    <button
                      type="button"
                      disabled={!draft || !selectedReviewItem || !draftMatchesSelectedReview || loading || rescanBusy}
                      onClick={() => void resolveCurrentReviewItem()}
                      className="mt-3 w-full rounded-lg bg-sea px-3 py-2 text-xs font-semibold text-white shadow transition hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Resolve Review Item
                    </button>
                  )}
                </section>
              </aside>
            </div>
          )}
        </main>
      </div>

      <footer className="border-t border-slate-200/70 bg-white/85 px-4 py-2 text-xs text-slate-600">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>{status || (dirty ? "Unsaved changes." : "Ready.")}</p>
          {error && <p className="font-semibold text-red-700">{error}</p>}
          {payloadPaths && (
            <p className="font-mono text-[11px] text-slate-500">
              cards: {payloadPaths.cardsPath} | review: {payloadPaths.reviewQueuePath}
            </p>
          )}
        </div>
      </footer>
      {scanProgress && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/45 px-4 backdrop-blur-[1px]">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
            <p className="text-sm font-semibold text-ink">Scanning in progress</p>
            <p className="mt-2 text-sm text-slate-700">
              Scanning card {scanProgress.current}/{scanProgress.total} ({scanProgress.imageFileName})...
            </p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-sea transition-all"
                style={{ width: `${Math.round((scanProgress.current / scanProgress.total) * 100)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-slate-600">Please wait. Other actions are disabled until scan completes.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Field(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-700">{props.label}</span>
      <input className={INPUT_CLASS} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
    </label>
  );
}

function ImageThumb(props: { imagePath: string | null | undefined; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const [src, setSrc] = useState("");

  useEffect(() => {
    setFailed(false);
    let cancelled = false;

    async function resolveImageSource() {
      const rawPath = props.imagePath?.trim();
      if (!rawPath) {
        setSrc("");
        return;
      }

      const cached = imageSourceCache.get(rawPath);
      if (cached) {
        setSrc(cached);
        return;
      }

      try {
        let resolved = "";
        if (rawPath.startsWith("http://") || rawPath.startsWith("https://") || rawPath.startsWith("data:")) {
          resolved = rawPath;
        } else if (window.databaseManagerApi?.readImageDataUrl) {
          resolved = await window.databaseManagerApi.readImageDataUrl(rawPath);
        } else {
          resolved = toFileImageUrl(rawPath);
        }

        if (!cancelled) {
          imageSourceCache.set(rawPath, resolved);
          setSrc(resolved);
        }
      } catch {
        if (!cancelled) {
          setSrc("");
          setFailed(true);
        }
      }
    }

    void resolveImageSource();
    return () => {
      cancelled = true;
    };
  }, [props.imagePath]);

  return (
    <div className={`relative w-full overflow-hidden bg-slate-200 ${props.className ?? ""}`}>
      {!failed && src ? (
        <img
          src={src}
          alt={props.alt}
          className="h-full w-full object-contain"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center px-2 text-center text-[10px] font-semibold text-slate-500">
          No image
        </div>
      )}
    </div>
  );
}

function BooleanField(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center justify-between rounded-lg border border-slate-200 bg-mist/40 px-3 py-2 text-sm">
      <span>{props.label}</span>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
        className="h-4 w-4 accent-sea"
      />
    </label>
  );
}

function TextAreaField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-700">{props.label}</span>
      <textarea className={TEXTAREA_CLASS} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
      {props.error && <span className="mt-1 block text-xs text-red-700">{props.error}</span>}
    </label>
  );
}

function IconMarkerPreview(props: { text: string; iconMarkerDataUrls: Record<string, string> }) {
  const normalized = props.text.trim();
  if (!normalized) {
    return null;
  }

  const formatted = enforcePowerLineBreaks(normalized);
  const tokenPattern = /(\[(?:attack|defense|constant|timing|quick) icon\]|(?:POWER|HIT|DAMAGE):)/gi;
  const parts = formatted.split(tokenPattern).filter((part) => part.length > 0);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
      <p className="mb-2 font-semibold text-slate-600">Rendered Preview</p>
      <p className="whitespace-pre-wrap leading-relaxed">
        {parts.map((part, index) => {
          const marker = part.toLowerCase();
          if (marker === "power:" || marker === "hit:" || marker === "damage:") {
            const keywordLabel =
              marker === "power:" ? "POWER:" : marker === "hit:" ? "HIT:" : "DAMAGE:";
            return (
              <strong key={`${marker}-${index}`} className="font-semibold text-slate-800">
                {keywordLabel}
              </strong>
            );
          }
          const iconSource = props.iconMarkerDataUrls[marker];
          if (iconSource) {
            return (
              <img
                key={`${marker}-${index}`}
                src={iconSource}
                alt={part}
                className="mx-[1px] inline-block h-[1.02em] w-auto align-[-0.12em]"
                loading="lazy"
              />
            );
          }
          return (
            <span key={`${part}-${index}`} className="align-middle">
              {part}
            </span>
          );
        })}
      </p>
    </div>
  );
}

function enforcePowerLineBreaks(text: string): string {
  return text
    .replace(/\s*\bPOWER:\s*/gi, "\nPOWER: ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findOrCreateCardForReview(reviewItem: ReviewQueueItem, cards: CardRecord[]): CardRecord {
  const existing = cards.find((card) => card.id === reviewItem.cardId);
  if (existing) {
    return existing;
  }

  const candidate = reviewItem.candidateValues;
  const printedNumber = typeof candidate.printedNumber === "string" ? candidate.printedNumber : reviewItem.cardId.split("-")[1] ?? "";
  const rarityPrefix = normalizeRarityPrefixValue(candidate.rarityPrefix, printedNumber);
  const cardName = typeof candidate.name === "string" ? candidate.name : reviewItem.cardId;
  const candidateTags = Array.isArray(candidate.tags) ? candidate.tags.map(String) : [];
  const candidateTopPowerStage =
    typeof candidate.powerStages === "number" && Number.isInteger(candidate.powerStages) ? candidate.powerStages : null;
  const candidatePowerStageValues = Array.isArray(candidate.powerStageValues)
    ? candidate.powerStageValues.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry >= 0)
    : candidateTopPowerStage !== null
      ? [candidateTopPowerStage, 0]
      : [];
  const candidatePur = typeof candidate.pur === "number" && Number.isInteger(candidate.pur) ? candidate.pur : null;
  const candidateEndurance =
    typeof candidate.endurance === "number" && Number.isInteger(candidate.endurance) && candidate.endurance >= 0
      ? candidate.endurance
      : null;
  const candidateCharacterKey =
    typeof candidate.characterKey === "string" && candidate.characterKey.trim().length > 0
      ? candidate.characterKey.trim()
      : null;
  const candidatePersonalityFamilyId =
    typeof candidate.personalityFamilyId === "string" && candidate.personalityFamilyId.trim().length > 0
      ? candidate.personalityFamilyId.trim()
      : null;
  const candidateCardSubtypes = Array.isArray(candidate.cardSubtypes)
    ? candidate.cardSubtypes.map(String).map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : [];
  const candidateTitle =
    typeof candidate.title === "string" && candidate.title.trim().length > 0 ? candidate.title.trim() : null;
  const candidateMainPowerText =
    typeof candidate.mainPowerText === "string" && candidate.mainPowerText.trim().length > 0
      ? candidate.mainPowerText.trim()
      : null;
  const candidateCardTextRaw =
    typeof candidate.cardTextRaw === "string" && candidate.cardTextRaw.trim().length > 0
      ? candidate.cardTextRaw.trim()
      : candidateMainPowerText ?? cardName;
  const candidateWarnings = Array.isArray(candidate.rawWarnings)
    ? candidate.rawWarnings.map(String).map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : [];
  const candidatePersonalityLevel =
    typeof candidate.personalityLevel === "number" && Number.isInteger(candidate.personalityLevel)
      ? candidate.personalityLevel
      : null;
  const candidateAffiliation = normalizeAffiliationValue(
    typeof candidate.affiliation === "string" ? candidate.affiliation : inferAffiliationFromTags(candidateTags)
  );
  const candidateRawCardType = normalizeRawCardTypeToken(candidate.cardType);
  const candidateCardType = normalizeCardTypeValue(candidate.cardType);
  const candidateIsAlly =
    typeof candidate.isAlly === "boolean"
      ? candidate.isAlly
      : candidateRawCardType === "ally"
        ? true
        : candidateTags.some((tag) => tag.toLowerCase().includes("ally"));
  const candidateIsMainPersonality =
    typeof candidate.isMainPersonality === "boolean"
      ? candidate.isMainPersonality && !candidateIsAlly
      : candidateRawCardType === "main_personality" || candidateRawCardType === "personality"
        ? !candidateIsAlly
        : candidatePersonalityLevel !== null && candidateIsAlly === false;
  const resolvedCardType =
    candidateCardType ?? (candidateIsMainPersonality || candidateIsAlly ? "personality" : "unknown");
  const candidateConsideredAsStyledCard =
    typeof candidate.considered_as_styled_card === "boolean"
      ? candidate.considered_as_styled_card
      : typeof candidate.consideredAsStyledCard === "boolean"
        ? candidate.consideredAsStyledCard
        : detectConsideredAsStyledCard(candidateCardTextRaw);
  const candidateLimitPerDeck = normalizeLimitPerDeckValue(
    candidate.limit_per_deck ?? candidate.limitPerDeck,
    candidateCardTextRaw,
    resolvedCardType
  );
  const candidateBanishedAfterUse =
    typeof candidate.banished_after_use === "boolean"
      ? candidate.banished_after_use
      : typeof candidate.banishedAfterUse === "boolean"
        ? candidate.banishedAfterUse
        : detectBanishedAfterUse(candidateCardTextRaw);
  const candidateShuffleIntoDeckAfterUse =
    typeof candidate.shuffle_into_deck_after_use === "boolean"
      ? candidate.shuffle_into_deck_after_use
      : typeof candidate.shuffleIntoDeckAfterUse === "boolean"
        ? candidate.shuffleIntoDeckAfterUse
        : detectShuffleIntoDeckAfterUse(candidateCardTextRaw);
  const candidateDrillNotDiscardedWhenChangingLevels = normalizeBooleanValue(
    candidate.drill_not_discarded_when_changing_levels ?? candidate.drillNotDiscardedWhenChangingLevels,
    false
  );
  const candidateAttachLimit = normalizeAttachLimitValue(candidate.attach_limit ?? candidate.attachLimit);
  const candidateExtraordinaryCanPlayFromHand = normalizeBooleanValue(
    candidate.extraordinary_can_play_from_hand ?? candidate.extraordinaryCanPlayFromHand,
    false
  );
  const candidateHasEffectWhenDiscardedCombat = normalizeBooleanValue(
    candidate.has_effect_when_discarded_combat ?? candidate.hasEffectWhenDiscardedCombat,
    false
  );
  const candidateSeachesOwnerLifeDeck = normalizeBooleanValue(
    candidate.seaches_owner_life_deck ?? candidate.seachesOwnerLifeDeck,
    false
  );
  const candidateRejuvenatesAmount = normalizeNullableNonNegativeIntValue(
    candidate.rejuvenates_amount ?? candidate.rejuvenatesAmount
  );
  const candidateConditionalRejuvenate = normalizeBooleanValue(
    candidate.conditional_rejuvenate ?? candidate.conditionalRejuvenate,
    false
  );
  const candidateConditionalEndurance = normalizeBooleanValue(
    candidate.conditional_endurance ?? candidate.conditionalEndurance,
    false
  );
  const candidateRaiseYourAnger = normalizeNullableNonNegativeIntValue(
    candidate.raise_your_anger ?? candidate.raiseYourAnger
  );
  const candidateConditionalRaiseYourAnger = normalizeBooleanValue(
    candidate.conditional_raise_your_anger ?? candidate.conditionalRaiseYourAnger,
    false
  );
  const candidateLowerYourAnger = normalizeNullableNonNegativeIntValue(
    candidate.lower_your_anger ?? candidate.lowerYourAnger
  );
  const candidateConditionalLowerYourAnger = normalizeBooleanValue(
    candidate.conditional_lower_your_anger ?? candidate.conditionalLowerYourAnger,
    false
  );
  const candidateRaiseOrLowerAnyPlayerAnger = normalizeNullableNonNegativeIntValue(
    candidate.raise_or_lower_any_player_anger ?? candidate.raiseOrLowerAnyPlayerAnger
  );
  const candidateConditionalRaiseOrLowerAnyPlayerAnger = normalizeBooleanValue(
    candidate.conditional_raise_or_lower_any_player_anger ?? candidate.conditionalRaiseOrLowerAnyPlayerAnger,
    false
  );
  const candidateWhenDrillEntersPlayDuringCombat = normalizeBooleanValue(
    candidate.when_drill_enters_play_during_combat ?? candidate.whenDrillEntersPlayDuringCombat,
    false
  );
  const candidateWhenDrillEntersPlay = normalizeBooleanValue(
    candidate.when_drill_enters_play ?? candidate.whenDrillEntersPlay,
    false
  );
  const candidateAttachesOwnMainPersonality = normalizeBooleanValue(
    candidate.attaches_own_main_personality ?? candidate.attachesOwnMainPersonality,
    false
  );
  const candidateAttachesOpponentMainPersonality = normalizeBooleanValue(
    candidate.attaches_opponent_main_personality ?? candidate.attachesOpponentMainPersonality,
    false
  );
  const candidateResolvedRejuvenatesAmount =
    candidateConditionalRejuvenate && candidateRejuvenatesAmount === null ? 0 : candidateRejuvenatesAmount;
  const candidateResolvedRaiseYourAnger =
    candidateConditionalRaiseYourAnger && candidateRaiseYourAnger === null ? 0 : candidateRaiseYourAnger;
  const candidateResolvedLowerYourAnger =
    candidateConditionalLowerYourAnger && candidateLowerYourAnger === null ? 0 : candidateLowerYourAnger;
  const candidateResolvedRaiseOrLowerAnyPlayerAnger =
    candidateConditionalRaiseOrLowerAnyPlayerAnger && candidateRaiseOrLowerAnyPlayerAnger === null
      ? 0
      : candidateRaiseOrLowerAnyPlayerAnger;

  return {
    id: reviewItem.cardId,
    setCode: reviewItem.setCode,
    setName: SET_NAME_BY_CODE[reviewItem.setCode] ?? reviewItem.setCode,
    printedNumber,
    rarityPrefix,
    name: cardName,
    title: candidateTitle,
    characterKey: candidateCharacterKey,
    personalityFamilyId: candidatePersonalityFamilyId,
    cardType: resolvedCardType,
    affiliation: candidateAffiliation,
    isMainPersonality: candidateIsMainPersonality,
    isAlly: candidateIsAlly,
    cardSubtypes: candidateCardSubtypes,
    style: typeof candidate.style === "string" ? candidate.style : null,
    icons: {
      isAttack: false,
      isDefense: false,
      isQuick: false,
      isConstant: false,
      rawIconEvidence: []
    },
    tags: candidateTags,
    powerStageValues: candidatePowerStageValues,
    pur: candidatePur,
    endurance: candidateConditionalEndurance && candidateEndurance === null ? 0 : candidateEndurance,
    considered_as_styled_card: candidateConsideredAsStyledCard,
    limit_per_deck: candidateLimitPerDeck,
    banished_after_use: candidateBanishedAfterUse,
    shuffle_into_deck_after_use: candidateShuffleIntoDeckAfterUse,
    drill_not_discarded_when_changing_levels: candidateDrillNotDiscardedWhenChangingLevels,
    attach_limit: candidateAttachLimit,
    extraordinary_can_play_from_hand: candidateExtraordinaryCanPlayFromHand,
    has_effect_when_discarded_combat: candidateHasEffectWhenDiscardedCombat,
    seaches_owner_life_deck: candidateSeachesOwnerLifeDeck,
    rejuvenates_amount: candidateResolvedRejuvenatesAmount,
    conditional_rejuvenate: candidateConditionalRejuvenate,
    conditional_endurance: candidateConditionalEndurance,
    raise_your_anger: candidateResolvedRaiseYourAnger,
    conditional_raise_your_anger: candidateConditionalRaiseYourAnger,
    lower_your_anger: candidateResolvedLowerYourAnger,
    conditional_lower_your_anger: candidateConditionalLowerYourAnger,
    raise_or_lower_any_player_anger: candidateResolvedRaiseOrLowerAnyPlayerAnger,
    conditional_raise_or_lower_any_player_anger: candidateConditionalRaiseOrLowerAnyPlayerAnger,
    when_drill_enters_play_during_combat: candidateWhenDrillEntersPlayDuringCombat,
    when_drill_enters_play: candidateWhenDrillEntersPlay,
    attaches_own_main_personality: candidateAttachesOwnMainPersonality,
    attaches_opponent_main_personality: candidateAttachesOpponentMainPersonality,
    personalityLevel: candidatePersonalityLevel,
    mainPowerText: candidateMainPowerText,
    cardTextRaw: candidateCardTextRaw,
    effectChunks: [],
    source: {
      imagePath: reviewItem.imagePath,
      imageFileName: reviewItem.imagePath.split("/").pop() ?? "",
      sourceUrl: null
    },
    confidence: {
      overall: reviewItem.confidenceSnapshot.overall,
      fields: reviewItem.confidenceSnapshot.fields
    },
    review: {
      required: true,
      reasons: reviewItem.reasons,
      notes: []
    },
    raw: {
      ocrText: candidateCardTextRaw,
      ocrBlocks: [],
      warnings: candidateWarnings
    }
  };
}

function normalizeCardRecord(card: CardRecord): CardRecord {
  const { powerStages: legacyPowerStages, ...cardWithoutLegacyPowerStages } = card as CardRecord & {
    powerStages?: unknown;
  };
  const raw = card as CardRecord & {
    cardType?: unknown;
    rarityPrefix?: unknown;
    affiliation?: unknown;
    isMainPersonality?: unknown;
    isAlly?: unknown;
    powerStageValues?: unknown;
    endurance?: unknown;
    considered_as_styled_card?: unknown;
    consideredAsStyledCard?: unknown;
    limit_per_deck?: unknown;
    limitPerDeck?: unknown;
    banished_after_use?: unknown;
    banishedAfterUse?: unknown;
    shuffle_into_deck_after_use?: unknown;
    shuffleIntoDeckAfterUse?: unknown;
    drill_not_discarded_when_changing_levels?: unknown;
    drillNotDiscardedWhenChangingLevels?: unknown;
    attach_limit?: unknown;
    attachLimit?: unknown;
    extraordinary_can_play_from_hand?: unknown;
    extraordinaryCanPlayFromHand?: unknown;
    has_effect_when_discarded_combat?: unknown;
    hasEffectWhenDiscardedCombat?: unknown;
    seaches_owner_life_deck?: unknown;
    seachesOwnerLifeDeck?: unknown;
    rejuvenates_amount?: unknown;
    rejuvenatesAmount?: unknown;
    conditional_rejuvenate?: unknown;
    conditionalRejuvenate?: unknown;
    conditional_endurance?: unknown;
    conditionalEndurance?: unknown;
    raise_your_anger?: unknown;
    raiseYourAnger?: unknown;
    conditional_raise_your_anger?: unknown;
    conditionalRaiseYourAnger?: unknown;
    lower_your_anger?: unknown;
    lowerYourAnger?: unknown;
    conditional_lower_your_anger?: unknown;
    conditionalLowerYourAnger?: unknown;
    raise_or_lower_any_player_anger?: unknown;
    raiseOrLowerAnyPlayerAnger?: unknown;
    conditional_raise_or_lower_any_player_anger?: unknown;
    conditionalRaiseOrLowerAnyPlayerAnger?: unknown;
    when_drill_enters_play_during_combat?: unknown;
    whenDrillEntersPlayDuringCombat?: unknown;
    when_drill_enters_play?: unknown;
    whenDrillEntersPlay?: unknown;
    attaches_own_main_personality?: unknown;
    attachesOwnMainPersonality?: unknown;
    attaches_opponent_main_personality?: unknown;
    attachesOpponentMainPersonality?: unknown;
  };
  const rawCardType = normalizeRawCardTypeToken(raw.cardType);
  const normalizedCardType = normalizeCardTypeValue(raw.cardType);
  const normalizedIsAlly = typeof raw.isAlly === "boolean" ? raw.isAlly : rawCardType === "ally";
  const normalizedIsMainPersonality =
    typeof raw.isMainPersonality === "boolean"
      ? raw.isMainPersonality && !normalizedIsAlly
      : rawCardType === "main_personality"
        ? !normalizedIsAlly
        : normalizedCardType === "personality" && !normalizedIsAlly && card.personalityLevel !== null;
  const resolvedCardType = normalizedCardType ?? (normalizedIsAlly || normalizedIsMainPersonality ? "personality" : "unknown");
  const legacyPowerStageValue = typeof legacyPowerStages === "number" && Number.isInteger(legacyPowerStages) ? legacyPowerStages : null;
  const normalizedPowerStageValues = Array.isArray(raw.powerStageValues)
    ? raw.powerStageValues.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry >= 0)
    : legacyPowerStageValue !== null && legacyPowerStageValue >= 0
      ? [legacyPowerStageValue, 0]
      : [];
  const normalizedConfidenceFields = Object.fromEntries(
    Object.entries(card.confidence.fields).filter(([key]) => key !== "powerStages")
  );
  const normalizedCardTextRaw =
    typeof card.cardTextRaw === "string" && card.cardTextRaw.trim().length > 0
      ? card.cardTextRaw.trim()
      : normalizeNullableString(card.mainPowerText ?? "") ?? card.name ?? card.id;
  const normalizedSourceImageFileName =
    typeof card.source.imageFileName === "string" && card.source.imageFileName.trim().length > 0
      ? card.source.imageFileName.trim()
      : pathBaseName(card.source.imagePath);
  const normalizedConsideredAsStyledCard =
    typeof raw.considered_as_styled_card === "boolean"
      ? raw.considered_as_styled_card
      : typeof raw.consideredAsStyledCard === "boolean"
        ? raw.consideredAsStyledCard
        : detectConsideredAsStyledCard(normalizedCardTextRaw);
  const normalizedLimitPerDeck = normalizeLimitPerDeckValue(
    raw.limit_per_deck ?? raw.limitPerDeck,
    normalizedCardTextRaw,
    resolvedCardType
  );
  const normalizedBanishedAfterUse =
    typeof raw.banished_after_use === "boolean"
      ? raw.banished_after_use
      : typeof raw.banishedAfterUse === "boolean"
        ? raw.banishedAfterUse
        : detectBanishedAfterUse(normalizedCardTextRaw);
  const normalizedShuffleIntoDeckAfterUse =
    typeof raw.shuffle_into_deck_after_use === "boolean"
      ? raw.shuffle_into_deck_after_use
      : typeof raw.shuffleIntoDeckAfterUse === "boolean"
        ? raw.shuffleIntoDeckAfterUse
        : detectShuffleIntoDeckAfterUse(normalizedCardTextRaw);
  const normalizedDrillNotDiscardedWhenChangingLevels = normalizeBooleanValue(
    raw.drill_not_discarded_when_changing_levels ?? raw.drillNotDiscardedWhenChangingLevels,
    false
  );
  const normalizedAttachLimit = normalizeAttachLimitValue(raw.attach_limit ?? raw.attachLimit);
  const normalizedExtraordinaryCanPlayFromHand = normalizeBooleanValue(
    raw.extraordinary_can_play_from_hand ?? raw.extraordinaryCanPlayFromHand,
    false
  );
  const normalizedHasEffectWhenDiscardedCombat = normalizeBooleanValue(
    raw.has_effect_when_discarded_combat ?? raw.hasEffectWhenDiscardedCombat,
    false
  );
  const normalizedSeachesOwnerLifeDeck = normalizeBooleanValue(
    raw.seaches_owner_life_deck ?? raw.seachesOwnerLifeDeck,
    false
  );
  const normalizedRejuvenatesAmount = normalizeNullableNonNegativeIntValue(
    raw.rejuvenates_amount ?? raw.rejuvenatesAmount
  );
  const normalizedConditionalRejuvenate = normalizeBooleanValue(
    raw.conditional_rejuvenate ?? raw.conditionalRejuvenate,
    false
  );
  const normalizedConditionalEndurance = normalizeBooleanValue(
    raw.conditional_endurance ?? raw.conditionalEndurance,
    false
  );
  const normalizedRaiseYourAnger = normalizeNullableNonNegativeIntValue(raw.raise_your_anger ?? raw.raiseYourAnger);
  const normalizedConditionalRaiseYourAnger = normalizeBooleanValue(
    raw.conditional_raise_your_anger ?? raw.conditionalRaiseYourAnger,
    false
  );
  const normalizedLowerYourAnger = normalizeNullableNonNegativeIntValue(raw.lower_your_anger ?? raw.lowerYourAnger);
  const normalizedConditionalLowerYourAnger = normalizeBooleanValue(
    raw.conditional_lower_your_anger ?? raw.conditionalLowerYourAnger,
    false
  );
  const normalizedRaiseOrLowerAnyPlayerAnger = normalizeNullableNonNegativeIntValue(
    raw.raise_or_lower_any_player_anger ?? raw.raiseOrLowerAnyPlayerAnger
  );
  const normalizedConditionalRaiseOrLowerAnyPlayerAnger = normalizeBooleanValue(
    raw.conditional_raise_or_lower_any_player_anger ?? raw.conditionalRaiseOrLowerAnyPlayerAnger,
    false
  );
  const normalizedWhenDrillEntersPlayDuringCombat = normalizeBooleanValue(
    raw.when_drill_enters_play_during_combat ?? raw.whenDrillEntersPlayDuringCombat,
    false
  );
  const normalizedWhenDrillEntersPlay = normalizeBooleanValue(raw.when_drill_enters_play ?? raw.whenDrillEntersPlay, false);
  const normalizedAttachesOwnMainPersonality = normalizeBooleanValue(
    raw.attaches_own_main_personality ?? raw.attachesOwnMainPersonality,
    false
  );
  const normalizedAttachesOpponentMainPersonality = normalizeBooleanValue(
    raw.attaches_opponent_main_personality ?? raw.attachesOpponentMainPersonality,
    false
  );
  const normalizedEndurance =
    typeof raw.endurance === "number" && Number.isInteger(raw.endurance) && raw.endurance >= 0 ? raw.endurance : null;
  const normalizedResolvedRejuvenatesAmount =
    normalizedConditionalRejuvenate && normalizedRejuvenatesAmount === null ? 0 : normalizedRejuvenatesAmount;
  const normalizedResolvedRaiseYourAnger =
    normalizedConditionalRaiseYourAnger && normalizedRaiseYourAnger === null ? 0 : normalizedRaiseYourAnger;
  const normalizedResolvedLowerYourAnger =
    normalizedConditionalLowerYourAnger && normalizedLowerYourAnger === null ? 0 : normalizedLowerYourAnger;
  const normalizedResolvedRaiseOrLowerAnyPlayerAnger =
    normalizedConditionalRaiseOrLowerAnyPlayerAnger && normalizedRaiseOrLowerAnyPlayerAnger === null
      ? 0
      : normalizedRaiseOrLowerAnyPlayerAnger;

  return {
    ...cardWithoutLegacyPowerStages,
    cardType: resolvedCardType,
    rarityPrefix: normalizeRarityPrefixValue(raw.rarityPrefix, card.printedNumber),
    affiliation: normalizeAffiliationValue(raw.affiliation),
    isMainPersonality: normalizedIsMainPersonality,
    isAlly: normalizedIsAlly,
    powerStageValues: normalizedPowerStageValues,
    considered_as_styled_card: normalizedConsideredAsStyledCard,
    limit_per_deck: normalizedLimitPerDeck,
    banished_after_use: normalizedBanishedAfterUse,
    shuffle_into_deck_after_use: normalizedShuffleIntoDeckAfterUse,
    drill_not_discarded_when_changing_levels: normalizedDrillNotDiscardedWhenChangingLevels,
    attach_limit: normalizedAttachLimit,
    extraordinary_can_play_from_hand: normalizedExtraordinaryCanPlayFromHand,
    has_effect_when_discarded_combat: normalizedHasEffectWhenDiscardedCombat,
    seaches_owner_life_deck: normalizedSeachesOwnerLifeDeck,
    rejuvenates_amount: normalizedResolvedRejuvenatesAmount,
    conditional_rejuvenate: normalizedConditionalRejuvenate,
    conditional_endurance: normalizedConditionalEndurance,
    raise_your_anger: normalizedResolvedRaiseYourAnger,
    conditional_raise_your_anger: normalizedConditionalRaiseYourAnger,
    lower_your_anger: normalizedResolvedLowerYourAnger,
    conditional_lower_your_anger: normalizedConditionalLowerYourAnger,
    raise_or_lower_any_player_anger: normalizedResolvedRaiseOrLowerAnyPlayerAnger,
    conditional_raise_or_lower_any_player_anger: normalizedConditionalRaiseOrLowerAnyPlayerAnger,
    when_drill_enters_play_during_combat: normalizedWhenDrillEntersPlayDuringCombat,
    when_drill_enters_play: normalizedWhenDrillEntersPlay,
    attaches_own_main_personality: normalizedAttachesOwnMainPersonality,
    attaches_opponent_main_personality: normalizedAttachesOpponentMainPersonality,
    confidence: {
      ...card.confidence,
      fields: normalizedConfidenceFields
    },
    cardTextRaw: normalizedCardTextRaw,
    source: {
      ...card.source,
      imageFileName: normalizedSourceImageFileName
    },
    endurance: normalizedConditionalEndurance && normalizedEndurance === null ? 0 : normalizedEndurance
  };
}

function normalizeAffiliationValue(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown";
  }
  const normalized = value.trim().toLowerCase();
  if (["hero", "villain", "neutral", "unknown"].includes(normalized)) {
    return normalized;
  }
  return "unknown";
}

function compareCardsByRarity(left: CardRecord, right: CardRecord): number {
  const leftRarity = normalizeRarityPrefixValue(left.rarityPrefix, left.printedNumber);
  const rightRarity = normalizeRarityPrefixValue(right.rarityPrefix, right.printedNumber);
  const leftRank = RARITY_RANK[leftRarity] ?? Number.MAX_SAFE_INTEGER;
  const rightRank = RARITY_RANK[rightRarity] ?? Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.printedNumber.localeCompare(right.printedNumber, undefined, { numeric: true, sensitivity: "base" });
}

function normalizeRarityPrefixValue(value: unknown, printedNumber: string): string {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (RARITY_SET.has(normalized)) {
    return normalized;
  }
  return inferRarityPrefixFromPrintedNumber(printedNumber);
}

function inferRarityPrefixFromPrintedNumber(printedNumber: string): string {
  const normalized = printedNumber.toUpperCase();
  if (/^UR\d/.test(normalized)) {
    return "UR";
  }
  if (/^DR\d/.test(normalized)) {
    return "DR";
  }
  if (/^C\d/.test(normalized)) {
    return "C";
  }
  if (/^U\d/.test(normalized)) {
    return "U";
  }
  if (/^R\d/.test(normalized)) {
    return "R";
  }
  if (/^S\d/.test(normalized)) {
    return "S";
  }
  if (/^P\d/.test(normalized)) {
    return "P";
  }
  return "UNK";
}

function normalizeRawCardTypeToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  return normalized.length > 0 ? normalized : null;
}

function normalizeCardTypeValue(value: unknown): string | null {
  const normalized = normalizeRawCardTypeToken(value);
  if (!normalized) {
    return null;
  }
  if (normalized === "main_personality" || normalized === "ally") {
    return "personality";
  }
  if (
    [
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
    ].includes(normalized)
  ) {
    return normalized;
  }
  return null;
}

function inferAffiliationFromTags(tags: string[]): string {
  const lowered = tags.map((tag) => tag.toLowerCase());
  if (lowered.some((tag) => tag === "hero" || tag.includes("heroes-only") || tag.includes("heroic"))) {
    return "hero";
  }
  if (lowered.some((tag) => tag === "villain" || tag.includes("villains-only") || tag.includes("villainous"))) {
    return "villain";
  }
  return "unknown";
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toTextLines(values: string[]): string {
  return values.join("\n");
}

function fromTextLines(text: string): string[] {
  return text
    .split(/\r?\n|,/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function findOrCreateCardForImage(item: ImageInventoryItem, cards: CardRecord[]): CardRecord {
  const existing = cards.find((card) => normalizePath(card.source.imagePath) === normalizePath(item.imagePath));
  if (existing) {
    return existing;
  }

  const printedNumber = extractPrintedNumberFromImageFileName(item.imageFileName) ?? "UNK000";
  const rarityPrefix = normalizeRarityPrefixValue(null, printedNumber);
  const fallbackId = item.cardId ?? `${item.setCode}-${printedNumber}`;

  return {
    id: fallbackId,
    setCode: item.setCode,
    setName: item.setName,
    printedNumber,
    rarityPrefix,
    name: item.imageFileName.replace(/\.[^.]+$/, ""),
    title: null,
    characterKey: null,
    personalityFamilyId: null,
    cardType: "unknown",
    affiliation: "unknown",
    isMainPersonality: false,
    isAlly: false,
    cardSubtypes: [],
    style: null,
    icons: {
      isAttack: false,
      isDefense: false,
      isQuick: false,
      isConstant: false,
      rawIconEvidence: []
    },
    tags: [],
    powerStageValues: [],
    pur: null,
    endurance: null,
    considered_as_styled_card: false,
    limit_per_deck: defaultLimitPerDeckForCardType("unknown"),
    banished_after_use: false,
    shuffle_into_deck_after_use: false,
    drill_not_discarded_when_changing_levels: false,
    attach_limit: "infinity",
    extraordinary_can_play_from_hand: false,
    has_effect_when_discarded_combat: false,
    seaches_owner_life_deck: false,
    rejuvenates_amount: null,
    conditional_rejuvenate: false,
    conditional_endurance: false,
    raise_your_anger: null,
    conditional_raise_your_anger: false,
    lower_your_anger: null,
    conditional_lower_your_anger: false,
    raise_or_lower_any_player_anger: null,
    conditional_raise_or_lower_any_player_anger: false,
    when_drill_enters_play_during_combat: false,
    when_drill_enters_play: false,
    attaches_own_main_personality: false,
    attaches_opponent_main_personality: false,
    personalityLevel: null,
    mainPowerText: null,
    cardTextRaw: item.imageFileName.replace(/\.[^.]+$/, ""),
    effectChunks: [],
    source: {
      imagePath: item.imagePath,
      imageFileName: item.imageFileName,
      sourceUrl: null
    },
    confidence: {
      overall: 0,
      fields: {}
    },
    review: {
      required: item.status !== "accepted",
      reasons: [],
      notes: []
    },
    raw: {
      ocrText: "",
      ocrBlocks: [],
      warnings: []
    }
  };
}

function extractPrintedNumberFromImageFileName(imageFileName: string): string | null {
  const stem = imageFileName.replace(/\.[^.]+$/, "");
  const match = stem.match(/^([A-Za-z]{1,3}\d{1,4}[A-Za-z0-9.-]*)/);
  return match ? match[1].toUpperCase() : null;
}

function pathBaseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function dedupeImagePaths(imagePaths: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const imagePath of imagePaths) {
    const trimmed = imagePath.trim();
    if (!trimmed) {
      continue;
    }
    const key = normalizePath(trimmed);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}

function mergeUniqueImagePaths(existingPaths: string[], nextPaths: string[]): string[] {
  const merged = [...existingPaths];
  const seen = new Set(existingPaths.map((entry) => normalizePath(entry)));
  for (const imagePath of nextPaths) {
    const trimmed = imagePath.trim();
    if (!trimmed) {
      continue;
    }
    const key = normalizePath(trimmed);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(trimmed);
  }
  return merged;
}

function toReviewKey(item: ReviewQueueItem): string {
  return `${item.cardId}|${item.createdAt}|${item.imagePath}`;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

function toFileImageUrl(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const prefixed = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
  return `file://${encodeURI(prefixed)}`;
}

function upsertCard(cards: CardRecord[], nextCard: CardRecord): CardRecord[] {
  const index = cards.findIndex((card) => card.id === nextCard.id);
  if (index === -1) {
    return [...cards, nextCard].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
  }
  const cloned = [...cards];
  cloned[index] = nextCard;
  return cloned;
}

function normalizeNullableString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseLimitPerDeckInput(value: string, fallback: number): number {
  const trimmed = value.trim();
  if (!trimmed) {
    return Math.max(1, Math.trunc(fallback || 1));
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return Math.max(1, Math.trunc(fallback || 1));
  }
  return Math.max(1, Math.trunc(parsed));
}

function normalizeLimitPerDeckValue(value: unknown, cardTextRaw: string, cardType: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }

  const fromText = extractLimitPerDeckFromText(cardTextRaw);
  if (fromText !== null) {
    return fromText;
  }

  return defaultLimitPerDeckForCardType(cardType);
}

function defaultLimitPerDeckForCardType(cardType: string): number {
  return cardType === "personality" || cardType === "mastery" || cardType === "dragon_ball" ? 1 : 3;
}

function extractLimitPerDeckFromText(text: string): number | null {
  const normalized = normalizeInstructionText(text);
  const match = normalized.match(
    /\blimit(?:ed)?(?:\s+to)?\s+(\d{1,2})(?:\s+(?:copy|copies|card|cards))?\s+per\s+deck\b/
  );
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
}

function detectConsideredAsStyledCard(text: string): boolean {
  const normalized = normalizeInstructionText(text);
  return (
    /\bthis card is considered styled for your card effects\b/.test(normalized) ||
    /\bconsidered styled for your card effects\b/.test(normalized) ||
    /\bis considered styled\b/.test(normalized)
  );
}

function detectBanishedAfterUse(text: string): boolean {
  const normalized = normalizeInstructionText(text);
  return (
    /\bbanish(?:ed|es)?(?: this card)? after use\b/.test(normalized) ||
    /\bremoved? from the game(?: this card)? after use\b/.test(normalized)
  );
}

function detectShuffleIntoDeckAfterUse(text: string): boolean {
  const normalized = normalizeInstructionText(text);
  return /\bshuffle(?:s|d)?(?: this card)? into (?:the )?(?:owner'?s?|your|its) (?:life )?deck after use\b/.test(
    normalized
  );
}

function normalizeInstructionText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeBooleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeNullableNonNegativeIntValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function normalizeAttachLimitValue(value: unknown): number | "infinity" {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "infinity") {
      return "infinity";
    }
    const parsed = Number(normalized);
    if (Number.isInteger(parsed) && parsed >= 1) {
      return parsed;
    }
    return "infinity";
  }

  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }

  return "infinity";
}

function parseNullableInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
