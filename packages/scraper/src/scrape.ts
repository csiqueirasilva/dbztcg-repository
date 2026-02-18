import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

export interface ScrapeOptions {
  sourcePageUrls: string[];
  selector: string;
  outputDir: string;
  headless?: boolean;
  requestTimeoutMs?: number;
  downloadConcurrency?: number;
  pageDelayMs?: number;
  downloadIntervalMs?: number;
  manifestPath?: string;
  onProgress?: (event: ScrapeProgressEvent) => void;
}

export interface DownloadResult {
  sourcePageUrl: string;
  setName: string;
  imageUrl: string;
  altText: string;
  status: "downloaded" | "failed";
  filePath?: string;
  error?: string;
}

export interface SourcePageReport {
  sourcePageUrl: string;
  setName: string;
  discoveredImages: number;
  error?: string;
}

export interface ScrapeRunResult {
  startedAt: string;
  finishedAt: string;
  selector: string;
  outputDir: string;
  totalSourcePages: number;
  totalDiscoveredImages: number;
  uniqueImages: number;
  sourcePageReports: SourcePageReport[];
  downloads: DownloadResult[];
  manifestPath?: string;
}

export type ScrapeProgressEvent =
  | {
      type: "run-start";
      totalSourcePages: number;
      selector: string;
      outputDir: string;
      downloadConcurrency: number;
      pageDelayMs: number;
      downloadIntervalMs: number;
    }
  | {
      type: "page-start";
      pageIndex: number;
      totalPages: number;
      sourcePageUrl: string;
      setName: string;
    }
  | {
      type: "page-complete";
      pageIndex: number;
      totalPages: number;
      sourcePageUrl: string;
      setName: string;
      discoveredImages: number;
    }
  | {
      type: "page-error";
      pageIndex: number;
      totalPages: number;
      sourcePageUrl: string;
      setName: string;
      error: string;
    }
  | {
      type: "discovery-complete";
      totalDiscoveredImages: number;
      uniqueImages: number;
    }
  | {
      type: "download-progress";
      completed: number;
      total: number;
      downloaded: number;
      failed: number;
      status: "downloaded" | "failed";
      lastImageUrl: string;
      error?: string;
    }
  | {
      type: "run-complete";
      total: number;
      downloaded: number;
      failed: number;
    };

interface DiscoveredImage {
  sourcePageUrl: string;
  setName: string;
  setDirectory: string;
  imageUrl: string;
  altText: string;
}

const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/svg+xml": ".svg"
};

export async function scrapeAndDownloadImages(options: ScrapeOptions): Promise<ScrapeRunResult> {
  const startedAt = new Date().toISOString();
  const timeoutMs = options.requestTimeoutMs ?? 90_000;
  const concurrency = Math.max(1, options.downloadConcurrency ?? 2);
  const pageDelayMs = Math.max(0, options.pageDelayMs ?? 2_500);
  const downloadIntervalMs = Math.max(0, options.downloadIntervalMs ?? 600);
  const waitForDownloadSlot = createGlobalRateLimiter(downloadIntervalMs);
  const emitProgress = options.onProgress ?? (() => undefined);

  await mkdir(options.outputDir, { recursive: true });
  emitProgress({
    type: "run-start",
    totalSourcePages: options.sourcePageUrls.length,
    selector: options.selector,
    outputDir: options.outputDir,
    downloadConcurrency: concurrency,
    pageDelayMs,
    downloadIntervalMs
  });

  const sourcePageReports: SourcePageReport[] = [];
  const discoveredImages: DiscoveredImage[] = [];
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const page = await browser.newPage();

  try {
    for (const [pageIndex, sourcePageUrl] of options.sourcePageUrls.entries()) {
      const setName = inferSetNameFromUrl(sourcePageUrl);
      const setDirectory = sanitizeDirectorySegment(setName);

      if (pageIndex > 0 && pageDelayMs > 0) {
        await sleep(pageDelayMs);
      }

      emitProgress({
        type: "page-start",
        pageIndex: pageIndex + 1,
        totalPages: options.sourcePageUrls.length,
        sourcePageUrl,
        setName
      });

      try {
        await page.goto(sourcePageUrl, {
          timeout: timeoutMs,
          waitUntil: "domcontentloaded"
        });

        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
        const isAccessDenied = await page.evaluate(() => {
          const pageTitle = (document.title ?? "").toLowerCase();
          const bodyText = (document.body?.innerText ?? "").toLowerCase();
          return pageTitle.includes("access denied") || bodyText.includes("access denied");
        });

        if (isAccessDenied) {
          throw new Error("Source page returned Access Denied. Reduce concurrency or retry later.");
        }

        const rawImages = await page.evaluate((selector) => {
          const elements = Array.from(document.querySelectorAll(selector));

          return elements
            .map((element) => {
              const imgElement = element instanceof HTMLImageElement ? element : element.querySelector("img");
              if (!(imgElement instanceof HTMLImageElement)) {
                return null;
              }

              const rawSrcSet = (imgElement.getAttribute("srcset") ?? "").trim();
              let srcSetLargest = "";
              if (rawSrcSet) {
                let bestRank = -1;
                const srcSetParts = rawSrcSet.split(",");
                for (const srcSetPartRaw of srcSetParts) {
                  const srcSetPart = srcSetPartRaw.trim();
                  if (!srcSetPart) {
                    continue;
                  }

                  const [urlPart = "", descriptor = ""] = srcSetPart.split(/\s+/, 2);
                  const candidateUrl = urlPart.trim();
                  if (!candidateUrl) {
                    continue;
                  }

                  let rank = 0;
                  const widthMatch = descriptor.match(/^(\d+)w$/);
                  const densityMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/);
                  if (widthMatch) {
                    rank = Number(widthMatch[1]);
                  } else if (densityMatch) {
                    rank = Number(densityMatch[1]) * 10_000;
                  }

                  if (rank >= bestRank) {
                    bestRank = rank;
                    srcSetLargest = candidateUrl;
                  }
                }
              }

              const rawSourceCandidates = [
                imgElement.getAttribute("data-gallery-src"),
                imgElement.getAttribute("data-orig-file"),
                imgElement.getAttribute("data-original"),
                imgElement.getAttribute("data-full-url"),
                imgElement.getAttribute("data-full"),
                imgElement.getAttribute("data-lazy-src"),
                imgElement.getAttribute("data-src"),
                imgElement.getAttribute("data-layzr"),
                imgElement.getAttribute("data-large-file"),
                srcSetLargest,
                imgElement.currentSrc,
                imgElement.getAttribute("src"),
                imgElement.getAttribute("data-medium-file")
              ];

              const sourceCandidates: string[] = [];
              for (const rawSourceCandidate of rawSourceCandidates) {
                const trimmed = (rawSourceCandidate ?? "").trim();
                if (!trimmed || trimmed.startsWith("data:")) {
                  continue;
                }

                let normalized = trimmed.replaceAll("&amp;", "&");

                try {
                  let parsed = new URL(normalized, window.location.href);

                  // WordPress origin links frequently return 468 in bulk downloads.
                  // Route them through Jetpack image CDN canonical URL for stability.
                  if (
                    /^retrodbzccg\.com$/i.test(parsed.hostname) &&
                    parsed.pathname.startsWith("/wp-content/uploads/")
                  ) {
                    const proxied = new URL(`https://i0.wp.com/${parsed.hostname}${parsed.pathname}`);
                    for (const [key, value] of parsed.searchParams.entries()) {
                      proxied.searchParams.set(key, value);
                    }
                    parsed = proxied;
                  }

                  if (/^i\d\.wp\.com$/i.test(parsed.hostname)) {
                    parsed.searchParams.delete("w");
                    parsed.searchParams.delete("h");
                    parsed.searchParams.delete("fit");
                    parsed.searchParams.delete("resize");
                    parsed.searchParams.delete("crop");
                    parsed.searchParams.delete("quality");
                    parsed.searchParams.delete("q");
                    parsed.searchParams.set("ssl", "1");
                  }

                  if (Array.from(parsed.searchParams.keys()).length === 0) {
                    parsed.search = "";
                  }

                  normalized = parsed.href;
                } catch {
                  // keep the original normalized value
                }

                sourceCandidates.push(normalized);
              }

              const src = sourceCandidates[0];
              if (!src) {
                return null;
              }

              return {
                src,
                altText: imgElement.getAttribute("alt") ?? ""
              };
            })
            .filter((item): item is { src: string; altText: string } => item !== null);
        }, options.selector);

        for (const rawImage of rawImages) {
          try {
            const imageUrl = new URL(rawImage.src, sourcePageUrl).href;
            discoveredImages.push({
              sourcePageUrl,
              setName,
              setDirectory,
              imageUrl,
              altText: rawImage.altText
            });
          } catch {
            // Ignore malformed urls and continue scraping the page.
          }
        }

        sourcePageReports.push({
          sourcePageUrl,
          setName,
          discoveredImages: rawImages.length
        });

        emitProgress({
          type: "page-complete",
          pageIndex: pageIndex + 1,
          totalPages: options.sourcePageUrls.length,
          sourcePageUrl,
          setName,
          discoveredImages: rawImages.length
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        sourcePageReports.push({
          sourcePageUrl,
          setName,
          discoveredImages: 0,
          error: errorMessage
        });
        emitProgress({
          type: "page-error",
          pageIndex: pageIndex + 1,
          totalPages: options.sourcePageUrls.length,
          sourcePageUrl,
          setName,
          error: errorMessage
        });
      }
    }
  } finally {
    await page.close();
    await browser.close();
  }

  const uniqueImages = deduplicateImages(discoveredImages);
  emitProgress({
    type: "discovery-complete",
    totalDiscoveredImages: discoveredImages.length,
    uniqueImages: uniqueImages.length
  });

  const setOutputDirectories = Array.from(
    new Set(uniqueImages.map((image) => path.join(options.outputDir, image.setDirectory)))
  );
  const usedFileNamesByDirectory = new Map<string, Set<string>>();

  for (const setOutputDirectory of setOutputDirectories) {
    await mkdir(setOutputDirectory, { recursive: true });
    const existingFileNames = await readdir(setOutputDirectory).catch(() => []);
    usedFileNamesByDirectory.set(setOutputDirectory, new Set(existingFileNames));
  }

  let completedDownloads = 0;
  let successfulDownloads = 0;
  let failedDownloads = 0;
  const totalDownloads = uniqueImages.length;

  const downloads = await mapWithConcurrency(uniqueImages, concurrency, async (image, index) => {
    const setOutputDirectory = path.join(options.outputDir, image.setDirectory);
    const usedFileNames = usedFileNamesByDirectory.get(setOutputDirectory);
    if (!usedFileNames) {
      throw new Error(`Missing set output directory state for ${setOutputDirectory}`);
    }

    const downloadResult = await downloadImage({
      image,
      index,
      outputDir: setOutputDirectory,
      usedFileNames,
      waitForDownloadSlot
    });

    completedDownloads += 1;
    if (downloadResult.status === "downloaded") {
      successfulDownloads += 1;
    } else {
      failedDownloads += 1;
    }

    const shouldEmit =
      completedDownloads === 1 ||
      completedDownloads === totalDownloads ||
      completedDownloads % 20 === 0 ||
      downloadResult.status === "failed";

    if (shouldEmit) {
      emitProgress({
        type: "download-progress",
        completed: completedDownloads,
        total: totalDownloads,
        downloaded: successfulDownloads,
        failed: failedDownloads,
        status: downloadResult.status,
        lastImageUrl: downloadResult.imageUrl,
        error: downloadResult.error
      });
    }

    return downloadResult;
  });

  const result: ScrapeRunResult = {
    startedAt,
    finishedAt: new Date().toISOString(),
    selector: options.selector,
    outputDir: options.outputDir,
    totalSourcePages: options.sourcePageUrls.length,
    totalDiscoveredImages: discoveredImages.length,
    uniqueImages: uniqueImages.length,
    sourcePageReports,
    downloads,
    manifestPath: options.manifestPath
  };

  if (options.manifestPath) {
    await mkdir(path.dirname(options.manifestPath), { recursive: true });
    await writeFile(options.manifestPath, JSON.stringify(result, null, 2), "utf8");
  }

  emitProgress({
    type: "run-complete",
    total: downloads.length,
    downloaded: successfulDownloads,
    failed: failedDownloads
  });

  return result;
}

function deduplicateImages(images: DiscoveredImage[]): DiscoveredImage[] {
  const bySetAndUrl = new Map<string, DiscoveredImage>();

  for (const image of images) {
    const key = `${image.setDirectory}::${image.imageUrl}`;
    if (!bySetAndUrl.has(key)) {
      bySetAndUrl.set(key, image);
    }
  }

  return Array.from(bySetAndUrl.values());
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function sanitizeDirectorySegment(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function inferSetNameFromUrl(sourcePageUrl: string): string {
  let slug = "";

  try {
    const parsedUrl = new URL(sourcePageUrl);
    const segments = parsedUrl.pathname.split("/").filter((segment) => segment.length > 0);
    slug = segments.at(-1) ?? "";
  } catch {
    slug = sourcePageUrl;
  }

  const normalizedSlug = slug.toLowerCase();

  if (normalizedSlug.includes("premiere-set")) {
    return "Premiere Set";
  }
  if (normalizedSlug.includes("heroes-villains")) {
    return "Heroes & Villains";
  }
  if (normalizedSlug.includes("movie-collection")) {
    return "Movie Collection";
  }
  if (normalizedSlug.includes("evolution")) {
    return "Evolution";
  }
  if (normalizedSlug.includes("perfection")) {
    return "Perfection";
  }
  if (normalizedSlug.includes("vengeance")) {
    return "Vengeance";
  }
  if (normalizedSlug.includes("awakening")) {
    return "Awakening";
  }

  const cleaned = normalizedSlug
    .replace(/^panini-americas?-dragon-ball-z-tcg-dbz-/, "")
    .replace(/^panini-americas?-dragon-ball-z-tcg-/, "")
    .replace(/-full-set-list$/, "")
    .replace(/-set-list$/, "")
    .replace(/-set$/, "")
    .replace(/-/g, " ")
    .trim();

  if (!cleaned) {
    return "Unknown Set";
  }

  return cleaned
    .split(" ")
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function buildOutputName(imageUrl: string, index: number, contentTypeHeader: string | null): string {
  const parsed = new URL(imageUrl);
  const baseName = decodeURIComponent(path.basename(parsed.pathname)) || `image-${index + 1}`;
  const existingExtension = path.extname(baseName);
  const safeBaseName = sanitizeFileSegment(baseName) || `image-${index + 1}`;

  if (existingExtension) {
    return safeBaseName;
  }

  const extension = extensionFromContentType(contentTypeHeader);
  return `${safeBaseName}${extension}`;
}

function extensionFromContentType(contentTypeHeader: string | null): string {
  if (!contentTypeHeader) {
    return ".img";
  }

  const normalized = contentTypeHeader.split(";")[0]?.trim().toLowerCase();
  if (!normalized) {
    return ".img";
  }

  return CONTENT_TYPE_EXTENSION[normalized] ?? ".img";
}

function ensureUniqueFileName(fileName: string, usedFileNames: Set<string>): string {
  if (!usedFileNames.has(fileName)) {
    usedFileNames.add(fileName);
    return fileName;
  }

  const ext = path.extname(fileName);
  const name = fileName.slice(0, ext.length === 0 ? fileName.length : -ext.length);

  let counter = 2;
  while (true) {
    const candidate = `${name}-${counter}${ext}`;
    if (!usedFileNames.has(candidate)) {
      usedFileNames.add(candidate);
      return candidate;
    }
    counter += 1;
  }
}

async function downloadImage(input: {
  image: DiscoveredImage;
  index: number;
  outputDir: string;
  usedFileNames: Set<string>;
  waitForDownloadSlot: () => Promise<void>;
}): Promise<DownloadResult> {
  const { image, index, outputDir, usedFileNames, waitForDownloadSlot } = input;
  const candidateUrls = buildDownloadUrlCandidates(image.imageUrl);
  const maxAttemptsPerUrl = 3;

  let lastErrorMessage = "Unknown download error";

  for (const candidateUrl of candidateUrls) {
    for (let attempt = 1; attempt <= maxAttemptsPerUrl; attempt += 1) {
      try {
        await waitForDownloadSlot();

        const response = await fetch(candidateUrl, {
          headers: {
            accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            referer: image.sourcePageUrl,
            "user-agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
          }
        });

        if (!response.ok) {
          lastErrorMessage = `Download failed (${response.status} ${response.statusText})`;

          // Direct origin often returns 468 while Jetpack CDN succeeds.
          if (
            response.status === 468 &&
            candidateUrl === image.imageUrl &&
            candidateUrls.length > 1 &&
            candidateUrls[1] !== candidateUrl
          ) {
            break;
          }

          if (isRetryableStatus(response.status) && attempt < maxAttemptsPerUrl) {
            await sleep(attempt * 500);
            continue;
          }

          break;
        }

        const fileName = ensureUniqueFileName(
          buildOutputName(candidateUrl, index, response.headers.get("content-type")),
          usedFileNames
        );

        const filePath = path.join(outputDir, fileName);
        const fileBuffer = Buffer.from(await response.arrayBuffer());
        await writeFile(filePath, fileBuffer);

        return {
          sourcePageUrl: image.sourcePageUrl,
          setName: image.setName,
          imageUrl: image.imageUrl,
          altText: image.altText,
          status: "downloaded",
          filePath
        };
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : String(error);

        if (attempt < maxAttemptsPerUrl) {
          await sleep(attempt * 500);
          continue;
        }
      }
    }
  }

  return {
    sourcePageUrl: image.sourcePageUrl,
    setName: image.setName,
    imageUrl: image.imageUrl,
    altText: image.altText,
    status: "failed",
    error: lastErrorMessage
  };
}

function buildDownloadUrlCandidates(imageUrl: string): string[] {
  const candidates: string[] = [];
  const direct = normalizeDownloadUrl(imageUrl);
  if (direct) {
    candidates.push(direct);
  }

  const jetpackFallback = toJetpackProxyUrl(imageUrl);
  if (jetpackFallback && !candidates.includes(jetpackFallback)) {
    candidates.push(jetpackFallback);
  }

  if (candidates.length === 0) {
    return [imageUrl];
  }

  return candidates;
}

function normalizeDownloadUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (/^i\d\.wp\.com$/i.test(parsed.hostname)) {
      parsed.searchParams.delete("w");
      parsed.searchParams.delete("h");
      parsed.searchParams.delete("fit");
      parsed.searchParams.delete("resize");
      parsed.searchParams.delete("crop");
      parsed.searchParams.delete("quality");
      parsed.searchParams.delete("q");
      parsed.searchParams.set("ssl", "1");
    }

    if (Array.from(parsed.searchParams.keys()).length === 0) {
      parsed.search = "";
    }

    return parsed.href;
  } catch {
    return null;
  }
}

function toJetpackProxyUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (!/^retrodbzccg\.com$/i.test(parsed.hostname) || !parsed.pathname.startsWith("/wp-content/uploads/")) {
      return null;
    }

    const proxied = new URL(`https://i0.wp.com/${parsed.hostname}${parsed.pathname}`);
    for (const [key, value] of parsed.searchParams.entries()) {
      proxied.searchParams.set(key, value);
    }

    proxied.searchParams.delete("w");
    proxied.searchParams.delete("h");
    proxied.searchParams.delete("fit");
    proxied.searchParams.delete("resize");
    proxied.searchParams.delete("crop");
    proxied.searchParams.delete("quality");
    proxied.searchParams.delete("q");
    proxied.searchParams.set("ssl", "1");
    return proxied.href;
  } catch {
    return null;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createGlobalRateLimiter(minIntervalMs: number): () => Promise<void> {
  if (minIntervalMs <= 0) {
    return async () => undefined;
  }

  let lastStartMs = 0;
  let queue = Promise.resolve();

  return async () => {
    queue = queue.then(async () => {
      const nowMs = Date.now();
      const waitMs = Math.max(0, lastStartMs + minIntervalMs - nowMs);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      lastStartMs = Date.now();
    });

    await queue;
  };
}

async function mapWithConcurrency<T, TResult>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
  if (items.length === 0) {
    return [];
  }

  const output: TResult[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      output[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return output;
}
