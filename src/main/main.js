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
  createIntakeAnalysisContext,
  importAssetAsNode,
  inspectSubstratePackage,
  openPackAsWorkspace,
  updateNode,
  planNodeDeletion,
  deleteNode,
  workspaceApi
} from "@xananode/workspace";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "../..");
const protocolIconPath = path.join(appRoot, "vendor", "xananode-core", "vendor", "xananode-protocol", "media", "images", "xananode-icon.svg");
const appMetadata = readAppMetadata();

let mainWindow = null;
let currentWorkspaceDir = null;
let hugoProcess = null;

app.setName("XanaNode Studio");
if (process.platform === "win32") app.setAppUserModelId("com.xananode.studio");

function rendererUrl() {
  if (process.env.VITE_DEV_SERVER_URL) return process.env.VITE_DEV_SERVER_URL;
  return `file://${path.join(__dirname, "../../dist/renderer/index.html")}`;
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
        { label: "Hugo Projection", accelerator: "CmdOrCtrl+2", click: () => sendStudioCommand("projection:hugo") },
        { label: "Both Projections", accelerator: "CmdOrCtrl+3", click: () => sendStudioCommand("projection:both") },
        { type: "separator" },
        { label: "Run Health Check", accelerator: "CmdOrCtrl+Shift+H", click: () => sendStudioCommand("workspace:health") },
        { label: "Build Artifacts", accelerator: "CmdOrCtrl+B", click: () => sendStudioCommand("workspace:build") },
        { label: "Export .substrate", accelerator: "CmdOrCtrl+E", click: () => sendStudioCommand("substrate:export") },
        { label: "Start Hugo Projection", accelerator: "CmdOrCtrl+Shift+P", click: () => sendStudioCommand("preview:start") },
        { label: "Fit Graph", accelerator: "CmdOrCtrl+0", click: () => sendStudioCommand("graph:fit") },
        { label: "Zoom Graph In", accelerator: "CmdOrCtrl+Plus", click: () => sendStudioCommand("graph:zoom-in") },
        { label: "Zoom Graph Out", accelerator: "CmdOrCtrl+-", click: () => sendStudioCommand("graph:zoom-out") },
        { label: "Reset Graph View", accelerator: "CmdOrCtrl+Shift+0", click: () => sendStudioCommand("graph:reset") },
        { type: "separator" },
        { label: "Rebuild Hugo Projection", accelerator: "CmdOrCtrl+R", click: () => sendStudioCommand("preview:rebuild") },
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

async function openSubstrateAsWorkspace(substrateSource, options = {}) {
  const substrateRoot = fs.existsSync(substrateSource) && fs.statSync(substrateSource).isFile()
    ? path.dirname(substrateSource)
    : substrateSource;
  const inspected = inspectSubstratePackage(substrateSource);
  const substrateManifest = inspected.manifest || readPackManifest(substrateRoot);
  const targetDir = uniqueWorkspaceDir(`${options.name || substrateManifest.name || substrateManifest.id || path.basename(substrateRoot)} Working Copy`);
  currentWorkspaceDir = targetDir;
  const workspace = await openPackAsWorkspace(substrateSource, targetDir, {
    name: `${options.name || substrateManifest.name || "XanaNode Substrate"} Working Copy`,
    git: true
  });
  return ok({ workspace: normalizeWorkspace(workspace) });
}

async function intertwingleIntoCurrentWorkspace(substrateSource, options = {}) {
  if (!currentWorkspaceDir) {
    return openSubstrateAsWorkspace(substrateSource, options);
  }
  const result = await mountSubstrateImport(currentWorkspaceDir, substrateSource, options);
  const status = await computeWorkspaceStatus(currentWorkspaceDir);
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

app.on("before-quit", () => stopHugoPreview());
app.on("window-all-closed", () => {
  stopHugoPreview();
  if (process.platform !== "darwin") app.quit();
});

function ok(data = {}) {
  return { ok: true, ...data };
}

function fail(error) {
  return { ok: false, error: error?.message || String(error) };
}

function normalizeWorkspace(ws) {
  return {
    rootDir: ws.rootDir,
    manifest: ws.manifest,
    settings: ws.settings,
    authors: ws.authors,
    imports: ws.imports,
    nodes: ws.nodes,
    git: ws.git
  };
}

async function refreshWorkspace() {
  if (!currentWorkspaceDir) return null;
  return normalizeWorkspace(await openWorkspace(currentWorkspaceDir));
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
    const workspace = await initWorkspace(targetDir, defaults);
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
      health: status.health,
      validation: status.validation,
      intake_reviews: status.intake_reviews || []
    });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:createNode", async (_, payload) => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await createNode(currentWorkspaceDir, payload.node, payload.body || "", payload.options || {});
    return ok({ result, workspace: await refreshWorkspace() });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:updateNode", async (_, payload) => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await updateNode(currentWorkspaceDir, payload.relativeFile, payload.nodeData, payload.body, payload.options || {});
    return ok({ result, workspace: await refreshWorkspace() });
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
    const imported = [];
    const analysisContext = await createIntakeAnalysisContext(currentWorkspaceDir);
    for (const sourceFile of result.filePaths) {
      imported.push(await importAssetAsNode(currentWorkspaceDir, sourceFile, { analysisContext }));
    }
    return ok({ imported, workspace: await refreshWorkspace() });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:saveSnapshot", async (_, payload = {}) => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const api = workspaceApi(currentWorkspaceDir);
    const result = api.git.saveSnapshot({ message: payload.message || "Save XanaNode workspace snapshot" });
    return ok({ result, workspace: await refreshWorkspace() });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:build", async (_, payload = {}) => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await buildWorkspace(currentWorkspaceDir, {
      core: {
        suggestionMode: payload.suggestionMode || "review"
      }
    });
    return ok({ result });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:exportSubstrate", async () => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await exportWorkspacePack(currentWorkspaceDir);
    return ok({ result });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:exportPack", async () => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await exportWorkspacePack(currentWorkspaceDir);
    return ok({ result });
  } catch (error) {
    return fail(error);
  }
});

ipcMain.handle("workspace:validate", async () => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const validation = await validateWorkspace(currentWorkspaceDir);
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
      result,
      workspace: normalizeWorkspace(status.workspace),
      health: status.health,
      validation: status.validation,
      intake_reviews: status.intake_reviews || []
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
      result,
      workspace: normalizeWorkspace(status.workspace),
      health: status.health,
      validation: status.validation,
      intake_reviews: status.intake_reviews || []
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
    sendToRenderer("preview:log", `${rebuild ? "Rebuilding" : "Starting"} Hugo projection...\n`);
    stopHugoPreview();
    await preparePreviewArtifacts(preview.cwd);
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
  writeHugoIndexJson(outputDir, result.substrate);
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
  const protocolToLocal = new Map(protocolNodes.map((node) => [node.id, node.local_id || localIdFromProtocolId(node.id)]));
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
        primary_media: node.primary_media || "",
        media_type: node.media_type || "",
        file: node.file || "",
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
  const edges = (substrate.relationships || [])
    .map((relationship) => ({
      source: protocolToLocal.get(relationship.source) || relationship.source,
      target: protocolToLocal.get(relationship.target) || relationship.target,
      type: relationship.type || "related_to",
      weight: relationship.weight || 3,
      visibility: relationship.visibility || "secondary",
      origin: "core"
    }))
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

  fs.writeFileSync(path.join(outputDir, "index.json"), JSON.stringify({ nodes, edges }, null, 2));
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

  const workspaceContent = path.join(workspaceDir, "content");
  if (fs.existsSync(workspaceContent)) {
    fs.cpSync(workspaceContent, path.join(projectionRoot, "content"), { recursive: true, force: true });
  }

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

  sendToRenderer("preview:log", `Generated Hugo projection workspace at ${projectionRoot}\n`);
  return projectionRoot;
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
