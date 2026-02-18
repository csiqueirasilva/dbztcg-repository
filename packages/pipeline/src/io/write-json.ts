import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeJsonFile(outputPath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
