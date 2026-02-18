import { readdir } from "node:fs/promises";
import path from "node:path";
import type { SetCode } from "@dbzccg/schema";
import { SET_DEFINITIONS } from "../constants.js";
import type { DiscoveredImage } from "../types.js";

const IMAGE_FILE_REGEX = /\.(jpg|jpeg|png|webp)$/i;

export interface DiscoverImagesOptions {
  imagesRoot: string;
  setCodes: SetCode[];
  maxCards?: number;
}

export async function discoverImages(options: DiscoverImagesOptions): Promise<DiscoveredImage[]> {
  const discovered: DiscoveredImage[] = [];
  const perSetLimit =
    options.maxCards !== undefined && options.maxCards >= 0 ? Math.max(0, options.maxCards) : Number.POSITIVE_INFINITY;

  for (const setCode of options.setCodes) {
    const definition = SET_DEFINITIONS[setCode];
    const setFolderPath = path.join(options.imagesRoot, definition.folderName);
    const entries = await readdir(setFolderPath, { withFileTypes: true });
    const imageEntries = entries
      .filter((entry) => entry.isFile() && IMAGE_FILE_REGEX.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));

    for (const entry of imageEntries.slice(0, perSetLimit)) {
      discovered.push({
        setCode,
        setName: definition.name,
        imagePath: path.join(setFolderPath, entry.name),
        imageFileName: entry.name
      });
    }
  }

  discovered.sort((left, right) => {
    if (left.setCode !== right.setCode) {
      return left.setCode.localeCompare(right.setCode);
    }
    return left.imageFileName.localeCompare(right.imageFileName, undefined, { numeric: true, sensitivity: "base" });
  });

  return discovered;
}
