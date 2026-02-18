import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "./repo-paths.js";

let loaded = false;

export function loadRepoEnvLocal(startDirectory: string = process.cwd()): string | null {
  if (loaded) {
    return null;
  }
  loaded = true;

  const repoRoot = findRepoRoot(startDirectory);
  const envLocalPath = path.join(repoRoot, ".env.local");
  if (!existsSync(envLocalPath)) {
    return null;
  }

  const fileContents = readFileSync(envLocalPath, "utf8");
  const parsed = parseDotEnv(fileContents);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return envLocalPath;
}

function parseDotEnv(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const separatorIndex = withoutExport.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = withoutExport.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    const rawValue = withoutExport.slice(separatorIndex + 1).trim();
    parsed[key] = decodeDotEnvValue(rawValue);
  }

  return parsed;
}

function decodeDotEnvValue(rawValue: string): string {
  if (rawValue.length === 0) {
    return "";
  }

  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    const quote = rawValue[0];
    const inner = rawValue.slice(1, -1);
    if (quote === "'") {
      return inner;
    }
    return inner
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  return rawValue.replace(/\s+#.*$/, "").trim();
}
