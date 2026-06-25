import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutDir = path.join(studioRoot, "substrate-source");
const generatedAt = new Date().toISOString();

const includeRoots = new Set(["scripts", "src", "test"]);
const includeRootFiles = new Set(["README.md", "LICENSE", "package.json", "package-lock.json", ".gitmodules", ".gitignore", "index.html", "vite.config.js"]);
const includeExtensions = new Set([".js", ".json", ".md", ".txt", ".cjs", ".mjs", ".css", ".html", ""]);

function gitValue(args) {
  const result = spawnSync("git", args, { cwd: studioRoot, encoding: "utf8", shell: false });
  return result.status === 0 ? result.stdout.trim() : "";
}

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(studioRoot, "package.json"), "utf8")).version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function cleanDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest("hex")}`;
}

function safeAssetRelativePath(relativePath) {
  return String(relativePath || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.\./g, "_");
}

function sourceUrl(relativePath) {
  return `https://github.com/kingc95/XanaNode-Studio/blob/main/${safeAssetRelativePath(relativePath)}`;
}

function nodeKindFor(relativePath) {
  const clean = safeAssetRelativePath(relativePath);
  const ext = path.extname(clean).toLowerCase();
  if (clean.startsWith("src/") || clean.startsWith("scripts/")) {
    return {
      type: "source",
      subtype: "reference_code",
      media_type: "document",
      mime_type: [".css"].includes(ext) ? "text/css" : [".html"].includes(ext) ? "text/html" : "text/javascript"
    };
  }
  if (clean.startsWith("test/")) {
    return {
      type: "source",
      subtype: "test_artifact",
      media_type: "document",
      mime_type: "text/javascript"
    };
  }
  return {
    type: "source",
    subtype: "project_document",
    media_type: "document",
    mime_type:
      ext === ".json" ? "application/json"
      : ext === ".css" ? "text/css"
      : ext === ".html" ? "text/html"
      : "text/markdown"
  };
}

function titleFor(relativePath) {
  const clean = safeAssetRelativePath(relativePath);
  if (clean === "README.md") return "XanaNode Studio README";
  if (clean === "LICENSE") return "XanaNode Studio License";
  if (clean === "package.json") return "XanaNode Studio Package Manifest";
  return clean
    .replace(/\.[^.]+$/, "")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
    .join(" / ");
}

function summaryFor(relativePath) {
  return `${safeAssetRelativePath(relativePath)} is preserved as a raw Studio source artifact in the XanaNode Studio substrate.`;
}

function listRepositoryFiles() {
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "substrate-source" || entry.name.startsWith(".git")) continue;
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(studioRoot, fullPath).replace(/\\/g, "/");
      const top = relativePath.split("/")[0];
      if (entry.isDirectory()) {
        if (includeRoots.has(top)) visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!includeRootFiles.has(relativePath) && !includeRoots.has(top)) continue;
      if (!includeExtensions.has(ext) && !includeRootFiles.has(relativePath)) continue;
      files.push(relativePath);
    }
  }
  visit(studioRoot);
  return files.sort((a, b) => a.localeCompare(b));
}

function readTextIfPossible(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (![".js", ".json", ".md", ".txt", ".cjs", ".mjs", ".css", ".html", ""].includes(ext)) return "";
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function buildStudioSubstrateSource(outDir = defaultOutDir) {
  cleanDir(outDir);
  const version = readPackageVersion();

  const manifest = {
    id: "xananode.studio",
    name: "XanaNode Studio Substrate",
    version,
    namespace: "xananode.studio",
    description: "A substrate source built directly from the XanaNode Studio repository, preserving the Electron app, renderer code, preload and main-process logic, scripts, tests, and raw project documents as first-class XanaNode records.",
    schema_version: "xananode-core@0.5.0",
    repository: {
      type: "git",
      url: "https://github.com/kingc95/XanaNode-Studio.git",
      default_branch: "main"
    },
    imports: ["xananode.workspace"],
    build_metadata: {
      built_at: generatedAt,
      git_commit: gitValue(["rev-parse", "HEAD"]),
      git_branch: gitValue(["rev-parse", "--abbrev-ref", "HEAD"]),
      built_by: "xananode-studio/tools/build-substrate-source.mjs"
    },
    sharing: {
      default_shareable: true,
      rules: [
        {
          selector: { namespace: "xananode.studio" },
          shareable: true,
          scope: "public",
          reason: "The Studio substrate is intended to be federated as a public implementation source."
        }
      ]
    }
  };

  const nodes = [
    {
      id: "xananode.studio:project/xananode-studio",
      title: "XanaNode Studio",
      type: "project",
      subtype: "desktop_authoring_app",
      importance: 5,
      summary: "The local-first desktop application for authoring, reviewing, validating, and projecting XanaNode substrates.",
      source_url: "https://github.com/kingc95/XanaNode-Studio",
      repository: "kingc95/XanaNode-Studio",
      software_version: version,
      relationships: []
    },
    {
      id: "xananode.studio:source/repository-xananode-studio",
      title: "XanaNode Studio Repository",
      type: "source",
      subtype: "git_repository",
      importance: 5,
      summary: "Public Git repository for the XanaNode Studio reference implementation.",
      source_url: "https://github.com/kingc95/XanaNode-Studio",
      repository: "kingc95/XanaNode-Studio",
      rights_status: "external",
      relationships: []
    },
    {
      id: "xananode.studio:technology/xananode-studio-electron-app",
      title: "XanaNode Studio Electron App",
      type: "technology",
      subtype: "desktop_application",
      importance: 4,
      summary: "The desktop application surface that authors use to work with substrates through graph projection, editor panels, validation, and projection helpers.",
      software_version: version,
      relationships: []
    }
  ];

  const relationships = [
    {
      id: "xananode.studio:rel/repository-documents-studio-project",
      source: "xananode.studio:source/repository-xananode-studio",
      target: "xananode.studio:project/xananode-studio",
      type: "documents",
      summary: "The repository documents and carries the Studio project.",
      asserted_at: generatedAt
    },
    {
      id: "xananode.studio:rel/studio-project-implements-workspace",
      source: "xananode.studio:project/xananode-studio",
      target: "xananode.workspace:project/xananode-workspace",
      type: "implements",
      summary: "Studio uses Workspace as its substrate-management layer and authoring engine contract.",
      asserted_at: generatedAt
    },
    {
      id: "xananode.studio:rel/studio-app-supports-studio-project",
      source: "xananode.studio:technology/xananode-studio-electron-app",
      target: "xananode.studio:project/xananode-studio",
      type: "supports",
      summary: "The Electron app is the human-facing desktop surface of XanaNode Studio.",
      asserted_at: generatedAt
    }
  ];

  for (const relativePath of listRepositoryFiles()) {
    const sourcePath = path.join(studioRoot, relativePath);
    const kind = nodeKindFor(relativePath);
    const localSlug = slug(relativePath.replace(/\.[^.]+$/, "")) || "artifact";
    const nodeId = `xananode.studio:${kind.type}/artifact-${localSlug}`;
    const assetPath = `assets/raw/repository/${safeAssetRelativePath(relativePath)}`;
    const assetTarget = path.join(outDir, assetPath);
    fs.mkdirSync(path.dirname(assetTarget), { recursive: true });
    fs.copyFileSync(sourcePath, assetTarget);
    const content = readTextIfPossible(sourcePath);
    const contentId = sha256File(sourcePath);

    nodes.push({
      id: nodeId,
      title: titleFor(relativePath),
      type: kind.type,
      subtype: kind.subtype,
      importance:
        relativePath === "README.md" ||
        relativePath === "package.json" ||
        relativePath.startsWith("src/") ||
        relativePath.startsWith("scripts/")
          ? 4
          : 3,
      summary: summaryFor(relativePath),
      source_url: sourceUrl(relativePath),
      artifact_path: relativePath,
      asset_path: assetPath,
      asset_role: "repository_source",
      media_type: kind.media_type,
      mime_type: kind.mime_type,
      rights_status: "Apache-2.0",
      content_id: contentId,
      ...(content ? { content } : {}),
      source_snapshot: {
        captured_at: generatedAt,
        source_url: sourceUrl(relativePath),
        method: "archive",
        content_id: contentId,
        rights_status: "Apache-2.0",
        tool: "xananode-studio/tools/build-substrate-source.mjs"
      },
      relationships: []
    });

    relationships.push({
      id: `xananode.studio:rel/repository-contains-${localSlug}`,
      source: "xananode.studio:source/repository-xananode-studio",
      target: nodeId,
      type: "contains",
      summary: `The Studio repository contains ${relativePath}.`,
      asserted_at: generatedAt
    });

    if (relativePath.startsWith("src/") || relativePath.startsWith("scripts/")) {
      relationships.push({
        id: `xananode.studio:rel/${localSlug}-supports-studio-project`,
        source: nodeId,
        target: "xananode.studio:project/xananode-studio",
        type: "supports",
        summary: `${titleFor(relativePath)} supports the Studio implementation.`,
        asserted_at: generatedAt
      });
    }
  }

  writeJson(path.join(outDir, "substrate.json"), manifest);
  writeJson(path.join(outDir, "nodes.json"), { nodes });
  writeJson(path.join(outDir, "relationships.json"), { relationships });
  for (const node of nodes) {
    writeJson(path.join(outDir, "nodes", `${node.type}_${slug(node.title)}.json`), node);
  }
  writeText(path.join(outDir, "README.md"), `# XanaNode Studio Substrate

This folder is the explicit substrate source generated from the XanaNode Studio repository.

It exists so higher layers can federate with Studio as a normal substrate instead of inferring Studio facts ad hoc.

Regenerate it from the repository root with:

\`\`\`powershell
node tools/build-substrate-source.mjs
\`\`\`

Or from \`XanaNode-Master\`:

\`\`\`powershell
npm run studio:build-substrate-source
\`\`\`
`);

  return {
    outDir,
    manifest,
    nodeCount: nodes.length,
    relationshipCount: relationships.length
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = buildStudioSubstrateSource();
  console.log(`Studio substrate source: ${result.outDir}`);
  console.log(`  Nodes: ${result.nodeCount}`);
  console.log(`  Relationships: ${result.relationshipCount}`);
}
