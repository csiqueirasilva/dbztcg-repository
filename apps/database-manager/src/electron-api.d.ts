import type { CardRecord, LoadPayload, RescanSummary, ReviewQueueItem } from "./types";

interface DatabaseManagerApi {
  load: () => Promise<LoadPayload>;
  saveAll: (payload: { cards: CardRecord[]; reviewQueue: ReviewQueueItem[] }) => Promise<{ ok: true }>;
  readImageDataUrl: (imagePath: string) => Promise<string>;
  rescanCard: (payload: { imagePath: string }) => Promise<{ ok: true; payload: LoadPayload; summary: RescanSummary }>;
}

declare global {
  interface Window {
    databaseManagerApi: DatabaseManagerApi;
  }
}

export {};
