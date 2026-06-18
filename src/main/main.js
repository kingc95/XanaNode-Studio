import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import {
  initWorkspace,
  openWorkspace,
  buildWorkspace,
  validateWorkspace,
  computeKnowledgeHealth,
  createNode,
  updateNode,
  workspaceApi,
  importAssetAsNode
} from "@xananode/workspace";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let currentWorkspaceDir = null;
let hugoProcess = null;

function rendererUrl() {
  if (process.env.VITE_DEV_SERVER_URL) return process.env.VITE_DEV_SERVER_URL;
  return `file://${path.join(__dirname, "../../dist/renderer/index.html")}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: "XanaNode Studio",
    backgroundColor: "#0f1117",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });
  mainWindow.loadURL(rendererUrl());
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
    const api = workspaceApi(currentWorkspaceDir);
    const [workspace, health, validation] = await Promise.all([
      refreshWorkspace(),
      api.health(),
      api.validate().catch((error) => ({ ok: false, errors: [error.message] }))
    ]);
    return ok({ workspace, health, validation });
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

ipcMain.handle("workspace:importAssets", async () => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Import Media or Source Files",
      properties: ["openFile", "multiSelections"]
    });
    if (result.canceled || !result.filePaths.length) return ok({ canceled: true });
    const imported = [];
    for (const sourceFile of result.filePaths) {
      imported.push(await importAssetAsNode(currentWorkspaceDir, sourceFile, {}));
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

ipcMain.handle("workspace:build", async () => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const result = await buildWorkspace(currentWorkspaceDir);
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

ipcMain.handle("preview:startHugo", async () => {
  try {
    if (!currentWorkspaceDir) throw new Error("No workspace is open.");
    const ws = await openWorkspace(currentWorkspaceDir);
    const preview = resolvePreviewInvocation(currentWorkspaceDir, ws.settings?.preview);
    stopHugoPreview();
    await preparePreviewArtifacts(preview.cwd);
    const invocation = await resolveHugoServerInvocation(preview);
    hugoProcess = spawn(invocation.cmd, invocation.args, { cwd: preview.cwd, shell: false });
    hugoProcess.stdout.on("data", (data) => mainWindow?.webContents.send("preview:log", data.toString()));
    hugoProcess.stderr.on("data", (data) => mainWindow?.webContents.send("preview:log", data.toString()));
    hugoProcess.on("exit", (code) => {
      mainWindow?.webContents.send("preview:stopped", { code });
      hugoProcess = null;
    });
    return ok({ url: invocation.url });
  } catch (error) {
    return fail(error);
  }
});

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
    path.join(siteRoot, "tools", "prepare-xananode.mjs")
  ];
  const scriptPath = candidateScripts.find((candidate) => fs.existsSync(candidate));
  if (!scriptPath) return;

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, siteRoot], {
      cwd: siteRoot,
      shell: false
    });
    child.stdout.on("data", (data) => mainWindow?.webContents.send("preview:log", data.toString()));
    child.stderr.on("data", (data) => mainWindow?.webContents.send("preview:log", data.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Preview preparation failed with exit code ${code}`));
    });
  });
}

async function resolveHugoServerInvocation(preview) {
  const [cmd, ...args] = preview.command.split(/\s+/).filter(Boolean);
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
    mainWindow?.webContents.send("preview:log", `Hugo prepare script failed, falling back to Core build: ${error.message}\n`);
  }

  const outputDir = path.join(siteRoot, "static");
  const result = await buildWorkspace(siteRoot, { out: outputDir });
  writeHugoIndexJson(outputDir, result.substrate);
}

function syncPreviewThemeBridge(siteRoot) {
  const bundledHugoRoot = path.join(app.getAppPath(), "vendor", "xananode-hugo");
  const localHugoRoot = path.join(app.getPath("documents"), "XanaNode-Hugo");
  const hugoRoot = fs.existsSync(bundledHugoRoot) ? bundledHugoRoot : localHugoRoot;
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
    mainWindow?.webContents.send("preview:log", `Synced XanaNode Hugo preview bridge files (${copied}).\n`);
  }
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
    throw new Error(`No Hugo config found for this substrate: ${cwd}`);
  }

  return {
    cwd,
    command: defaultCommand,
    url: previewSettings.url || "http://localhost:1313"
  };
}

function uniqueWorkspaceDir(name) {
  const baseDir = path.join(app.getPath("documents"), "XanaNode Studio Workspaces");
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
