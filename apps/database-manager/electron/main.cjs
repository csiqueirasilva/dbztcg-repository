const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const WINDOW_TITLE = "DBZ CCG Database Manager";
const IMAGE_FILE_REGEX = /\.(jpg|jpeg|png|webp)$/i;
const SET_DEFINITIONS = [
  { setCode: "AWA", setName: "Awakening", folderName: "Awakening" },
  { setCode: "EVO", setName: "Evolution", folderName: "Evolution" },
  { setCode: "HNV", setName: "Heroes & Villains", folderName: "Heroes & Villains" },
  { setCode: "MOV", setName: "Movie Collection", folderName: "Movie Collection" },
  { setCode: "PER", setName: "Perfection", folderName: "Perfection" },
  { setCode: "PRE", setName: "Premiere Set", folderName: "Premiere Set" },
  { setCode: "VEN", setName: "Vengeance", folderName: "Vengeance" }
];

loadRepoEnvLocalDefaults();

function findRepoRoot(startDirectory) {
  let currentDir = path.resolve(startDirectory);
  while (true) {
    if (fsSync.existsSync(path.join(currentDir, "pnpm-workspace.yaml")) || fsSync.existsSync(path.join(currentDir, ".git"))) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return path.resolve(startDirectory);
    }
    currentDir = parentDir;
  }
}

function loadRepoEnvLocalDefaults() {
  const repoRoot = findRepoRoot(process.cwd());
  const envLocalPath = path.join(repoRoot, ".env.local");
  if (!fsSync.existsSync(envLocalPath)) {
    return;
  }

  const contents = fsSync.readFileSync(envLocalPath, "utf8");
  const parsed = parseDotEnv(contents);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseDotEnv(contents) {
  const parsed = {};
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

function decodeDotEnvValue(rawValue) {
  if (!rawValue) {
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

function getDatabasePaths() {
  const repoRoot = findRepoRoot(process.cwd());
  return {
    repoRoot,
    cardsPath: path.join(repoRoot, "packages", "data", "data", "cards.v1.json"),
    reviewQueuePath: path.join(repoRoot, "packages", "data", "raw", "review-queue.v1.json"),
    setsPath: path.join(repoRoot, "packages", "data", "data", "sets.v1.json"),
    imagesRoot: path.join(repoRoot, "packages", "data", "raw", "images")
  };
}

async function readJsonFile(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return fallbackValue;
    }
    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array.`);
  }
}

function normalizePath(value) {
  return value.replace(/\\/g, "/").toLowerCase();
}

function toAbsolutePath(repoRoot, rawPath) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return null;
  }
  const trimmed = rawPath.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("data:")) {
    return null;
  }
  if (trimmed.startsWith("file://")) {
    try {
      return path.resolve(decodeURI(trimmed.replace(/^file:\/\//, "")));
    } catch {
      return path.resolve(trimmed.replace(/^file:\/\//, ""));
    }
  }
  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  return path.resolve(repoRoot, trimmed);
}

async function buildImageInventory(paths, cards, reviewQueue) {
  const cardByImagePath = new Map();
  const cardBySetAndFile = new Map();
  for (const card of cards) {
    if (!card || typeof card !== "object") {
      continue;
    }
    const source = card.source;
    if (!source || typeof source !== "object") {
      continue;
    }
    const imagePath = toAbsolutePath(paths.repoRoot, source.imagePath);
    const imageFileName = typeof source.imageFileName === "string" ? source.imageFileName : "";
    const setCode = typeof card.setCode === "string" ? card.setCode : "";
    if (imagePath) {
      cardByImagePath.set(normalizePath(imagePath), card);
    }
    if (setCode && imageFileName) {
      cardBySetAndFile.set(`${setCode}|${imageFileName}`, card);
    }
  }

  const reviewByImagePath = new Map();
  const reviewBySetAndFile = new Map();
  for (const item of reviewQueue) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const imagePath = toAbsolutePath(paths.repoRoot, item.imagePath);
    const setCode = typeof item.setCode === "string" ? item.setCode : "";
    const imageFileName = typeof item.imagePath === "string" ? path.basename(item.imagePath) : "";
    if (imagePath) {
      reviewByImagePath.set(normalizePath(imagePath), item);
    }
    if (setCode && imageFileName) {
      reviewBySetAndFile.set(`${setCode}|${imageFileName}`, item);
    }
  }

  const inventory = [];
  for (const definition of SET_DEFINITIONS) {
    const setFolderPath = path.join(paths.imagesRoot, definition.folderName);
    let entries = [];
    try {
      entries = await fs.readdir(setFolderPath, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    const files = entries
      .filter((entry) => entry.isFile() && IMAGE_FILE_REGEX.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));

    for (const imageFileName of files) {
      const imagePath = path.join(setFolderPath, imageFileName);
      const normalizedImagePath = normalizePath(imagePath);
      const card = cardByImagePath.get(normalizedImagePath) ?? cardBySetAndFile.get(`${definition.setCode}|${imageFileName}`);
      const reviewItem =
        reviewByImagePath.get(normalizedImagePath) ?? reviewBySetAndFile.get(`${definition.setCode}|${imageFileName}`);

      let status = "unread";
      if (reviewItem) {
        status = "review";
      } else if (card) {
        status = "accepted";
      }

      inventory.push({
        setCode: definition.setCode,
        setName: definition.setName,
        imagePath,
        imageFileName,
        status,
        cardId:
          (card && typeof card.id === "string" ? card.id : null) ||
          (reviewItem && typeof reviewItem.cardId === "string" ? reviewItem.cardId : null)
      });
    }
  }

  return inventory;
}

async function loadDatabasePayload() {
  const paths = getDatabasePaths();
  const [cards, reviewQueue, sets] = await Promise.all([
    readJsonFile(paths.cardsPath, []),
    readJsonFile(paths.reviewQueuePath, []),
    readJsonFile(paths.setsPath, [])
  ]);

  assertArray(cards, "cards");
  assertArray(reviewQueue, "reviewQueue");
  assertArray(sets, "sets");
  const imageInventory = await buildImageInventory(paths, cards, reviewQueue);

  return { paths, cards, reviewQueue, sets, imageInventory };
}

function toDataUrl(buffer, extension) {
  const extensionLower = extension.toLowerCase();
  const mimeTypeByExtension = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif"
  };
  const mimeType = mimeTypeByExtension[extensionLower] ?? "application/octet-stream";
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function normalizeImagePath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error("imagePath must be a non-empty string.");
  }
  const trimmed = rawPath.trim();
  if (trimmed.startsWith("file://")) {
    try {
      return decodeURI(trimmed.replace(/^file:\/\//, ""));
    } catch {
      return trimmed.replace(/^file:\/\//, "");
    }
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  const { repoRoot } = getDatabasePaths();
  return path.resolve(repoRoot, trimmed);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        exitCode: null,
        stdout,
        stderr,
        error
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout,
        stderr
      });
    });
  });
}

function summarizeRescanFromPayload(payload, imagePath) {
  const normalizedTarget = normalizePath(path.resolve(imagePath));
  const matchedCard = payload.cards.find((card) => {
    if (!card || typeof card !== "object" || !card.source || typeof card.source !== "object") {
      return false;
    }
    const cardPath = toAbsolutePath(payload.paths.repoRoot, card.source.imagePath);
    return cardPath ? normalizePath(cardPath) === normalizedTarget : false;
  });
  const matchedReview = payload.reviewQueue.find((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const reviewPath = toAbsolutePath(payload.paths.repoRoot, item.imagePath);
    return reviewPath ? normalizePath(reviewPath) === normalizedTarget : false;
  });

  if (matchedReview) {
    return {
      imagePath,
      status: "review",
      cardId: typeof matchedReview.cardId === "string" ? matchedReview.cardId : null
    };
  }
  if (matchedCard) {
    return {
      imagePath,
      status: "accepted",
      cardId: typeof matchedCard.id === "string" ? matchedCard.id : null
    };
  }
  return {
    imagePath,
    status: "unknown",
    cardId: null
  };
}

function registerIpcHandlers() {
  ipcMain.handle("db:load", async () => loadDatabasePayload());

  ipcMain.handle("db:save-all", async (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload.");
    }
    const cards = payload.cards;
    const reviewQueue = payload.reviewQueue;
    assertArray(cards, "cards");
    assertArray(reviewQueue, "reviewQueue");

    const paths = getDatabasePaths();
    await Promise.all([writeJsonFile(paths.cardsPath, cards), writeJsonFile(paths.reviewQueuePath, reviewQueue)]);
    return { ok: true };
  });

  ipcMain.handle("db:image-data-url", async (_event, rawPath) => {
    const imagePath = normalizeImagePath(rawPath);
    const imageBuffer = await fs.readFile(imagePath);
    return toDataUrl(imageBuffer, path.extname(imagePath));
  });

  ipcMain.handle("db:rescan-card", async (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload.");
    }
    const rawImagePath = payload.imagePath;
    const imagePath = normalizeImagePath(rawImagePath);
    const paths = getDatabasePaths();

    const commandResult = await runCommand(
      "pnpm",
      [
        "--filter",
        "@dbzccg/pipeline",
        "run",
        "rescan:card",
        "--",
        "--image",
        imagePath,
        "--cards",
        paths.cardsPath,
        "--review-queue",
        paths.reviewQueuePath,
        "--sets",
        paths.setsPath
      ],
      { cwd: paths.repoRoot }
    );

    if (commandResult.exitCode !== 0 || commandResult.error) {
      const stderr = commandResult.stderr?.trim() ?? "";
      const stdout = commandResult.stdout?.trim() ?? "";
      const reason = commandResult.error ? commandResult.error.message : `exit code ${String(commandResult.exitCode)}`;
      throw new Error(
        `Rescan failed (${reason}).${stderr ? ` stderr: ${stderr}` : ""}${stdout ? ` stdout: ${stdout}` : ""}`
      );
    }

    const nextPayload = await loadDatabasePayload();
    const summary = summarizeRescanFromPayload(nextPayload, imagePath);
    return {
      ok: true,
      payload: nextPayload,
      summary: {
        ...summary,
        commandOutput: (commandResult.stdout ?? "").trim()
      }
    };
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    title: WINDOW_TITLE,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.removeMenu();

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    window.loadURL(devServerUrl);
  } else {
    window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
