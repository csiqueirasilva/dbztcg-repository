#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SOURCE_PAGE_URLS } from "./config/source-pages.js";
import type { ScrapeProgressEvent } from "./scrape.js";
import { scrapeAndDownloadImages } from "./scrape.js";

const DEFAULT_SELECTOR = ".blocks-gallery-item img,.gallery-group img";
const DEFAULT_OUTPUT_DIR = "packages/data/raw/images";

interface CliOptions {
  selector: string;
  outputDir: string;
  outputDirExplicit: boolean;
  manifestPath?: string;
  manifestPathExplicit: boolean;
  sourcePageUrls: string[];
  headless: boolean;
  downloadConcurrency: number;
  pageDelayMs: number;
  downloadIntervalMs: number;
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    const repoRoot = findRepoRoot(process.cwd());
    const outputDir = options.outputDirExplicit
      ? path.resolve(process.cwd(), options.outputDir)
      : path.resolve(repoRoot, options.outputDir);
    const manifestPath = options.manifestPath
      ? options.manifestPathExplicit
        ? path.resolve(process.cwd(), options.manifestPath)
        : path.resolve(repoRoot, options.manifestPath)
      : undefined;

    const result = await scrapeAndDownloadImages({
      selector: options.selector,
      outputDir,
      manifestPath,
      sourcePageUrls: options.sourcePageUrls,
      headless: options.headless,
      downloadConcurrency: options.downloadConcurrency,
      pageDelayMs: options.pageDelayMs,
      downloadIntervalMs: options.downloadIntervalMs,
      onProgress: printProgress
    });

    const downloaded = result.downloads.filter((item) => item.status === "downloaded").length;
    const failed = result.downloads.filter((item) => item.status === "failed").length;
    const pageErrors = result.sourcePageReports.filter((report) => typeof report.error === "string").length;

    console.log(`Scraped pages: ${result.totalSourcePages}`);
    console.log(`Discovered image references: ${result.totalDiscoveredImages}`);
    console.log(`Unique image URLs: ${result.uniqueImages}`);
    console.log(`Downloaded: ${downloaded}`);
    console.log(`Failed: ${failed}`);
    console.log(`Page errors: ${pageErrors}`);
    console.log("Per-source results:");

    for (const report of result.sourcePageReports) {
      if (report.error) {
        console.log(
          `  ${report.setName} (${report.sourcePageUrl}) => ${report.discoveredImages} (error: ${report.error})`
        );
        continue;
      }

      console.log(`  ${report.setName} (${report.sourcePageUrl}) => ${report.discoveredImages}`);
    }

    if (result.manifestPath) {
      console.log(`Manifest: ${result.manifestPath}`);
    }

    if (failed > 0 || pageErrors > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exitCode = 1;
  }
}

function parseArgs(args: string[]): CliOptions {
  const sourcePageUrls: string[] = [];
  let selector = DEFAULT_SELECTOR;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let outputDirExplicit = false;
  let manifestPath: string | undefined = "packages/data/raw/manifest.json";
  let manifestPathExplicit = false;
  let headless = true;
  let downloadConcurrency = 2;
  let pageDelayMs = 2_500;
  let downloadIntervalMs = 600;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];

    if (current === "--") {
      continue;
    }

    if (current === "--help" || current === "-h") {
      printUsage();
      process.exit(0);
    }

    if (current === "--url") {
      const value = expectValue(args, index, current);
      sourcePageUrls.push(value);
      index += 1;
      continue;
    }

    if (current === "--selector") {
      selector = expectValue(args, index, current);
      index += 1;
      continue;
    }

    if (current === "--out") {
      outputDir = expectValue(args, index, current);
      outputDirExplicit = true;
      index += 1;
      continue;
    }

    if (current === "--manifest") {
      manifestPath = expectValue(args, index, current);
      manifestPathExplicit = true;
      index += 1;
      continue;
    }

    if (current === "--no-manifest") {
      manifestPath = undefined;
      manifestPathExplicit = false;
      continue;
    }

    if (current === "--headed") {
      headless = false;
      continue;
    }

    if (current === "--concurrency") {
      const value = expectValue(args, index, current);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--concurrency must be an integer >= 1");
      }
      downloadConcurrency = parsed;
      index += 1;
      continue;
    }

    if (current === "--page-delay-ms") {
      const value = expectValue(args, index, current);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error("--page-delay-ms must be an integer >= 0");
      }
      pageDelayMs = parsed;
      index += 1;
      continue;
    }

    if (current === "--download-interval-ms") {
      const value = expectValue(args, index, current);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error("--download-interval-ms must be an integer >= 0");
      }
      downloadIntervalMs = parsed;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${current}`);
  }

  return {
    selector,
    outputDir,
    outputDirExplicit,
    manifestPath,
    manifestPathExplicit,
    sourcePageUrls: sourcePageUrls.length > 0 ? sourcePageUrls : [...DEFAULT_SOURCE_PAGE_URLS],
    headless,
    downloadConcurrency,
    pageDelayMs,
    downloadIntervalMs
  };
}

function expectValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printUsage(): void {
  console.log(`
Usage:
  pnpm --filter @dbzccg/scraper run scrape [options]

Options:
  --url <url>            Add a source page URL (repeatable). If omitted, uses the default array.
  --selector <css>       CSS selector used to find image nodes.
                         Default: "${DEFAULT_SELECTOR}"
  --out <dir>            Output folder for downloaded images.
                         Images are organized by inferred set subdirectories.
                         Default: "${DEFAULT_OUTPUT_DIR}"
  --manifest <file>      Write run metadata JSON.
                         Default: "packages/data/raw/manifest.json"
  --no-manifest          Disable manifest output.
  --concurrency <n>      Download concurrency (integer >= 1). Default: 2
  --page-delay-ms <n>    Delay between source pages in milliseconds. Default: 2500
  --download-interval-ms <n>
                         Minimum interval between image requests in ms. Default: 600
  --headed               Run Chromium in headed mode.
  --help, -h             Show this help.
`);
}

function findRepoRoot(startDirectory: string): string {
  let currentDir = path.resolve(startDirectory);

  while (true) {
    const pnpmWorkspacePath = path.join(currentDir, "pnpm-workspace.yaml");
    const gitDirectoryPath = path.join(currentDir, ".git");

    if (existsSync(pnpmWorkspacePath) || existsSync(gitDirectoryPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return startDirectory;
    }

    currentDir = parentDir;
  }
}

function printProgress(event: ScrapeProgressEvent): void {
  if (event.type === "run-start") {
    console.log(`[start] pages=${event.totalSourcePages} selector="${event.selector}"`);
    console.log(
      `[start] output=${event.outputDir} concurrency=${event.downloadConcurrency} ` +
        `pageDelayMs=${event.pageDelayMs} downloadIntervalMs=${event.downloadIntervalMs}`
    );
    return;
  }

  if (event.type === "page-start") {
    console.log(`[page ${event.pageIndex}/${event.totalPages}] ${event.setName} -> loading ${event.sourcePageUrl}`);
    return;
  }

  if (event.type === "page-complete") {
    console.log(`[page ${event.pageIndex}/${event.totalPages}] ${event.setName} discovered=${event.discoveredImages}`);
    return;
  }

  if (event.type === "page-error") {
    console.log(`[page ${event.pageIndex}/${event.totalPages}] ${event.setName} error=${event.error}`);
    return;
  }

  if (event.type === "discovery-complete") {
    console.log(`[discover] total=${event.totalDiscoveredImages} unique=${event.uniqueImages}`);
    return;
  }

  if (event.type === "download-progress") {
    if (event.status === "failed") {
      console.log(
        `[download] ${event.completed}/${event.total} ok=${event.downloaded} failed=${event.failed} ` +
          `status=failed url=${event.lastImageUrl} error=${event.error ?? "unknown"}`
      );
      return;
    }

    console.log(
      `[download] ${event.completed}/${event.total} ok=${event.downloaded} failed=${event.failed} ` +
        `last=${event.lastImageUrl}`
    );
    return;
  }

  console.log(`[done] total=${event.total} downloaded=${event.downloaded} failed=${event.failed}`);
}

main();
