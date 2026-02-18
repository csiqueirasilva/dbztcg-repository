import { existsSync } from "node:fs";
import path from "node:path";

let cachedRepoRoot: string | null = null;

export function resolveRepoPath(pathValue: string): string {
  if (path.isAbsolute(pathValue)) {
    return pathValue;
  }
  return path.resolve(findRepoRoot(process.cwd()), pathValue);
}

export function findRepoRoot(startDirectory: string): string {
  if (cachedRepoRoot) {
    return cachedRepoRoot;
  }

  let currentDir = path.resolve(startDirectory);
  while (true) {
    const pnpmWorkspacePath = path.join(currentDir, "pnpm-workspace.yaml");
    const gitDirectoryPath = path.join(currentDir, ".git");
    if (existsSync(pnpmWorkspacePath) || existsSync(gitDirectoryPath)) {
      cachedRepoRoot = currentDir;
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      cachedRepoRoot = path.resolve(startDirectory);
      return cachedRepoRoot;
    }
    currentDir = parentDir;
  }
}
