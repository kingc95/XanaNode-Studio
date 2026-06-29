import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import {
  initWorkspace,
  openWorkspace,
  buildWorkspace,
  computeWorkspaceStatus,
  exportWorkspacePack,
  listFederationTargets,
  cloneFederationTarget,
  mountSubstrateImport,
  validateWorkspace,
  computeKnowledgeHealth,
  createNode,
  createRelationshipNode,
  createIntakeAnalysisContext,
  importAssetAsNode,
  inspectSubstratePackage,
  openPackAsWorkspace,
  updateNode,
  collapseRelationshipNode,
  planNodeDeletion,
  deleteNode,
  workspaceApi
} from "@xananode/workspace";
import { parseFrontMatter, stringifyFrontMatter, slugify } from "@xananode/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "../..");
const protocolIconPath = path.join(appRoot, "vendor", "xananode-core", "vendor", "xananode-protocol", "media", "images", "xananode-icon.svg");
const appMetadata = readAppMetadata();

let mainWindow = null;
let currentWorkspaceDir = null;
let hugoProcess = null;
let currentHugoPreviewRoot = null;
let augmentProcess = null;
let augmentService = {
  port: null,
  url: null,
  mode: null
};

app.setName("XanaNode Studio");
if (process.platform === "win32") app.setAppUserModelId("com.xananode.studio");

function rendererUrl() {
  if (process.env.VITE_DEV_SERVER_URL) return process.env.VITE_DEV_SERVER_URL;
  return `file://${path.join(__dirname, "../../dist/renderer/index.html")}`;
}

function resolveAugmentExecutable() {
  if (process.platform !== "win32") return null;
  const candidates = [
    path.join(appRoot, "vendor", "xananode-augment", "dist", "win-x64", "xananode-augment.exe"),
    path.join(app.getAppPath(), "vendor", "xananode-augment", "dist", "win-x64", "xananode-augment.exe"),
    path.resolve(appRoot, "..", "XanaNode-Augment", "dist", "win-x64", "xananode-augment.exe")
  ];
  for (const executable of candidates) {
    const runtimeDir = path.join(path.dirname(executable), "app");
    if (fs.existsSync(executable) && fs.existsSync(runtimeDir)) {
      return { executable, runtimeDir };
    }
  }
  return null;
}

function resolveAugmentSourceRoot() {
  const candidates = [
    path.join(appRoot, "vendor", "xananode-augment"),
    path.resolve(appRoot, "..", "XanaNode-Augment")
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "artifacts", "api-server", "src", "cli.ts"))) || null;
}

async function waitForAugmentHealth(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(new URL("/api/healthz", url));
      if (response.ok) {
        const payload = await response.json().catch(() => ({}));
        if (payload?.status === "ok") return true;
      }
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function augmentStatusPayload(extra = {}) {
  return sanitizeForIpc({
    running: Boolean(augmentProcess),
    url: augmentService.url,
    port: augmentService.port,
    mode: augmentService.mode,
    ...extra
  });
}

async function startAugmentService({ port } = {}) {
  if (augmentProcess && augmentService.url) {
    const ready = await waitForAugmentHealth(augmentService.url, 500);
    if (ready) return augmentStatusPayload({ ready: true });
    stopAugmentService();
  }

  const nextPort = port || await getAvailablePort(8788);
  const url = `http://127.0.0.1:${nextPort}/`;
  const sourceRoot = !app.isPackaged ? resolveAugmentSourceRoot() : null;
  const executable = sourceRoot ? null : resolveAugmentExecutable();
  let child = null;
  let mode = "source";

  if (sourceRoot) {
    child = spawn("node", ["./scripts/run-tsx.mjs", "./artifacts/api-server/src/cli.ts", "serve", "--port", String(nextPort), "--host", "127.0.0.1"], {
      cwd: sourceRoot,
      shell: false
    });
  } else if (executable) {
    mode = "executable";
    child = spawn(executable.executable, ["serve", "--port", String(nextPort), "--host", "127.0.0.1"], {
      cwd: executable.runtimeDir,
      shell: false
    });
  } else {
    const fallbackSourceRoot = resolveAugmentSourceRoot();
    if (!fallbackSourceRoot) {
      throw new Error("XanaNode Augment could not be found. Link or clone XanaNode-Augment into the XanaNode-Master stack.");
    }
    child = spawn("node", ["./scripts/run-tsx.mjs", "./artifacts/api-server/src/cli.ts", "serve", "--port", String(nextPort), "--host", "127.0.0.1"], {
      cwd: fallbackSourceRoot,
      shell: false
    });
  }

  augmentProcess = child;
  augmentService = { port: nextPort, url, mode };

  child.stdout.on("data", (data) => sendToRenderer("augment:log", data.toString()));
  child.stderr.on("data", (data) => sendToRenderer("augment:log", data.toString()));
  child.on("exit", (code) => {
    if (augmentProcess !== child) return;
    augmentProcess = null;
    const stopped = augmentStatusPayload({ code });
    augmentService = { port: null, url: null, mode: null };
    sendToRenderer("augment:stopped", stopped);
  });

  const ready = await waitForAugmentHealth(url);
  if (!ready) {
    stopAugmentService();
    throw new Error("XanaNode Augment did not become ready in time.");
  }

  return augmentStatusPayload({ ready: true });
}

function stopAugmentService() {
  if (!augmentProcess) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(augmentProcess.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    augmentProcess.kill("SIGTERM");
  }
  augmentProcess = null;
  augmentService = { port: null, url: null, mode: null };
}

async function ensureAugmentService() {
  if (augmentProcess && augmentService.url) {
    const ready = await waitForAugmentHealth(augmentService.url, 500);
    if (ready) return augmentService.url;
  }
  const status = await startAugmentService();
  return status.url;
}

async function callAugment(endpoint, options = {}) {
  const baseUrl = await ensureAugmentService();
  const response = await fetch(new URL(endpoint, baseUrl), {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `Augment request failed: ${response.status}`);
  }
  return payload;
}

function createWindow() {
  const title = `${appMetadata.product_name || "XanaNode Studio"} ${appMetadata.version ? `v${appMetadata.version}` : ""}`.trim();
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title,
    icon: protocolIconPath,
    backgroundColor: "#0f1117",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });
  installAppMenu();
  mainWindow.loadURL(rendererUrl());
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { webContents } = mainWindow;
  if (!webContents || webContents.isDestroyed()) return;
  webContents.send(channel, payload);
}

function sendStudioCommand(command, payload = {}) {
  sendToRenderer("studio:command", { command, ...payload });
}

function sendWorkspaceProgress(stage, message, extra = {}) {
  sendToRenderer("workspace:progress", {
    stage,
    message,
    ...extra
  });
}

function installAppMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { label: "Open Workspace...", accelerator: "CmdOrCtrl+O", click: () => sendStudioCommand("workspace:open") },
        { label: "Intertwingle .substrate...", accelerator: "CmdOrCtrl+Shift+O", click: () => sendStudioCommand("substrate:intertwingle") },
        { label: "Open Online Substrate...", accelerator: "CmdOrCtrl+Shift+L", click: () => sendStudioCommand("substrate:registry") },
        { type: "separator" },
        { label: "Save Node", accelerator: "CmdOrCtrl+S", click: () => sendStudioCommand("node:save") },
        { label: "Export .substrate", accelerator: "CmdOrCtrl+E", click: () => sendStudioCommand("substrate:export") },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" }
      ]
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "XanaNode",
      submenu: [
        { label: "Graph Projection", accelerator: "CmdOrCtrl+1", click: () => sendStudioCommand("projection:graph") },
        { label: "Preview Projection", accelerator: "CmdOrCtrl+2", click: () => sendStudioCommand("projection:hugo") },
        { label: "Both Projections", accelerator: "CmdOrCtrl+3", click: () => sendStudioCommand("projection:both") },
        { type: "separator" },
        { label: "Run Health Check", accelerator: "CmdOrCtrl+Shift+H", click: () => sendStudioCommand("workspace:health") },
        { label: "Build Substrate", accelerator: "CmdOrCtrl+B", click: () => sendStudioCommand("workspace:build") },
        { label: "Export .substrate", accelerator: "CmdOrCtrl+E", click: () => sendStudioCommand("substrate:export") },
        { label: "Build Preview", accelerator: "CmdOrCtrl+Shift+P", click: () => sendStudioCommand("preview:start") },
        { label: "Start Augment Service", accelerator: "CmdOrCtrl+Shift+A", click: () => sendStudioCommand("augment:start") },
        { label: "Stop Augment Service", click: () => sendStudioCommand("augment:stop") },
        { label: "Fit Graph", accelerator: "CmdOrCtrl+0", click: () => sendStudioCommand("graph:fit") },
        { label: "Zoom Graph In", accelerator: "CmdOrCtrl+Plus", click: () => sendStudioCommand("graph:zoom-in") },
        { label: "Zoom Graph Out", accelerator: "CmdOrCtrl+-", click: () => sendStudioCommand("graph:zoom-out") },
        { label: "Reset Graph View", accelerator: "CmdOrCtrl+Shift+0", click: () => sendStudioCommand("graph:reset") },
        { label: "Validate Workspace", accelerator: "CmdOrCtrl+Shift+V", click: () => sendStudioCommand("workspace:validate") }
      ]
    },
    { role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        {
          label: "XanaNode Canonical Site",
          click: () => shell.openExternal("https://xananode.com/")
        },
        {
          label: "XanaNode GitHub",
          click: () => shell.openExternal("https://github.com/kingc95")
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function readAppMetadata() {
  const fallback = {
    product_name: "XanaNode Studio",
    version: "0.1.0",
    built_at: "",
    git_commit: "",
    repository: "kingc95/XanaNode-Studio"
  };
  try {
    return {
      ...fallback,
      ...JSON.parse(fs.readFileSync(path.join(appRoot, "src", "generated", "build-metadata.json"), "utf8"))
    };
  } catch {
    return fallback;
  }
}

function resolveWorkspaceExecutable() {
  if (process.platform !== "win32") return null;
  const candidates = [
    path.join(appRoot, "vendor", "xananode-workspace-repo", "dist", "win-x64", "xananode-workspace.exe"),
    path.join(app.getAppPath(), "vendor", "xananode-workspace-repo", "dist", "win-x64", "xananode-workspace.exe"),
    path.resolve(appRoot, "..", "XanaNode-Workspace", "dist", "win-x64", "xananode-workspace.exe")
  ];
  for (const executable of candidates) {
    const runtimeDir = path.join(path.dirname(executable), "app");
    if (fs.existsSync(executable) && fs.existsSync(runtimeDir)) {
      return { executable, runtimeDir };
    }
  }
  return null;
}

function parseWorkspaceToolPayload(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

async function runWorkspaceExecutable(args, options = {}) {
  const tool = resolveWorkspaceExecutable();
  if (!tool) return null;
  return new Promise((resolve, reject) => {
    const child = spawn(tool.executable, [...args, "--json"], {
      cwd: options.cwd || appRoot,
      shell: false
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        try {
          resolve(parseWorkspaceToolPayload(stdout));
        } catch (error) {
          reject(new Error(`Could not parse workspace executable output: ${error.message}`));
        }
        return;
      }
      try {
        const payload = parseWorkspaceToolPayload(stderr) || parseWorkspaceToolPayload(stdout);
        reject(new Error(payload?.error || payload?.message || `Workspace executable exited with code ${code}`));
      } catch {
        reject(new Error(stderr.trim() || stdout.trim() || `Workspace executable exited with code ${code}`));
      }
    });
  });
}

async function initWorkspacePortable(targetDir, defaults = {}) {
  const payload = await runWorkspaceExecutable([
    "init",
    path.resolve(targetDir),
    "--name", defaults.name || "New XanaNode Substrate",
    ...(defaults.author ? ["--author", defaults.author] : []),
    ...(defaults.namespace ? ["--namespace", defaults.namespace] : []),
    ...(defaults.git === false ? ["--no-git"] : []),
    ...(defaults.includeHugo === true ? ["--with-hugo"] : [])
  ]);
  if (payload?.ok) {
    return openWorkspace(path.resolve(targetDir));
  }
  return initWorkspace(targetDir, defaults);
}

async function openPackAsWorkspacePortable(substrateSource, targetDir, options = {}) {
  const payload = await runWorkspaceExecutable([
    "open-pack",
    path.resolve(substrateSource),
    path.resolve(targetDir),
    ...(options.name ? ["--name", options.name] : []),
    ...(options.namespace ? ["--namespace", options.namespace] : []),
    ...(options.author ? ["--author", options.author] : []),
    ...(options.authorId ? ["--author-id", options.authorId] : []),
    ...(options.authorEmail ? ["--author-email", options.authorEmail] : []),
    ...(options.git === false ? ["--no-git"] : [])
  ]);
  if (payload?.ok) {
    return openWorkspace(path.resolve(targetDir));
  }
  return openPackAsWorkspace(substrateSource, targetDir, options);
}

async function buildWorkspacePortable(rootDir, options = {}) {
  const suggestionMode = options?.core?.suggestionMode || options?.suggestionMode || "review";
  const args = [
    "build",
    path.resolve(rootDir),
    "--suggestions-mode",
    suggestionMode
  ];
  if (options.out) args.push("--out", path.resolve(options.out));
  if (options.splitArtifacts === false) args.push("--no-split-artifacts");
  if (options.bundleJson === false) args.push("--no-bundle-json");
  if (options.bundleJsonl === true) args.push("--bundle-jsonl");
  const payload = await runWorkspaceExecutable(args);
  if (payload?.ok) return payload.data;
  return buildWorkspace(rootDir, options);
}

async function exportWorkspacePortable(rootDir, options = {}) {
  const suggestionMode = options?.suggestionMode || "review";
  const args = [
    "export",
    path.resolve(rootDir),
    "--suggestions-mode",
    suggestionMode
  ];
  if (options.out) args.push("--out", path.resolve(options.out));
  if (options.id) args.push("--id", options.id);
  if (options.name) args.push("--name", options.name);
  if (options.namespace) args.push("--namespace", options.namespace);
  if (options.version) args.push("--version", options.version);
  if (options.mode) args.push("--mode", options.mode);
  if (options.archive === false) args.push("--no-archive");
  if (options.splitArtifacts === false) args.push("--no-split-artifacts");
  if (options.bundleJson === false) args.push("--no-bundle-json");
  if (options.bundleJsonl === true) args.push("--bundle-jsonl");
  const payload = await runWorkspaceExecutable(args);
  if (payload?.ok) return payload.data;
  return exportWorkspacePack(rootDir, options);
}

async function validateWorkspacePortable(rootDir) {
  const payload = await runWorkspaceExecutable(["validate", path.resolve(rootDir)]);
  if (payload?.ok) return payload.data.validation;
  return validateWorkspace(rootDir);
}

async function openSubstrateAsWorkspace(substrateSource, options = {}) {
  sendWorkspaceProgress("inspect", "Inspecting substrate...");
  const substrateRoot = fs.existsSync(substrateSource) && fs.statSync(substrateSource).isFile()
    ? path.dirname(substrateSource)
    : substrateSource;
  const inspected = inspectSubstratePackage(substrateSource);
  const substrateManifest = inspected.manifest || readPackManifest(substrateRoot);
  sendWorkspaceProgress("prepare-working-copy", "Preparing working copy...");
  const targetDir = uniqueWorkspaceDir(`${options.name || substrateManifest.name || substrateManifest.id || path.basename(substrateRoot)} Working Copy`);
  currentWorkspaceDir = targetDir;
  sendWorkspaceProgress("open-working-copy", "Opening substrate as a working copy...");
  const workspace = await openPackAsWorkspacePortable(substrateSource, targetDir, {
    name: `${options.name || substrateManifest.name || "XanaNode Substrate"} Working Copy`,
    git: true
  });
  sendWorkspaceProgress("complete", "Substrate opened.");
  return ok({ workspace: normalizeWorkspace(workspace) });
}

async function intertwingleIntoCurrentWorkspace(substrateSource, options = {}) {
  if (!currentWorkspaceDir) {
    return openSubstrateAsWorkspace(substrateSource, options);
  }
  sendWorkspaceProgress("inspect", "Inspecting substrate...");
  sendWorkspaceProgress("mount", "Mounting substrate into the current workspace...");
  const result = await mountSubstrateImport(currentWorkspaceDir, substrateSource, options);
  sendWorkspaceProgress("health", "Refreshing workspace health and intake reviews...");
  const status = await computeWorkspaceStatus(currentWorkspaceDir);
  sendWorkspaceProgress("complete", "Substrate mounted.");
  return ok({
    workspace: normalizeWorkspace(result.workspace),
    mounted_import: result.entry,
    intake_reviews: status.intake_reviews || []
  });
}

async function handleOpenSubstrateFileDialog() {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Intertwingle XanaNode Substrate File",
      properties: ["openFile"],
      filters: [
        { name: "XanaNode substrates", extensions: ["substrate", "json", "jsonl"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return ok({ canceled: true });
    sendWorkspaceProgress("selected", `Selected ${path.basename(result.filePaths[0])}`);
    return intertwingleIntoCurrentWorkspace(result.filePaths[0]);
  } catch (error) {
    return fail(error);
  }
}

async function handleOpenSubstrateFolderDialog() {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Intertwingle XanaNode Substrate Folder",
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return ok({ canceled: true });
    sendWorkspaceProgress("selected", `Selected ${path.basename(result.filePaths[0])}`);
    return intertwingleIntoCurrentWorkspace(result.filePaths[0]);
  } catch (error) {
    return fail(error);
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  stopHugoPreview();
  stopAugmentService();
});
app.on("window-all-closed", () => {
  stopHugoPreview();
  stopAugmentService();
  if (process.platform !== "darwin") app.quit();
});

function ok(data = {}) {
  return { ok: true, ...data };
}

function fail(error) {
  return { ok: false, error: error?.message || String(error) };
}

function sanitizeForIpc(value) {
  try {
    return JSON.parse(JSON.stringify(value, (_key, entry) => {
      if (entry instanceof Error) {
        return {
          name: entry.name,
          message: entry.message,
          stack: entry.stack
        };
      }
      if (typeof entry === "bigint") return String(entry);
      return entry;
    }));
  } catch {
    return value;
  }
}

function normalizeWorkspace(ws) {
  return sanitizeForIpc({
    rootDir: ws.rootDir,
    manifest: ws.manifest,
    settings: ws.settings,
    authors: ws.authors,
    imports: ws.imports,
    nodes: ws.nodes,
    git: ws.git
  });
}

async function refreshWorkspace() {
  if (!currentWorkspaceDir) return null;
  return normalizeWorkspace(await openWorkspace(currentWorkspaceDir));
}

const AUGMENT_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".html",
  ".css",
  ".xml",
  ".yaml",
  ".yml"
]);

function classifyAugmentFile(sourceFile) {
  const ext = path.extname(sourceFile).toLowerCase();
  const title = path.basename(sourceFile, ext).replace(/[-_]+/g, " ").trim() || "Imported source";
  if (ext === ".pdf") {
    return {
      title,
      sourceType: "pdf",
      sourceText: fs.readFileSync(sourceFile).toString("base64")
    };
  }
  if (AUGMENT_TEXT_EXTENSIONS.has(ext)) {
    return {
      title,
      sourceType: "text",
      sourceText: fs.readFileSync(sourceFile, "utf8")
    };
  }
  return null;
}

function sessionBodyFromNode(node) {
  const passage = String(node?.sourceFragment || node?.summary || "").trim();
  if (!passage) return `# ${node?.title || "Untitled"}\n\n`;
  return `# ${node?.title || "Untitled"}\n\n${passage}\n`;
}

function isWikipediaFileSource(session) {
  return /wikipedia\.org\/wiki\/File:/i.test(String(session?.sourceUrl || ""));
}

function parseWikipediaFileMetadata(sourceText = "") {
  const readLine = (label) => {
    const match = String(sourceText).match(new RegExp(`^${label}:\\s*(.+)$`, "mi"));
    return match?.[1]?.trim() || "";
  };
  const descriptionMatch = String(sourceText).match(/=== File Description ===\n([\s\S]+)/m);
  return {
    title: readLine("Wikipedia File"),
    imageTitle: readLine("Image Title"),
    pageUrl: readLine("File Page URL"),
    mediaUrl: readLine("Media URL"),
    mimeType: readLine("MIME Type"),
    dimensions: readLine("Dimensions"),
    fileSize: readLine("File Size"),
    creator: readLine("Creator"),
    copyrightHolder: readLine("Copyright Holder"),
    date: readLine("Date"),
    source: readLine("Source"),
    credit: readLine("Credit"),
    license: readLine("License"),
    licenseUrl: readLine("License URL"),
    description: descriptionMatch?.[1]?.trim() || ""
  };
}

function wikipediaFileTitleFromUrl(url) {
  const match = String(url || "").match(/(?:([a-z]{2,3})\.)?wikipedia\.org\/wiki\/(File:[^#?]+)/i);
  if (!match) return { lang: "en", title: "" };
  return {
    lang: match[1] || "en",
    title: decodeURIComponent(match[2]).replace(/_/g, " ")
  };
}

async function fetchWikiImageInfoPage(apiBase, title) {
  const params = new URLSearchParams({
    action: "query",
    titles: title,
    prop: "imageinfo",
    iiprop: "url|mime|extmetadata",
    format: "json",
    redirects: "1"
  });
  const response = await fetch(`${apiBase}?${params}`, {
    headers: { "User-Agent": "XanaNodeStudio/1.0 (+https://xananode.com)" }
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  const pages = data?.query?.pages || {};
  const page = Object.values(pages)[0];
  if (!page || page.missing) return null;
  return page;
}

async function fetchOpenGraphImageUrl(pageUrl) {
  if (!pageUrl) return "";
  const response = await fetch(pageUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; XanaNodeStudio/1.0; +https://xananode.com)" }
  });
  if (!response.ok) return "";
  const html = await response.text();
  const propertyMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (propertyMatch?.[1]) return propertyMatch[1].trim();
  const nameMatch = html.match(/<meta[^>]+name=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  return nameMatch?.[1]?.trim() || "";
}

async function resolveWikipediaFileMediaMetadata(session, parsedMetadata = {}) {
  const metadata = { ...parsedMetadata };
  const { lang, title } = wikipediaFileTitleFromUrl(session?.sourceUrl || metadata.pageUrl || "");
  if (!title) return metadata;

  try {
    const wikiPage = await fetchWikiImageInfoPage(`https://${lang}.wikipedia.org/w/api.php`, title);
    const wikiInfo = wikiPage?.imageinfo?.[0];
    if (wikiInfo?.url && !metadata.mediaUrl) metadata.mediaUrl = wikiInfo.url;
    if (wikiInfo?.mime && !metadata.mimeType) metadata.mimeType = wikiInfo.mime;
    if (wikiInfo?.descriptionurl && !metadata.pageUrl) metadata.pageUrl = wikiInfo.descriptionurl;
    const wikiExt = wikiInfo?.extmetadata || {};
    if (!metadata.title) metadata.title = wikiExt.ObjectName?.value?.replace(/<[^>]+>/g, "").trim() || wikiPage?.title || metadata.title;
    if (!metadata.imageTitle) metadata.imageTitle = wikiExt.ObjectName?.value?.replace(/<[^>]+>/g, "").trim() || "";
    if (!metadata.creator) metadata.creator = wikiExt.Artist?.value?.replace(/<[^>]+>/g, "").trim() || "";
    if (!metadata.credit) metadata.credit = wikiExt.Credit?.value?.replace(/<[^>]+>/g, "").trim() || "";
    if (!metadata.license) metadata.license = (wikiExt.LicenseShortName?.value || wikiExt.UsageTerms?.value || "").replace(/<[^>]+>/g, "").trim();
    if (!metadata.licenseUrl) metadata.licenseUrl = wikiExt.LicenseUrl?.value?.trim() || "";
    if (!metadata.description) metadata.description = wikiExt.ImageDescription?.value?.replace(/<[^>]+>/g, "").trim() || "";
    if (!metadata.date) metadata.date = (wikiExt.DateTimeOriginal?.value || wikiExt.DateTime?.value || "").replace(/<[^>]+>/g, "").trim();
    if (!metadata.source) metadata.source = (wikiExt.Credit?.value || "").replace(/<[^>]+>/g, "").trim();
    if (!metadata.copyrightHolder) metadata.copyrightHolder = (wikiExt.Copyrighted?.value || "").replace(/<[^>]+>/g, "").trim();
    if (!metadata.dimensions && wikiInfo?.width && wikiInfo?.height) metadata.dimensions = `${wikiInfo.width} x ${wikiInfo.height}`;
    if (!metadata.fileSize && Number.isFinite(wikiInfo?.size)) metadata.fileSize = String(wikiInfo.size);
  } catch (error) {
    sendToRenderer("augment:log", `Wikipedia file resolver warning: ${error?.message || error}`);
  }

  try {
    const commonsPage = await fetchWikiImageInfoPage("https://commons.wikimedia.org/w/api.php", title);
    const commonsInfo = commonsPage?.imageinfo?.[0];
    if (commonsInfo?.url && !metadata.mediaUrl) metadata.mediaUrl = commonsInfo.url;
    if (commonsInfo?.mime && !metadata.mimeType) metadata.mimeType = commonsInfo.mime;
    if (commonsInfo?.descriptionurl && !metadata.pageUrl) metadata.pageUrl = commonsInfo.descriptionurl;
    const commonsExt = commonsInfo?.extmetadata || {};
    if (!metadata.title) metadata.title = commonsExt.ObjectName?.value?.replace(/<[^>]+>/g, "").trim() || commonsPage?.title || metadata.title;
    if (!metadata.imageTitle) metadata.imageTitle = commonsExt.ObjectName?.value?.replace(/<[^>]+>/g, "").trim() || "";
    if (!metadata.creator) metadata.creator = commonsExt.Artist?.value?.replace(/<[^>]+>/g, "").trim() || "";
    if (!metadata.credit) metadata.credit = commonsExt.Credit?.value?.replace(/<[^>]+>/g, "").trim() || "";
    if (!metadata.license) metadata.license = (commonsExt.LicenseShortName?.value || commonsExt.UsageTerms?.value || "").replace(/<[^>]+>/g, "").trim();
    if (!metadata.licenseUrl) metadata.licenseUrl = commonsExt.LicenseUrl?.value?.trim() || "";
    if (!metadata.description) metadata.description = commonsExt.ImageDescription?.value?.replace(/<[^>]+>/g, "").trim() || "";
    if (!metadata.date) metadata.date = (commonsExt.DateTimeOriginal?.value || commonsExt.DateTime?.value || "").replace(/<[^>]+>/g, "").trim();
    if (!metadata.source) metadata.source = (commonsExt.Credit?.value || "").replace(/<[^>]+>/g, "").trim();
    if (!metadata.copyrightHolder) metadata.copyrightHolder = (commonsExt.Credit?.value || "").replace(/<[^>]+>/g, "").trim();
    if (!metadata.dimensions && commonsInfo?.width && commonsInfo?.height) metadata.dimensions = `${commonsInfo.width} x ${commonsInfo.height}`;
    if (!metadata.fileSize && Number.isFinite(commonsInfo?.size)) metadata.fileSize = String(commonsInfo.size);
  } catch (error) {
    sendToRenderer("augment:log", `Commons file resolver warning: ${error?.message || error}`);
  }

  if (!metadata.mediaUrl) {
    try {
      metadata.mediaUrl = await fetchOpenGraphImageUrl(metadata.pageUrl || session?.sourceUrl || "");
    } catch (error) {
      sendToRenderer("augment:log", `Wikipedia og:image resolver warning: ${error?.message || error}`);
    }
  }

  return metadata;
}

function mediaDetailsFromMimeOrUrl(mimeType, url) {
  const mime = String(mimeType || "").toLowerCase();
  const lowerUrl = String(url || "").toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)(?:$|\?)/i.test(lowerUrl)) {
    return { subtype: "image", mediaType: "image" };
  }
  if (mime.startsWith("video/") || /\.(mp4|mov|m4v|webm)(?:$|\?)/i.test(lowerUrl)) {
    return { subtype: "video", mediaType: "video" };
  }
  if (mime.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac)(?:$|\?)/i.test(lowerUrl)) {
    return { subtype: "audio", mediaType: "audio" };
  }
  return { subtype: "document", mediaType: "document" };
}

function extensionFromMimeOrUrl(mimeType, url) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/svg+xml") return ".svg";
  if (mime === "video/mp4") return ".mp4";
  if (mime === "video/webm") return ".webm";
  if (mime === "audio/mpeg") return ".mp3";
  if (mime === "audio/wav") return ".wav";
  try {
    const pathname = new URL(String(url || "")).pathname;
    const ext = path.extname(pathname);
    return ext || ".bin";
  } catch {
    return ".bin";
  }
}

async function downloadRemoteAssetToTemp(url, preferredName, mimeType = "") {
  if (!url) throw new Error("No remote asset URL was provided.");
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; XanaNodeStudio/1.0; +https://xananode.com)",
      Accept: "*/*"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to download remote asset: ${response.status} ${response.statusText}`);
  }
  const ext = extensionFromMimeOrUrl(mimeType || response.headers.get("content-type") || "", url);
  const tempDir = path.join(app.getPath("temp"), "xananode-studio-augment");
  fs.mkdirSync(tempDir, { recursive: true });
  const fileName = `${slugify(preferredName || "captured-media", "captured-media")}${ext}`;
  const tempPath = path.join(tempDir, fileName);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(tempPath, buffer);
  return tempPath;
}

function inferAugmentSourceSubtype(session, sourceFile) {
  if (session?.sourceType === "github") return "git_repository";
  if (session?.sourceType === "url") {
    const url = String(session?.sourceUrl || "");
    if (/wikipedia\.org\/wiki\/File:/i.test(url)) return "website";
    if (/wikipedia\.org\/wiki\//i.test(url)) return "article";
    if (/github\.com\//i.test(url)) return "git_repository";
    return "website";
  }
  if (sourceFile) {
    const ext = path.extname(sourceFile).toLowerCase();
    if (ext === ".pdf") return "paper";
    if ([".md", ".txt", ".rst", ".adoc"].includes(ext)) return "documentation";
    if ([".csv", ".json", ".jsonl", ".xml", ".yaml", ".yml"].includes(ext)) return "dataset";
  }
  return "documentation";
}

function summarizeAugmentSource(session, sourceFile) {
  if (session?.sourceType === "github") {
    return "Repository captured through Augment and used as the source for extracted XanaNode candidates.";
  }
  if (session?.sourceType === "url") {
    if (isWikipediaFileSource(session)) {
      return "Wikipedia file page captured through Augment, preserving both file metadata and the downloadable media asset.";
    }
    if (/wikipedia\.org\/wiki\//i.test(String(session?.sourceUrl || ""))) {
      return "Wikipedia article captured through Augment and used as the source for extracted XanaNode candidates.";
    }
    return "Website captured through Augment and used as the source for extracted XanaNode candidates.";
  }
  if (sourceFile) {
    return "Local file captured through Augment and used as the source for extracted XanaNode candidates.";
  }
  return "Captured source used as the basis for extracted XanaNode candidates.";
}

function inferCompanionMediaDetails(sourceFile) {
  if (!sourceFile) return null;
  const ext = path.extname(sourceFile).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) {
    return { subtype: "image", mediaType: "image" };
  }
  if ([".mp4", ".mov", ".m4v", ".webm"].includes(ext)) {
    return { subtype: "video", mediaType: "video" };
  }
  if ([".mp3", ".wav", ".m4a", ".ogg", ".flac"].includes(ext)) {
    return { subtype: "audio", mediaType: "audio" };
  }
  return null;
}

async function ensureAugmentCompanionMediaNode(currentWorkspaceDir, sourceAnchor, session, sourceFile) {
  const localSourceFile = sourceFile && fs.existsSync(sourceFile) ? sourceFile : null;
  const mediaDetails = inferCompanionMediaDetails(localSourceFile);
  if (!mediaDetails || !sourceAnchor?.data?.asset || !sourceAnchor?.relativeFile) return null;
  const api = workspaceApi(currentWorkspaceDir);
  const sourceTitle = sourceAnchor.data?.title || session?.title || (localSourceFile ? path.basename(localSourceFile, path.extname(localSourceFile)) : "Captured Source");
  const mediaTitle = `${sourceTitle} Media`;
  const mediaBody = `# ${mediaTitle}\n\nMedia companion for ${sourceTitle} captured through Augment.\n`;
  const created = await api.createNode({
    title: mediaTitle,
    type: "media",
    subtype: mediaDetails.subtype,
    summary: `Media companion extracted from ${sourceTitle} during Augment intake.`,
    asset: sourceAnchor.data.asset,
    media_type: mediaDetails.mediaType,
    captured_via: "augment",
    augment_session_id: String(session?.id || "")
  }, mediaBody);

  const nextSourceRelationships = [
    ...(Array.isArray(sourceAnchor.data.relationships) ? sourceAnchor.data.relationships : []),
    {
      type: "has_primary_media",
      target: created.data.protocol_id,
      summary: "Primary media captured alongside this Augment source."
    }
  ].filter((relationship, index, list) => {
    const key = `${relationship.type}:${relationship.target}`;
    return list.findIndex((item) => `${item.type}:${item.target}` === key) === index;
  });

  await api.updateNode(
    sourceAnchor.relativeFile,
    {
      ...sourceAnchor.data,
      relationships: nextSourceRelationships
    },
    sourceAnchor.body
  );

  return {
    protocolId: created.data.protocol_id,
    relativeFile: path.relative(currentWorkspaceDir, created.filePath),
    data: created.data,
    body: mediaBody
  };
}

async function createAugmentSourceAnchor(currentWorkspaceDir, session, sourceFile) {
  const api = workspaceApi(currentWorkspaceDir);
  const localSourceFile = sourceFile && fs.existsSync(sourceFile) ? sourceFile : null;
  if (sourceFile && !localSourceFile && /^https?:\/\//i.test(String(sourceFile))) {
    sendToRenderer("augment:log", `Ignoring URL-like sourceFile during Augment apply: ${sourceFile}`);
  }
  if (localSourceFile) {
    const imported = await api.importAsset(localSourceFile, {
      title: session?.title || path.basename(localSourceFile, path.extname(localSourceFile)),
      type: "source",
      summary: summarizeAugmentSource(session, localSourceFile)
    });
    const workspace = await refreshWorkspace();
    const anchorNode = workspace?.nodes?.find((node) => (
      node.title === imported.nodeData?.title
      || node.data?.asset === imported.nodeData?.asset
      || node.data?.asset_path === imported.nodeData?.asset
    )) || null;
    return anchorNode ? {
      protocolId: anchorNode.protocolId || anchorNode.protocol_id || anchorNode.id,
      relativeFile: anchorNode.relativePath || anchorNode.path || anchorNode.filePath || anchorNode.__file,
      data: anchorNode.data || anchorNode,
      body: anchorNode.body || anchorNode.content || `# ${anchorNode.title || imported.nodeData?.title || "Source"}\n\n`
    } : null;
  }

  if (session?.sourceType === "url" && isWikipediaFileSource(session)) {
    const metadata = await resolveWikipediaFileMediaMetadata(session, parseWikipediaFileMetadata(session.sourceText || ""));
    const mediaUrl = metadata.mediaUrl || session.sourceUrl;
    if (!metadata.mediaUrl) {
      throw new Error("Wikipedia file metadata did not include a downloadable media URL, and Studio could not resolve one from Wikipedia or Commons.");
    }
    const sourceTitle = metadata.title || session?.title || "Wikipedia File";
    const mediaDetails = mediaDetailsFromMimeOrUrl(metadata.mimeType, mediaUrl);
    const tempAsset = await downloadRemoteAssetToTemp(mediaUrl, sourceTitle.replace(/^File:\s*/i, ""), metadata.mimeType);
    const importedSource = await api.importAsset(tempAsset, {
      title: sourceTitle,
      type: "source",
      subtype: "website",
      facets: ["media"],
      media_type: mediaDetails.mediaType,
      summary: summarizeAugmentSource(session, sourceFile),
      source_name: "Wikipedia",
      source_url: metadata.pageUrl || session.sourceUrl,
      creator: metadata.creator || undefined,
      rights_status: metadata.license || undefined,
      license_url: metadata.licenseUrl || undefined
    });
    const relativeFile = path.relative(currentWorkspaceDir, importedSource.nodePath).replaceAll(path.sep, "/");
    const sourceNodePath = path.resolve(importedSource.nodePath);
    const parsedSourceNode = fs.existsSync(sourceNodePath)
      ? parseFrontMatter(fs.readFileSync(sourceNodePath, "utf8"), sourceNodePath)
      : { data: importedSource.nodeData, body: "" };
    const sourceNodeData = parsedSourceNode?.data || importedSource.nodeData || {};

    const sourceBody = [
      `# ${sourceTitle}`,
      "",
      metadata.description || `Captured from ${metadata.pageUrl || session.sourceUrl}.`,
      metadata.imageTitle ? `\nImage title: ${metadata.imageTitle}` : "",
      metadata.creator ? `\nCreator: ${metadata.creator}` : "",
      metadata.copyrightHolder ? `\nCopyright holder: ${metadata.copyrightHolder}` : "",
      metadata.date ? `\nDate: ${metadata.date}` : "",
      metadata.source ? `\nSource: ${metadata.source}` : "",
      metadata.credit ? `\nCredit: ${metadata.credit}` : "",
      metadata.license ? `\nLicense: ${metadata.license}` : "",
      metadata.licenseUrl ? `\nLicense URL: ${metadata.licenseUrl}` : "",
      metadata.dimensions ? `\nDimensions: ${metadata.dimensions}` : "",
      metadata.fileSize ? `\nFile size: ${metadata.fileSize}` : ""
    ].join("\n").trim() + "\n";
    const nextData = {
      ...sourceNodeData,
      title: sourceTitle,
      type: "source",
      subtype: "website",
      facets: Array.from(new Set([...(Array.isArray(sourceNodeData?.facets) ? sourceNodeData.facets : []), "media"])),
      summary: summarizeAugmentSource(session, sourceFile),
      source_url: metadata.pageUrl || session.sourceUrl,
      source_name: "Wikipedia",
      creator: metadata.creator || undefined,
      copyright_holder: metadata.copyrightHolder || undefined,
      original_date: metadata.date || undefined,
      source_credit: metadata.credit || undefined,
      rights_status: metadata.license || undefined,
      license_url: metadata.licenseUrl || undefined,
      media_type: mediaDetails.mediaType,
      captured_via: "augment",
      augment_session_id: String(session?.id || "")
    };
    await api.updateNode(relativeFile, nextData, sourceBody);

    return {
      protocolId: nextData.protocol_id || sourceNodeData.protocol_id || sourceNodeData.id,
      relativeFile,
      data: nextData,
      body: sourceBody
    };
  }

  const title = session?.title || "Captured Source";
  const subtype = inferAugmentSourceSubtype(session, sourceFile);
  const sourceUrl = session?.sourceUrl || undefined;
  const body = `# ${title}\n\n${sourceUrl ? `Captured from ${sourceUrl}.\n` : "Captured through Augment.\n"}`;
  const created = await api.createNode({
    title,
    type: "source",
    subtype,
    summary: summarizeAugmentSource(session, sourceFile),
    source_url: sourceUrl,
    captured_via: "augment",
    augment_session_id: String(session?.id || "")
  }, body);
  return {
    protocolId: created.data.protocol_id,
    relativeFile: path.relative(currentWorkspaceDir, created.filePath),
    data: created.data,
    body
  };
}

async function applyAugmentSessionToWorkspace(sessionId, options = {}) {
  if (!currentWorkspaceDir) throw new Error("No workspace is open.");
  if (options.acceptPendingNodes === true) {
    await callAugment(`/api/sessions/${sessionId}/bulk-review`, {
      method: "POST",
      body: { status: "accepted", kindFilter: "node" }
    });
  }
  if (options.acceptPendingRelationships === true) {
    await callAugment(`/api/sessions/${sessionId}/bulk-review`, {
      method: "POST",
      body: { status: "accepted", kindFilter: "relationship" }
    });
  }

  const latestSession = await callAugment(`/api/sessions/${sessionId}`);
  const session = {
    ...(options.session || {}),
    ...(latestSession || {})
  };
  if (isWikipediaFileSource(session)) {
    const sourceAnchor = await createAugmentSourceAnchor(currentWorkspaceDir, session, options.sourceFile);
    if (!sourceAnchor) {
      throw new Error("Wikipedia file intake could not create the source node.");
    }
    return sanitizeForIpc({
      sessionId,
      importedNodeCount: 1,
      importedRelationshipCount: 0,
      workspace: await refreshWorkspace()
    });
  }

  const substrate = await callAugment(`/api/sessions/${sessionId}/substrate`);
  const api = workspaceApi(currentWorkspaceDir);
  const createdByRemoteId = new Map();
  const sourceAnchor = await createAugmentSourceAnchor(currentWorkspaceDir, session, options.sourceFile);
  if (sourceAnchor) {
    await ensureAugmentCompanionMediaNode(currentWorkspaceDir, sourceAnchor, session, options.sourceFile);
  }

  for (const node of substrate.nodes || []) {
    const body = sessionBodyFromNode(node);
    const created = await api.createNode({
      title: node.title,
      type: node.type || "concept",
      summary: node.summary || "",
      source_fragment: node.sourceFragment || undefined,
      captured_via: "augment",
      augment_session_id: String(sessionId)
    }, body);
    createdByRemoteId.set(node.id, {
      protocolId: created.data.protocol_id,
      relativeFile: path.relative(currentWorkspaceDir, created.filePath),
      data: created.data,
      body
    });
  }

  const relationshipsBySource = new Map();
  if (sourceAnchor?.protocolId) {
    relationshipsBySource.set("__augment_source_anchor__", []);
  }
  for (const relationship of substrate.relationships || []) {
    const sourceNode = createdByRemoteId.get(relationship.from);
    const targetNode = createdByRemoteId.get(relationship.to);
    if (!sourceNode || !targetNode) continue;
    if (!relationshipsBySource.has(relationship.from)) {
      relationshipsBySource.set(relationship.from, []);
    }
    relationshipsBySource.get(relationship.from).push({
      type: relationship.type || "related_to",
      target: targetNode.protocolId,
      summary: relationship.title || ""
    });
  }

  if (sourceAnchor?.protocolId) {
    for (const createdNode of createdByRemoteId.values()) {
      relationshipsBySource.get("__augment_source_anchor__").push({
        type: "documents",
        target: createdNode.protocolId,
        summary: "This captured source documents the connected node extracted during Augment intake."
      });
    }
  }

  for (const [remoteId, nextRelationships] of relationshipsBySource.entries()) {
    const createdNode = remoteId === "__augment_source_anchor__" ? sourceAnchor : createdByRemoteId.get(remoteId);
    if (!createdNode) continue;
    await api.updateNode(
      createdNode.relativeFile,
      {
        ...createdNode.data,
        relationships: nextRelationships
      },
      createdNode.body
    );
  }

  return sanitizeForIpc({
    sessionId,
    importedNodeCount: createdByRemoteId.size,
    importedRelationshipCount: (substrate.relationships || []).filter((relationship) => (
      createdByRemoteId.has(relationship.from) && createdByRemoteId.has(relationship.to)
    )).length,
    workspace: await refreshWorkspace()
  });
}

ipcMain.handle("dialog:openWorkspace", async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Open XanaNode Workspace",
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return ok({ canceled: true });
    currentWorkspaceDir = result.filePaths[0];
    const workspace = await openWorkspace(currentWorkspaceDir);
    return ok({ workspace: normalizeWorkspace(workspace) });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:openAtPath", async (_, payload = {}) => {
  try {
    if (!payload.rootDir) throw new Error("No workspace path was provided.");
    currentWorkspaceDir = path.resolve(payload.rootDir);
    const workspace = await openWorkspace(currentWorkspaceDir);
    return ok({ workspace: normalizeWorkspace(workspace) });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("dialog:openSubstrateFile", handleOpenSubstrateFileDialog);
ipcMain.handle("dialog:openSubstrateFolder", handleOpenSubstrateFolderDialog);
ipcMain.handle("dialog:intertwingleSubstrate", handleOpenSubstrateFileDialog);
ipcMain.handle("dialog:openPack", handleOpenSubstrateFileDialog);

ipcMain.handle("dialog:createWorkspace", async (_, defaults = {}) => {
  try {
    let targetDir = defaults.targetDir;
    if (!targetDir && defaults.useDefaultLocation) {
      targetDir = uniqueWorkspaceDir(defaults.name || "New XanaNode Substrate");
    }
    if (!targetDir) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: "Choose Folder for New XanaNode Workspace",
        properties: ["openDirectory", "createDirectory"]
      });
      if (result.canceled || !result.filePaths[0]) return ok({ canceled: true });
      targetDir = result.filePaths[0];
    }
    currentWorkspaceDir = targetDir;
    const workspace = await initWorkspacePortable(targetDir, defaults);
    return ok({ workspace: normalizeWorkspace(workspace) });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:refresh", async () => {
  try {
    const workspace = await refreshWorkspace();
    return ok({ workspace });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:status", async () => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const status = await computeWorkspaceStatus(currentWorkspaceDir);
    return ok({
      workspace: normalizeWorkspace(status.workspace),
      health: sanitizeForIpc(status.health),
      validation: sanitizeForIpc(status.validation),
      intake_reviews: sanitizeForIpc(status.intake_reviews || [])
    });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:createNode", async (_, payload) => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await createNode(currentWorkspaceDir, payload.node, payload.body || "", payload.options || {});
    await refreshRunningHugoPreview("Node created");
    return ok({ result, workspace: await refreshWorkspace() });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:updateNode", async (_, payload) => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await updateNode(currentWorkspaceDir, payload.relativeFile, payload.nodeData, payload.body, payload.options || {});
    await refreshRunningHugoPreview("Node updated");
    return ok({ result, workspace: await refreshWorkspace() });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:createRelationshipNode", async (_, payload) => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await createRelationshipNode(currentWorkspaceDir, payload.relationship, payload.options || {});
    await refreshRunningHugoPreview("Relationship node created");
    return ok({ result, workspace: await refreshWorkspace() });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:collapseRelationshipNode", async (_, payload) => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await collapseRelationshipNode(currentWorkspaceDir, payload.nodeRef, payload.options || {});
    await refreshRunningHugoPreview("Relationship node collapsed");
    return ok({ result, workspace: result.workspace || await refreshWorkspace() });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:planNodeDeletion", async (_, payload) => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const plan = await planNodeDeletion(currentWorkspaceDir, payload.nodeRef, payload.options || {});
    return ok({ plan });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:deleteNode", async (_, payload) => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await deleteNode(currentWorkspaceDir, payload.nodeRef, payload.options || {});
    await refreshRunningHugoPreview("Node deleted");
    return ok({ result, workspace: normalizeWorkspace(result.workspace) });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:importAssets", async () => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Import Media or Source Files",
      properties: ["openFile", "multiSelections"]
    });
    if (result.canceled || !result.filePaths.length) return ok({ canceled: true });
    const sessions = [];
    const imported = [];
    const analysisContext = await createIntakeAnalysisContext(currentWorkspaceDir);
    for (const sourceFile of result.filePaths) {
      const augmentInput = classifyAugmentFile(sourceFile);
      if (augmentInput) {
        sendToRenderer("augment:log", `Augment intake: ${path.basename(sourceFile)}`);
        const session = await callAugment("/api/sessions", {
          method: "POST",
          body: augmentInput
        });
        await callAugment(`/api/sessions/${session.id}/extract`, { method: "POST" });
        const candidates = await callAugment(`/api/sessions/${session.id}/candidates`);
        sessions.push(sanitizeForIpc({
          sourceFile,
          session,
          candidates
        }));
        continue;
      }
      imported.push(await importAssetAsNode(currentWorkspaceDir, sourceFile, { analysisContext }));
    }
    return ok({
      imported,
      sessions,
      workspace: imported.length ? await refreshWorkspace() : undefined,
      augment: sessions.length ? augmentStatusPayload({ ready: true }) : undefined
    });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:saveSnapshot", async (_, payload = {}) => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const api = workspaceApi(currentWorkspaceDir);
    const result = api.git.saveSnapshot({ message: payload.message || "Save XanaNode workspace snapshot" });
    await refreshRunningHugoPreview("Snapshot saved");
    return ok({ result, workspace: await refreshWorkspace() });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:build", async (_, payload = {}) => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await buildWorkspacePortable(currentWorkspaceDir, {
      core: {
        suggestionMode: payload.suggestionMode || "review"
      }
    });
    await refreshRunningHugoPreview("Workspace built");
    return ok({ result });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:exportSubstrate", async () => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await exportWorkspacePortable(currentWorkspaceDir);
    return ok({ result });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:exportPack", async () => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await exportWorkspacePortable(currentWorkspaceDir);
    return ok({ result });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:validate", async () => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const validation = await validateWorkspacePortable(currentWorkspaceDir);
    return ok({ validation });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:removeImport", async (_, payload = {}) => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const api = workspaceApi(currentWorkspaceDir);
    const result = api.removeImport(payload.importId);
    const status = await computeWorkspaceStatus(currentWorkspaceDir);
    return ok({
      result: sanitizeForIpc(result),
      workspace: normalizeWorkspace(status.workspace),
      health: sanitizeForIpc(status.health),
      validation: sanitizeForIpc(status.validation),
      intake_reviews: sanitizeForIpc(status.intake_reviews || [])
    });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:toggleImportNodeVisibility", async (_, payload = {}) => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const api = workspaceApi(currentWorkspaceDir);
    const result = api.toggleImportNodeVisibility(payload.importId, payload.nodeId, payload.enabled !== false);
    const status = await computeWorkspaceStatus(currentWorkspaceDir);
    return ok({
      result: sanitizeForIpc(result),
      workspace: normalizeWorkspace(status.workspace),
      health: sanitizeForIpc(status.health),
      validation: sanitizeForIpc(status.validation),
      intake_reviews: sanitizeForIpc(status.intake_reviews || [])
    });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:listFederationTargets", async () => {
  try {
    return ok({ federation_targets: listFederationTargets() });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:openFederationTarget", async (_, payload = {}) => {
  try {
    const targetId = String(payload.targetId || "").trim();
    if (!targetId) throw new Error("No federation target selected.");
    const target = listFederationTargets().find((candidate) => candidate.id === targetId || candidate.namespace === targetId);
    if (!target) throw new Error(`Unknown federation target: ${targetId}`);

    const cloneRoot = path.join(app.getPath("documents"), "XanaNode Studio Workspaces", ".federation-cache");
    fs.mkdirSync(cloneRoot, { recursive: true });
    const cloneDir = uniqueSubdir(cloneRoot, target.id || target.namespace || "substrate");
    const cloned = cloneFederationTarget(target, cloneDir, { branch: payload.branch });
    const substrateSource = target.repository?.substrate_path
      ? path.join(cloned.path, target.repository.substrate_path)
      : cloned.path;
    const opened = currentWorkspaceDir
      ? await intertwingleIntoCurrentWorkspace(substrateSource, { name: cloned.name, version: `${cloned.branch}@${cloned.commit}` })
      : await openSubstrateAsWorkspace(substrateSource, { name: cloned.name });
    return {
      ...opened,
      cloned
    };
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:openInShell", async (_, targetPath) => {
  try {
    const resolved = targetPath || currentWorkspaceDir;
    if (!resolved) throw new Error("No path available.");
    await shell.openPath(resolved);
    return ok();
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("app:metadata", async () => ok({ metadata: appMetadata }));

ipcMain.handle("augment:status", async () => {
  try {
    const ready = augmentService.url ? await waitForAugmentHealth(augmentService.url, 500) : false;
    return ok({ augment: augmentStatusPayload({ ready }) });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("augment:start", async (_, payload = {}) => {
  try {
    const augment = await startAugmentService({ port: payload.port });
    return ok({ augment });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("augment:stop", async () => {
  try {
    stopAugmentService();
    return ok({ augment: augmentStatusPayload({ ready: false }) });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("augment:createSession", async (_, payload = {}) => {
  try {
    const session = await callAugment("/api/sessions", {
      method: "POST",
      body: {
        title: payload.title,
        sourceType: payload.sourceType,
        sourceText: payload.sourceText ?? null,
        sourceUrl: payload.sourceUrl ?? null
      }
    });
    return ok({ session: sanitizeForIpc(session), augment: augmentStatusPayload({ ready: true }) });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("augment:extractSession", async (_, payload = {}) => {
  try {
    const result = await callAugment(`/api/sessions/${payload.sessionId}/extract`, { method: "POST" });
    return ok({ result: sanitizeForIpc(result), augment: augmentStatusPayload({ ready: true }) });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("augment:listCandidates", async (_, payload = {}) => {
  try {
    const candidates = await callAugment(`/api/sessions/${payload.sessionId}/candidates`);
    return ok({ candidates: sanitizeForIpc(candidates), augment: augmentStatusPayload({ ready: true }) });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("augment:bulkReview", async (_, payload = {}) => {
  try {
    const result = await callAugment(`/api/sessions/${payload.sessionId}/bulk-review`, {
      method: "POST",
      body: {
        status: payload.status,
        kindFilter: payload.kindFilter ?? null
      }
    });
    return ok({ result: sanitizeForIpc(result), augment: augmentStatusPayload({ ready: true }) });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("augment:updateCandidate", async (_, payload = {}) => {
  try {
    const result = await callAugment(`/api/candidates/${payload.candidateId}`, {
      method: "PATCH",
      body: payload
    });
    return ok({ result: sanitizeForIpc(result), augment: augmentStatusPayload({ ready: true }) });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("augment:suggestRelationships", async (_, payload = {}) => {
  try {
    const result = await callAugment(`/api/sessions/${payload.sessionId}/suggest-relationships`, { method: "POST" });
    return ok({ result: sanitizeForIpc(result), augment: augmentStatusPayload({ ready: true }) });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("augment:getSubstrate", async (_, payload = {}) => {
  try {
    const substrate = await callAugment(`/api/sessions/${payload.sessionId}/substrate`);
    return ok({ substrate: sanitizeForIpc(substrate), augment: augmentStatusPayload({ ready: true }) });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:applyAugmentSession", async (_, payload = {}) => {
  try {
    const result = await applyAugmentSessionToWorkspace(payload.sessionId, payload);
    return ok(result);
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("preview:startHugo", async () => startHugoPreview());

ipcMain.handle("preview:rebuildHugo", async () => startHugoPreview({ rebuild: true }));

async function startHugoPreview({ rebuild = false } = {}) {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const ws = await openWorkspace(currentWorkspaceDir);
    if (ws.settings?.preview?.enabled === false || ws.settings?.preview?.renderer === "none") {
      throw new Error("This substrate was created without a Hugo projection. Use Graph Projection, or create a workspace with Hugo enabled.");
    }
    const preview = resolvePreviewInvocation(currentWorkspaceDir, ws.settings?.preview);
    sendToRenderer("preview:log", `${rebuild ? "Rebuilding" : "Building"} preview artifacts...\n`);
    stopHugoPreview();
    await preparePreviewArtifacts(preview.cwd);
    currentHugoPreviewRoot = preview.cwd;
    const invocation = await resolveHugoServerInvocation(preview);
    const previewProcess = spawn(invocation.cmd, invocation.args, { cwd: preview.cwd, shell: false });
    hugoProcess = previewProcess;
    if (invocation.url) {
      shell.openExternal(invocation.url).catch(() => {});
    }
    previewProcess.stdout.on("data", (data) => sendToRenderer("preview:log", data.toString()));
    previewProcess.stderr.on("data", (data) => sendToRenderer("preview:log", data.toString()));
    previewProcess.on("exit", (code) => {
      if (hugoProcess !== previewProcess) return;
      sendToRenderer("preview:stopped", { code });
      hugoProcess = null;
    });
    return ok({ url: invocation.url });
  } catch (error) {
    return fail(error);
  }
}

ipcMain.handle("preview:stopHugo", async () => {
  stopHugoPreview();
  return ok();
});

function stopHugoPreview() {
  if (!hugoProcess) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(hugoProcess.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    hugoProcess.kill("SIGTERM");
  }
  hugoProcess = null;
  currentHugoPreviewRoot = null;
}

async function refreshRunningHugoPreview(reason = "Workspace changed") {
  if (!hugoProcess || !currentHugoPreviewRoot) return false;
  sendToRenderer("preview:log", `${reason}; syncing running Hugo preview...\n`);
  if (currentWorkspaceDir && path.resolve(currentWorkspaceDir) !== path.resolve(currentHugoPreviewRoot)) {
    syncWorkspaceProjectionFiles(currentWorkspaceDir, currentHugoPreviewRoot);
  }
  await preparePreviewArtifacts(currentHugoPreviewRoot);
  return true;
}

async function runPreviewPreparation(siteRoot) {
  const candidateScripts = [
    path.join(siteRoot, "themes", "xananode-hugo", "tools", "prepare-xananode.mjs"),
    path.join(siteRoot, "tools", "prepare-xananode.mjs"),
    path.join(resolveBundledHugoRoot(), "tools", "prepare-xananode.mjs")
  ];
  const scriptPath = candidateScripts.find((candidate) => fs.existsSync(candidate));
  if (!scriptPath) return;

  await new Promise((resolve, reject) => {
    const child = spawn("node", [scriptPath, siteRoot], {
      cwd: siteRoot,
      shell: false
    });
    child.stdout.on("data", (data) => sendToRenderer("preview:log", data.toString()));
    child.stderr.on("data", (data) => sendToRenderer("preview:log", data.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Preview preparation failed with exit code ${code}`));
    });
  });
}

async function resolveHugoServerInvocation(preview) {
  const [cmd, ...args] = preview.cmd
    ? [preview.cmd, ...(preview.args || [])]
    : preview.command.split(/\s+/).filter(Boolean);
  if (!cmd) throw new Error("No Hugo preview command configured.");

  const isHugoServer = path.basename(cmd).toLowerCase().startsWith("hugo") && args[0] === "server";
  if (!isHugoServer) {
    return { cmd, args, url: preview.url };
  }

  const hasPort = args.some((arg) => arg === "--port" || arg === "-p" || arg.startsWith("--port="));
  const hasBind = args.some((arg) => arg === "--bind" || arg.startsWith("--bind="));
  const hasBaseUrl = args.some((arg) => arg === "--baseURL" || arg.startsWith("--baseURL="));
  const port = hasPort ? portFromPreviewUrl(preview.url) : await getAvailablePort(1313);
  const url = `http://127.0.0.1:${port}/`;
  const nextArgs = [...args];

  if (!hasBind) nextArgs.push("--bind", "127.0.0.1");
  if (!hasPort) nextArgs.push("--port", String(port));
  if (!hasBaseUrl) nextArgs.push("--baseURL", url);

  return { cmd, args: nextArgs, url };
}

function portFromPreviewUrl(url) {
  try {
    return Number(new URL(url).port) || 1313;
  } catch {
    return 1313;
  }
}

async function getAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 200; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`Could not find an available Hugo preview port near ${startPort}.`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function preparePreviewArtifacts(siteRoot) {
  syncPreviewThemeBridge(siteRoot);

  try {
    await runPreviewPreparation(siteRoot);
    return;
  } catch (error) {
    sendToRenderer("preview:log", `Hugo prepare script failed, falling back to Core build: ${error.message}\n`);
  }

  const outputDir = path.join(siteRoot, "static");
  const result = await buildWorkspace(siteRoot, { out: outputDir });
  const viewerFeed = writeHugoIndexJson(outputDir, result.substrate);
  writePreviewViewerJson(outputDir, viewerFeed);
  syncPreviewFallbackStaticAssets(outputDir);
}

function syncPreviewThemeBridge(siteRoot) {
  const hugoRoot = resolveBundledHugoRoot();
  const themeRoot = path.join(siteRoot, "themes", "xananode-hugo");
  const bridgeFiles = [
    ["static", "js", "xananode.js"],
    ["layouts", "index.html"],
    ["layouts", "_default", "single.html"]
  ];

  let copied = 0;
  for (const parts of bridgeFiles) {
    const source = path.join(hugoRoot, ...parts);
    const target = path.join(themeRoot, ...parts);
    if (!fs.existsSync(source) || !fs.existsSync(target)) continue;
    fs.copyFileSync(source, target);
    copied += 1;
  }

  if (copied) {
    sendToRenderer("preview:log", `Synced XanaNode Hugo preview bridge files (${copied}).\n`);
  }
}

function resolveBundledHugoRoot() {
  const bundledHugoRoot = path.join(app.getAppPath(), "vendor", "xananode-hugo");
  const localHugoRoot = path.join(app.getPath("documents"), "XanaNode-Hugo");
  const workspaceHugoRoot = path.join(appRoot, "vendor", "xananode-hugo");
  return [bundledHugoRoot, workspaceHugoRoot, localHugoRoot].find((candidate) => fs.existsSync(candidate)) || bundledHugoRoot;
}

function writeHugoIndexJson(outputDir, substrate) {
  const protocolNodes = substrate.protocolNodes || [];
  // Build a map from every possible ID form (protocol ID, local_id, derived local slug) to the local id
  const protocolToLocal = new Map();
  for (const node of protocolNodes) {
    const localId = node.local_id || localIdFromProtocolId(node.id);
    protocolToLocal.set(node.id, localId);                     // full protocol id: "ns:type/slug"
    if (node.local_id) protocolToLocal.set(node.local_id, localId);  // explicit local_id
    protocolToLocal.set(localId, localId);                     // local id maps to itself
  }
  const nodes = protocolNodes
    .filter((node) => node.type !== "fragment")
    .map((node) => {
      const id = node.local_id || localIdFromProtocolId(node.id);
      return {
        id,
        title: node.title || id,
        type: node.type || "node",
        section: `${node.type || "node"}s`,
        importance: node.importance || 3,
        url: `/node/${encodeURIComponent(id)}`,
        summary: node.summary || "",
        html: markdownToPreviewHtml(node.body || ""),
        content: stripMarkdown(node.body || "").slice(0, 1200),
        image: node.image || "",
        image_alt: node.image_alt || node.title || id,
        primary_media: node.primary_media ? (protocolToLocal.get(node.primary_media) || localIdFromProtocolId(node.primary_media) || node.primary_media) : "",
        media_type: node.media_type || "",
        file: node.file || node.asset_path || node.asset || "",
        asset: node.asset || node.asset_path || "",
        asset_path: node.asset_path || "",
        alt: node.alt || "",
        caption: node.caption || "",
        creator: node.creator || "",
        created_date: node.created_at || "",
        source_name: node.source_name || "",
        source_url: node.source_url || "",
        youtube_url: node.youtube_url || "",
        license: node.license || "",
        license_url: node.license_url || "",
        rights_status: node.rights_status || "",
        author: node.created_by || "",
        year: node.year || ""
      };
    });

  const nodeIds = new Set(nodes.map((node) => node.id));

  // Build trail sequence map for synthesis: local trail ID → ordered member local IDs
  const trailSequenceMapFallback = new Map();
  for (const node of protocolNodes) {
    if (node.type !== "trail") continue;
    const trailLocalId = protocolToLocal.get(node.id) || node.local_id || localIdFromProtocolId(node.id);
    const memberProtocolIds = [].concat(node.nodes || node.trail_nodes || []).filter(Boolean);
    const memberLocalIds = memberProtocolIds
      .map((m) => protocolToLocal.get(String(m)) || localIdFromProtocolId(String(m)))
      .filter((id) => id && nodeIds.has(id));
    if (memberLocalIds.length) trailSequenceMapFallback.set(trailLocalId, memberLocalIds);
  }

  const rawEdges = (substrate.relationships || [])
    .map((relationship) => ({
      source: protocolToLocal.get(relationship.source) || relationship.source,
      target: protocolToLocal.get(relationship.target) || relationship.target,
      type: relationship.type || "related_to",
      weight: relationship.weight || 3,
      visibility: relationship.visibility || "secondary",
      origin: "core"
    }))
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

  // Prune trail→member continues_to edges; synthesize sequential node-to-node edges
  const prunedEdges = rawEdges.filter((edge) => {
    if (edge.type !== "continues_to") return true;
    const memberIds = trailSequenceMapFallback.get(edge.source);
    if (!memberIds) return true;
    return !memberIds.includes(edge.target);
  });
  const seenEdgeKeys = new Set(prunedEdges.map((e) => `${e.source}::${e.type}::${e.target}`));
  const syntheticEdges = [];
  for (const [, memberIds] of trailSequenceMapFallback) {
    for (let i = 1; i < memberIds.length; i++) {
      const source = memberIds[i - 1];
      const target = memberIds[i];
      const key = `${source}::continues_to::${target}`;
      if (seenEdgeKeys.has(key)) continue;
      seenEdgeKeys.add(key);
      syntheticEdges.push({ source, target, type: "continues_to", weight: 6, visibility: "primary", origin: "trail" });
    }
  }
  const edges = [...prunedEdges, ...syntheticEdges];

  // Post-process: fill primary_media for nodes that declare it via has_primary_media relationship
  const primaryMediaFallbackMap = new Map();
  for (const edge of rawEdges) {
    if (edge.type === "has_primary_media") primaryMediaFallbackMap.set(edge.source, edge.target);
  }
  for (const node of nodes) {
    if (!node.primary_media && primaryMediaFallbackMap.has(node.id)) {
      node.primary_media = primaryMediaFallbackMap.get(node.id);
    }
  }

  const viewerData = {
    namespace: substrate.namespace || substrate.manifest?.namespace || "",
    nodes,
    edges
  };

  fs.writeFileSync(path.join(outputDir, "index.json"), JSON.stringify(viewerData, null, 2));
  return viewerData;
}

function writePreviewViewerJson(outputDir, viewerData) {
  fs.writeFileSync(path.join(outputDir, "xananode-viewer.json"), JSON.stringify(viewerData, null, 2));
}

function syncPreviewFallbackStaticAssets(outputDir) {
  const themeRoot = resolveBundledHugoRoot();
  const themeStaticRoots = [
    path.join(themeRoot, "exampleSite", "static"),
    path.join(themeRoot, "static")
  ];
  const sourceStatic = themeStaticRoots.find((candidate) => fs.existsSync(path.join(candidate, "assets", "projection", "node-types"))) || themeStaticRoots.find((candidate) => fs.existsSync(candidate));
  if (!sourceStatic) return;

  const assetSource = path.join(sourceStatic, "assets");
  const assetTarget = path.join(outputDir, "assets");
  if (fs.existsSync(assetSource)) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.cpSync(assetSource, assetTarget, { recursive: true, force: true });
  }

  const schemasSource = path.join(sourceStatic, "schemas");
  const schemasTarget = path.join(outputDir, "schemas");
  if (fs.existsSync(schemasSource)) {
    fs.cpSync(schemasSource, schemasTarget, { recursive: true, force: true });
  }

  const wellKnownSource = path.join(sourceStatic, ".well-known");
  const wellKnownTarget = path.join(outputDir, ".well-known");
  if (fs.existsSync(wellKnownSource)) {
    fs.cpSync(wellKnownSource, wellKnownTarget, { recursive: true, force: true });
  }

  const iconSource = path.join(sourceStatic, "xananode-icon.svg");
  const iconTarget = path.join(outputDir, "xananode-icon.svg");
  if (fs.existsSync(iconSource) && !fs.existsSync(iconTarget)) {
    fs.copyFileSync(iconSource, iconTarget);
  }
}

function localIdFromProtocolId(value) {
  return String(value || "").split("/").pop() || String(value || "");
}

function stripMarkdown(markdown) {
  return String(markdown || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownToPreviewHtml(markdown) {
  const escaped = escapeHtml(String(markdown || ""));
  return escaped
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .split(/\n{2,}/)
    .map((block) => block.startsWith("<h") ? block : `<p>${block.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function resolvePreviewInvocation(workspaceDir, previewSettings = {}) {
  const configuredRoot = previewSettings.repository_root || previewSettings.root_dir || previewSettings.renderer_root;
  const cwd = configuredRoot ? path.resolve(workspaceDir, configuredRoot) : workspaceDir;
  const hasRootConfig = fs.existsSync(path.join(cwd, "hugo.yaml")) || fs.existsSync(path.join(cwd, "hugo.toml"));
  const hasExampleSite = fs.existsSync(path.join(cwd, "exampleSite", "hugo.yaml"));
  const defaultCommand = "hugo server --disableFastRender";
  const configuredCommand = previewSettings.command && previewSettings.command !== defaultCommand ? previewSettings.command : null;

  if (configuredCommand) {
    return {
      cwd,
      command: configuredCommand,
      url: previewSettings.url || "http://localhost:1313"
    };
  }

  if (!hasRootConfig && hasExampleSite) {
    return {
      cwd,
      command: "hugo server --source exampleSite --themesDir ../..",
      url: previewSettings.url || "http://localhost:1313"
    };
  }

  if (!hasRootConfig) {
    const projectionRoot = createWorkspaceHugoProjection(workspaceDir);
    return {
      cwd: projectionRoot,
      cmd: "hugo",
      args: ["server", "--disableFastRender", "--themesDir", path.join(projectionRoot, "themes")],
      url: previewSettings.url || "http://localhost:1313"
    };
  }

  return {
    cwd,
    command: defaultCommand,
    url: previewSettings.url || "http://localhost:1313"
  };
}

function createWorkspaceHugoProjection(workspaceDir) {
  let projectionRoot = previewProjectionRoot(workspaceDir);
  projectionRoot = resetPreviewProjectionRoot(projectionRoot);
  fs.mkdirSync(projectionRoot, { recursive: true });
  fs.mkdirSync(path.join(projectionRoot, "content"), { recursive: true });
  fs.mkdirSync(path.join(projectionRoot, "static"), { recursive: true });
  fs.mkdirSync(path.join(projectionRoot, "data"), { recursive: true });
  const localThemeRoot = path.join(projectionRoot, "themes", "xananode-hugo");
  fs.mkdirSync(path.dirname(localThemeRoot), { recursive: true });

  syncWorkspaceProjectionFiles(workspaceDir, projectionRoot);

  const manifest = readPackManifest(workspaceDir);
  const importReferences = readWorkspaceImportReferences(workspaceDir, projectionRoot);
  const themeRoot = resolveBundledHugoRoot();
  for (const folder of ["assets", "layouts", "static", "tools", "vendor"]) {
    const source = path.join(themeRoot, folder);
    const target = path.join(localThemeRoot, folder);
    if (fs.existsSync(source)) fs.cpSync(source, target, { recursive: true, force: true });
  }
  for (const file of ["hugo.yaml", "package.json"]) {
    const source = path.join(themeRoot, file);
    const target = path.join(localThemeRoot, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, target);
  }
  const iconSource = path.join(themeRoot, "static", "xananode-icon.svg");
  if (fs.existsSync(iconSource)) fs.copyFileSync(iconSource, path.join(projectionRoot, "static", "xananode-icon.svg"));

  fs.writeFileSync(path.join(projectionRoot, "hugo.yaml"), [
    'baseURL: "http://localhost:1313/"',
    'languageCode: "en-us"',
    `title: ${JSON.stringify(manifest.name || "XanaNode Studio Preview")}`,
    'theme: "xananode-hugo"',
    "",
    "params:",
    `  description: ${JSON.stringify(manifest.description || "Studio-generated Hugo projection for a XanaNode substrate.")}`,
    '  author: "XanaNode Studio"',
    '  tagline: "Relationships preserve knowledge"',
    '  themeColor: "#55d6be"',
    '  image: "xananode-icon.svg"',
    "  xananode:",
    `    namespace: ${JSON.stringify(manifest.namespace || manifest.id || "studio.preview")}`,
    ...(importReferences.length ? [
      "    packs:",
      ...importReferences.flatMap((pack) => [
        `      - id: ${JSON.stringify(pack.id)}`,
        `        source: ${JSON.stringify(pack.source)}`,
        `        mode: ${JSON.stringify(pack.mode || "mounted")}`,
        ...(pack.version ? [`        version: ${JSON.stringify(pack.version)}`] : [])
      ])
    ] : []),
    "    brand:",
    '      name: "XanaNode"',
    '      tagline: "Relationships preserve knowledge"',
    '      icon: "xananode-icon.svg"',
    "",
    "markup:",
    "  goldmark:",
    "    renderer:",
    "      unsafe: true",
    "",
    "outputs:",
    "  home:",
    "    - HTML",
    "    - JSON",
    ""
  ].join("\n"));

  sendToRenderer("preview:log", `Prepared preview workspace at ${projectionRoot}\n`);
  return projectionRoot;
}

function syncWorkspaceProjectionFiles(workspaceDir, projectionRoot) {
  const workspaceContent = path.join(workspaceDir, "content");
  const targetContent = path.join(projectionRoot, "content");
  fs.rmSync(targetContent, { recursive: true, force: true });
  if (fs.existsSync(workspaceContent)) {
    fs.cpSync(workspaceContent, targetContent, { recursive: true, force: true });
    dedupeProjectionMarkdownNodes(targetContent);
  }
  const workspaceAssets = path.join(workspaceDir, "assets");
  const targetAssets = path.join(projectionRoot, "assets");
  fs.rmSync(targetAssets, { recursive: true, force: true });
  if (fs.existsSync(workspaceAssets)) {
    fs.cpSync(workspaceAssets, targetAssets, { recursive: true, force: true });
  }
  const workspaceAttachedAssets = path.join(workspaceDir, "attached_assets");
  const targetAttachedAssets = path.join(projectionRoot, "static", "attached_assets");
  fs.rmSync(targetAttachedAssets, { recursive: true, force: true });
  if (fs.existsSync(workspaceAttachedAssets)) {
    fs.cpSync(workspaceAttachedAssets, targetAttachedAssets, { recursive: true, force: true });
  }
}

function dedupeProjectionMarkdownNodes(contentRoot) {
  if (!fs.existsSync(contentRoot)) return;
  const markdownFiles = collectMarkdownFiles(contentRoot);
  const grouped = new Map();
  for (const fullPath of markdownFiles) {
    try {
      const raw = fs.readFileSync(fullPath, "utf8");
      const parsed = parseFrontMatter(raw, fullPath);
      const protocolId = parsed?.data?.protocol_id || parsed?.data?.protocolId || "";
      if (!protocolId) continue;
      const stat = fs.statSync(fullPath);
      const current = grouped.get(protocolId);
      if (!current || stat.mtimeMs > current.mtimeMs) {
        grouped.set(protocolId, { fullPath, mtimeMs: stat.mtimeMs, raw });
      }
    } catch {
      // Leave unreadable files in place; build validation can report them later.
    }
  }

  const keepPaths = new Set(Array.from(grouped.values()).map((entry) => path.resolve(entry.fullPath)));
  for (const fullPath of markdownFiles) {
    try {
      const raw = fs.readFileSync(fullPath, "utf8");
      const parsed = parseFrontMatter(raw, fullPath);
      const protocolId = parsed?.data?.protocol_id || parsed?.data?.protocolId || "";
      if (!protocolId) continue;
      if (!keepPaths.has(path.resolve(fullPath)) && fs.existsSync(fullPath)) {
        fs.rmSync(fullPath, { force: true });
      } else if (parsed?.data?.protocolId || parsed?.data?.relativeFile || parsed?.data?.relativePath || parsed?.data?.source_file) {
        const nextData = { ...(parsed.data || {}) };
        delete nextData.protocolId;
        delete nextData.relativeFile;
        delete nextData.relativePath;
        delete nextData.source_file;
        writeCleanFrontMatter(fullPath, nextData, parsed.body || "");
      }
    } catch {
      // Ignore unreadable files here and let the normal build path surface them.
    }
  }
}

function collectMarkdownFiles(rootDir) {
  const files = [];
  walkProjectionDir(rootDir, files);
  return files;
}

function walkProjectionDir(currentDir, files) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkProjectionDir(fullPath, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }
}

function writeCleanFrontMatter(filePath, data, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyFrontMatter(data, body));
}

function previewProjectionRoot(workspaceDir) {
  const baseName = path.basename(path.resolve(workspaceDir)).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "workspace";
  const digest = createHash("sha1").update(path.resolve(workspaceDir)).digest("hex").slice(0, 10);
  return path.join(app.getPath("temp"), "xananode-studio", `${baseName}-${digest}`, "preview-hugo");
}

function readWorkspaceImportReferences(workspaceDir, projectionRoot) {
  const importsFile = path.join(workspaceDir, ".xananode", "imports.json");
  if (!fs.existsSync(importsFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(importsFile, "utf8"));
    const entries = Array.isArray(parsed?.imports) ? parsed.imports : [];
    return entries
      .map((entry) => {
        const candidate = entry.path || entry.source || "";
        if (!candidate || /^[a-z]+:\/\//i.test(candidate)) return null;
        const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(workspaceDir, candidate);
        if (!fs.existsSync(absolute) || fs.statSync(absolute).isFile()) return null;
        return {
          id: entry.id || path.basename(absolute),
          source: path.relative(projectionRoot, absolute).replace(/\\/g, "/"),
          mode: entry.mode || "mounted",
          version: entry.version || ""
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resetPreviewProjectionRoot(projectionRoot) {
  if (!fs.existsSync(projectionRoot)) return projectionRoot;
  try {
    fs.rmSync(projectionRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    return projectionRoot;
  } catch (error) {
    const abandonedRoot = `${projectionRoot}.old-${Date.now()}`;
    try {
      fs.renameSync(projectionRoot, abandonedRoot);
      sendToRenderer("preview:log", `Windows kept the previous Hugo preview open, so Studio moved it aside at ${abandonedRoot}\n`);
      return projectionRoot;
    } catch (renameError) {
      const freshRoot = `${projectionRoot}-${Date.now()}`;
      sendToRenderer(
        "preview:log",
        `Windows kept the previous Hugo preview locked, so Studio is using a fresh preview folder at ${freshRoot}\n`
      );
      return freshRoot;
    }
  }
}

function uniqueWorkspaceDir(name) {
  const baseDir = path.join(app.getPath("documents"), "XanaNode Studio Workspaces");
  const slug = slugFolderName(name || "xananode-substrate");
  fs.mkdirSync(baseDir, { recursive: true });
  return uniqueSubdir(baseDir, slug);
}

function uniqueSubdir(baseDir, name) {
  const slug = slugFolderName(name || "xananode-substrate");
  fs.mkdirSync(baseDir, { recursive: true });
  let candidate = path.join(baseDir, slug);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(baseDir, `${slug}-${index}`);
    index += 1;
  }
  return candidate;
}

function readPackManifest(packRoot) {
  const candidates = [
    path.join(packRoot, "substrate.json"),
    path.join(packRoot, "pack.json")
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

function slugFolderName(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "xananode-substrate";
}

ipcMain.handle("file:readText", async (_, absolutePath) => {
  try {
    if (!absolutePath) throw new Error("No file path provided.");
    if (!fs.existsSync(absolutePath)) throw new Error(`File does not exist: ${absolutePath}`);
    return ok({ text: fs.readFileSync(absolutePath, "utf8") });
  } catch (error) {
    return fail(error);
  }
});
