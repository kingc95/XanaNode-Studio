import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import nodeTypeRegistry from "../../vendor/xananode-core/vendor/xananode-protocol/schemas/xananode-node-types.v0.3.0.json";
import relationshipTypeRegistry from "../../vendor/xananode-core/vendor/xananode-protocol/schemas/xananode-relationship-types.v0.5.0.json";
import xananodeIconUrl from "../../vendor/xananode-core/vendor/xananode-protocol/media/images/xananode-icon.svg";
import {
  buildHopNeighborhood,
  buildReadableTravelOverlayMarkup,
  createProjectionRegistry,
  findProjectionRoute,
  fitReadableProjectionViewport,
  layoutReadableProjection,
  projectionEdgeArrowPoints,
  projectionEdgePath,
  relationshipsFromProjectionNodes,
  wrapProjectionText
} from "../../vendor/xananode-core/src/projection.js";
import buildMetadata from "../generated/build-metadata.json";
import "./styles/app.css";

const NODE_TYPE_DEFINITIONS = [...nodeTypeRegistry.node_types].sort((a, b) => a.label.localeCompare(b.label));
const NODE_TYPES = NODE_TYPE_DEFINITIONS.map((definition) => definition.type);
const NODE_TYPES_BY_TYPE = Object.fromEntries(NODE_TYPE_DEFINITIONS.map((definition) => [definition.type, definition]));
const NODE_TYPE_ICON_MODULES = import.meta.glob("../../vendor/xananode-core/vendor/xananode-protocol/media/projection/node-types/*.svg", {
  eager: true,
  query: "?url",
  import: "default"
});
const NODE_TYPE_ICON_URLS = Object.fromEntries(Object.entries(NODE_TYPE_ICON_MODULES).map(([file, url]) => {
  const name = file.split(/[\\/]/).pop()?.replace(/\.svg$/i, "") || "";
  return [name, url];
}));
const RELATIONSHIP_TYPE_DEFINITIONS = [...relationshipTypeRegistry.relationship_types].sort((a, b) => {
  const categoryCompare = a.category.localeCompare(b.category);
  return categoryCompare || a.label.localeCompare(b.label);
});
const RELATIONSHIP_TYPES_BY_TYPE = Object.fromEntries(RELATIONSHIP_TYPE_DEFINITIONS.map((definition) => [definition.type, definition]));
const RELATIONSHIP_CATEGORIES = [...new Set(RELATIONSHIP_TYPE_DEFINITIONS.map((definition) => definition.category))].sort();
const GRAPH_PROJECTION_REGISTRY = createProjectionRegistry({
  nodeTypes: nodeTypeRegistry.node_types,
  relationshipTypes: relationshipTypeRegistry.relationship_types
});

function App() {
  const [workspace, setWorkspace] = useState(null);
  const [status, setStatus] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [draft, setDraft] = useState(null);
  const [notice, setNotice] = useState(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [intertwingleOpen, setIntertwingleOpen] = useState(false);
  const [intertwingleBusy, setIntertwingleBusy] = useState(false);
  const [intertwingleProgress, setIntertwingleProgress] = useState("");
  const [federationTargets, setFederationTargets] = useState([]);
  const [federationLoading, setFederationLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewLogs, setPreviewLogs] = useState([]);
  const [centerMode, setCenterMode] = useState("graph");
  const [catalogMode, setCatalogMode] = useState("type");
  const [appMetadata, setAppMetadata] = useState(buildMetadata);
  const [buildSuggestionMode, setBuildSuggestionMode] = useState("review");
  const [projectionLayout, setProjectionLayout] = useState("single");
  const [projectionSplit, setProjectionSplit] = useState(55);
  const [relationshipLinkMode, setRelationshipLinkMode] = useState(null);
  const [graphCommand, setGraphCommand] = useState(null);
  const [recentWorkspaces, setRecentWorkspaces] = useState(() => loadRecentWorkspaces());
  const api = window.xananode || createUnavailableApi();
  const lastPreviewNodeRef = useRef("");

  useEffect(() => {
    api.appMetadata?.().then((result) => {
      if (result?.ok && result.metadata) setAppMetadata(result.metadata);
    });
    const offLog = api.onPreviewLog?.((message) => {
      setPreviewLogs((logs) => [...logs.slice(-80), message]);
    });
    const offStop = api.onPreviewStopped?.((message) => {
      setPreviewLogs((logs) => [...logs, `Hugo preview stopped: ${message.code ?? "unknown"}`]);
    });
    const offWorkspaceProgress = api.onWorkspaceProgress?.((message) => {
      if (!message?.message) return;
      setIntertwingleProgress(String(message.message));
    });
    return () => {
      offLog?.();
      offStop?.();
      offWorkspaceProgress?.();
    };
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), notice.type === "error" ? 7000 : 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (workspace) rememberRecentWorkspace(workspace, setRecentWorkspaces);
  }, [workspace]);

  useEffect(() => {
    const offCommand = api.onStudioCommand?.((message) => {
      const command = message?.command;
      if (!command) return;
      if (command.startsWith("graph:")) {
        setProjectionLayout("single");
        setCenterMode("graph");
        setGraphCommand({ command, nonce: Date.now() });
        return;
      }
      if (command === "projection:graph") {
        setProjectionLayout("single");
        setCenterMode("graph");
      } else if (command === "projection:hugo") {
        setProjectionLayout("single");
        setCenterMode("preview");
      } else if (command === "projection:both") {
        setProjectionLayout("split");
        setCenterMode("graph");
      } else if (command === "preview:rebuild") {
        rebuildPreview();
      } else if (command === "preview:start") {
        startPreview();
      } else if (command === "workspace:open") {
        openWorkspace();
      } else if (command === "workspace:health") {
        refreshStatus();
      } else if (command === "workspace:build") {
        run(() => api.build(), "Built substrate artifacts");
      } else if (command === "substrate:intertwingle" || command === "pack:open") {
        setIntertwingleProgress("");
        setIntertwingleOpen(true);
      } else if (command === "substrate:registry") {
        openRegistry();
      } else if (command === "node:save") {
        saveNode();
      } else if (command === "substrate:export" || command === "pack:export") {
        exportSubstrate();
      } else if (command === "workspace:validate") {
        validateWorkspace();
      }
    });
    return () => offCommand?.();
  }, [api, draft, previewUrl, workspace]);

  function loadPreviewLocation(location, source = "preview") {
    const cleanLocation = String(location || "").trim();
    if (!cleanLocation) {
      setPreviewLogs((logs) => [...logs.slice(-120), `[${source}] empty location\n`]);
      return;
    }

    let path = cleanLocation;
    try {
      const parsed = new URL(cleanLocation, previewUrl || "http://localhost:1313");
      path = parsed.pathname;
      const queryNode = parsed.searchParams.get("node");
      if (queryNode) path = `/node/${queryNode}`;
    } catch {
      // Keep the original value; the regex below will decide whether it is useful.
    }

    setPreviewLogs((logs) => [...logs.slice(-120), `[${source}] location=${cleanLocation}\n`]);

    const match = path.match(/^\/node\/([^/?#]+)\/?$/);
    if (!match) {
      setPreviewLogs((logs) => [...logs.slice(-120), `[${source}] no node match for ${path}\n`]);
      return;
    }

    const nodeId = decodeURIComponent(match[1]);
    if (!nodeId) {
      setPreviewLogs((logs) => [...logs.slice(-120), `[${source}] empty node id from ${path}\n`]);
      return;
    }

    if (isPreviewHelperNodeId(nodeId)) {
      setPreviewLogs((logs) => [...logs.slice(-120), `[${source}] ignored helper nodeId=${nodeId}\n`]);
      return;
    }

    if (nodeId === lastPreviewNodeRef.current) {
      setPreviewLogs((logs) => [...logs.slice(-120), `[${source}] already selected ${nodeId}\n`]);
      return;
    }

    const selected = findWorkspaceNode(nodeId, workspace?.nodes || []);
    if (!selected) {
      setPreviewLogs((logs) => [...logs.slice(-120), `[${source}] unresolved nodeId=${nodeId}\n`]);
      setNotice({ type: "error", text: `Preview node not found in workspace: ${nodeId}` });
      return;
    }

    lastPreviewNodeRef.current = nodeId;
    setPreviewLogs((logs) => [...logs.slice(-120), `[${source}] resolved nodeId=${nodeId} -> ${selected.id || selected.protocolId || selected.title}\n`]);
    setSelectedNode(selected);
    setDraft(makeDraft(selected));
    setCenterMode("preview");
  }

  useEffect(() => {
    function handlePreviewMessage(event) {
      const data = event.data || {};
      if (data.source !== "xananode-preview") return;

      if (previewUrl) {
        try {
          const allowedOrigin = new URL(previewUrl).origin;
          if (event.origin !== allowedOrigin) {
            setPreviewLogs((logs) => [...logs.slice(-120), `[preview message] ignored origin ${event.origin}; expected ${allowedOrigin}\n`]);
            return;
          }
        } catch {
          // Keep going. A malformed preview URL should not disable preview selection.
        }
      }

      loadPreviewLocation(data.path || data.url || (data.nodeId ? `/node/${encodeURIComponent(data.nodeId)}` : ""), "preview message");
    }

    window.addEventListener("message", handlePreviewMessage);
    return () => window.removeEventListener("message", handlePreviewMessage);
  }, [previewUrl, workspace]);

  const nodes = workspace?.nodes || [];
  const hugoEnabled = workspace?.settings?.preview?.enabled !== false && workspace?.settings?.preview?.renderer !== "none";
  const currentNode = draft || selectedNode;
  const nodeGroups = useMemo(() => groupNodes(nodes, catalogMode), [nodes, catalogMode]);
  const suggestions = useMemo(() => getSuggestions(currentNode, nodes), [currentNode, nodes]);

  async function run(action, label) {
    try {
      const result = await action();
      if (!result?.ok) throw new Error(result?.error || `${label} failed`);
      setNotice({ type: "success", text: label });
      if (result.workspace) setWorkspace(result.workspace);
      return result;
    } catch (error) {
      setNotice({ type: "error", text: error.message });
      return null;
    }
  }

  async function openWorkspace() {
    const result = await run(() => api.openWorkspace(), "Opened workspace");
    if (result?.workspace) {
      setStatus(null);
      setSelectedNode(result.workspace.nodes?.[0] || null);
      setDraft(null);
      rememberRecentWorkspace(result.workspace, setRecentWorkspaces);
    }
  }

  async function intertwingleSubstrate() {
    const result = await run(
      () => (api.intertwingleSubstrate ? api.intertwingleSubstrate() : api.openPack()),
      "Intertwingled substrate working copy"
    );
    if (result?.workspace) {
      setStatus(null);
      setSelectedNode(result.workspace.nodes?.[0] || null);
      setDraft(null);
      setCenterMode("graph");
      rememberRecentWorkspace(result.workspace, setRecentWorkspaces);
    }
  }

  async function intertwingleSubstrateFile() {
    setIntertwingleBusy(true);
    setIntertwingleProgress("Waiting for substrate file selection...");
    const result = await run(
      () => (api.openSubstrateFile ? api.openSubstrateFile() : api.intertwingleSubstrate ? api.intertwingleSubstrate() : api.openPack()),
      workspace ? "Mounted substrate into this workspace" : "Opened intertwingled substrate working copy"
    );
    setIntertwingleBusy(false);
    if (result?.workspace) {
      setStatus(null);
      setSelectedNode(selectedNode || result.workspace.nodes?.[0] || null);
      setDraft(null);
      setCenterMode(workspace ? "health" : "graph");
      setIntertwingleProgress(workspace ? "Substrate mounted." : "Substrate opened as a working copy.");
      setIntertwingleOpen(false);
      setIntertwingleProgress("");
      rememberRecentWorkspace(result.workspace, setRecentWorkspaces);
    } else {
      setIntertwingleProgress("");
    }
  }

  async function intertwingleSubstrateFolder() {
    setIntertwingleBusy(true);
    setIntertwingleProgress("Waiting for substrate folder selection...");
    const result = await run(
      () => (api.openSubstrateFolder ? api.openSubstrateFolder() : api.intertwingleSubstrate ? api.intertwingleSubstrate() : api.openPack()),
      workspace ? "Mounted substrate into this workspace" : "Opened intertwingled substrate working copy"
    );
    setIntertwingleBusy(false);
    if (result?.workspace) {
      setStatus(null);
      setSelectedNode(selectedNode || result.workspace.nodes?.[0] || null);
      setDraft(null);
      setCenterMode(workspace ? "health" : "graph");
      setIntertwingleOpen(false);
      setIntertwingleProgress("");
      rememberRecentWorkspace(result.workspace, setRecentWorkspaces);
    } else {
      setIntertwingleProgress("");
    }
  }

  async function openRegistry() {
    setFederationLoading(true);
    setIntertwingleOpen(true);
    const result = await run(
      () => (api.listFederationTargets ? api.listFederationTargets() : { ok: true, federation_targets: [] }),
      "Loaded online substrate registry"
    );
    setFederationTargets(result?.federation_targets || []);
    setFederationLoading(false);
  }

  async function openFederationTarget(targetId) {
    const result = await run(() => api.openFederationTarget({ targetId }), "Cloned and intertwingled online substrate");
    if (result?.workspace) {
      setStatus(null);
      setSelectedNode(selectedNode || result.workspace.nodes?.[0] || null);
      setDraft(null);
      setCenterMode(workspace ? "health" : "graph");
      setIntertwingleOpen(false);
      rememberRecentWorkspace(result.workspace, setRecentWorkspaces);
    }
  }

  async function exportSubstrate() {
    await run(() => (api.exportSubstrate ? api.exportSubstrate() : api.exportPack()), "Exported .substrate");
  }

  async function importAssets() {
    const result = await run(() => api.importAssets(), "Imported assets");
    if (result?.workspace) {
      const firstImported = result.imported?.[0];
      const importedNode = firstImported
        ? result.workspace.nodes?.find((node) => (
          node.title === firstImported.nodeData?.title
          || node.data?.asset === firstImported.nodeData?.asset
          || node.data?.asset_path === firstImported.nodeData?.asset
        ))
        : null;
      if (importedNode) {
        setSelectedNode(importedNode);
        setDraft(makeDraft(importedNode));
      }
      const linkCount = result.imported?.reduce((sum, item) => sum + (item.intakeAnalysis?.link_suggestions?.length || 0), 0) || 0;
      const transclusionCount = result.imported?.reduce((sum, item) => sum + (item.intakeAnalysis?.transclusion_suggestions?.length || 0), 0) || 0;
      const relationshipCount = result.imported?.reduce((sum, item) => sum + (item.intakeAnalysis?.mention_relationships?.length || 0), 0) || 0;
      if (linkCount || transclusionCount || relationshipCount) {
        setNotice({
          type: "success",
          text: `Imported assets. Core found ${relationshipCount} mention relationships, ${linkCount} link candidates, and ${transclusionCount} transclusion candidates.`
        });
      }
    }
  }

  async function createWorkspace(defaults = {}) {
    const result = await run(
      () => api.createWorkspace({
        name: defaults.name || "New XanaNode Substrate",
        author: defaults.author || "",
        git: defaults.git !== false,
        includeHugo: defaults.includeHugo === true,
        useDefaultLocation: defaults.useDefaultLocation !== false
      }),
      "Created workspace"
    );
    if (result?.workspace) {
      setStatus(null);
      setSelectedNode(result.workspace.nodes?.[0] || null);
      setDraft(null);
      setSetupOpen(false);
      rememberRecentWorkspace(result.workspace, setRecentWorkspaces);
    }
    return result;
  }

  async function openRecentWorkspace(rootDir) {
    const result = await run(() => api.openWorkspaceAtPath?.({ rootDir }), "Opened recent workspace");
    if (result?.workspace) {
      setStatus(null);
      setSelectedNode(result.workspace.nodes?.[0] || null);
      setDraft(null);
      setRecentWorkspaces((items) => refreshRecentWorkspace(items, result.workspace));
    }
  }

  async function createTrialWorkspace() {
    const result = await createWorkspace({
      name: "XanaNode Studio Trial",
      author: "Studio Trial",
      git: false,
      includeHugo: true,
      useDefaultLocation: true
    });
    if (!result?.workspace) return;
    const namespace = result.workspace.manifest?.namespace || "xananode-studio-trial";
    await run(
      () => api.createNode({
        node: {
          id: "how-to-make-a-campfire",
          title: "How do you make a campfire?",
          type: "question",
          subtype: "how_to",
          summary: "A practical question node for learning how inquiries, claims, sources, and steps connect.",
          relationships: [
            { type: "requires_information", target: `${namespace}:knowledge_gap/campfire-safety-gap` }
          ]
        },
        body: "# How do you make a campfire?\n\nA useful substrate can begin with an ordinary question. From here, Studio can connect the question to an answer, a safety gap, sources, tools, places, and claims that explain what matters.\n"
      }),
      "Seeded campfire question"
    );
    await run(
      () => api.createNode({
        node: {
          id: "campfire-basic-answer",
          title: "A small fire starts with tinder, kindling, fuel, airflow, and a safe place.",
            type: "response",
            subtype: "answer",
            summary: "Build a safe fire lay, light tinder, add kindling, then feed larger fuel slowly.",
            relationships: [
            { type: "answers", target: `${namespace}:question/how-to-make-a-campfire` },
            { type: "requires", target: `${namespace}:claim/campfire-safe-location` },
            { type: "requires", target: `${namespace}:claim/dry-tinder-and-kindling` }
          ]
        },
        body: "# A small fire starts with tinder, kindling, fuel, airflow, and a safe place.\n\nClear the area, keep water nearby, make a small tinder bundle, add kindling loosely enough for air to move, and only add larger fuel after the flame is stable.\n"
      }),
      "Seeded campfire answer"
    );
    await run(
      () => api.createNode({
        node: {
          id: "campfire-safe-location",
          title: "A campfire needs a safe location.",
          type: "claim",
          summary: "The fire site should be legal, clear of hazards, sheltered from spreading, and easy to extinguish.",
          relationships: [{ type: "supports", target: `${namespace}:response/campfire-basic-answer` }]
        },
        body: "# A campfire needs a safe location.\n\nA fire is not just a flame. It is a relationship between weather, ground, fuel, people, and responsibility.\n"
      }),
      "Seeded safety claim"
    );
    await run(
      () => api.createNode({
        node: {
          id: "dry-tinder-and-kindling",
          title: "Dry tinder and kindling make ignition possible.",
          type: "claim",
          summary: "Small, dry material catches first and gives larger fuel time to heat.",
          relationships: [{ type: "supports", target: `${namespace}:response/campfire-basic-answer` }]
        },
        body: "# Dry tinder and kindling make ignition possible.\n\nThe first useful fact is scale: small dry fibers catch, pencil-thin sticks sustain, and larger wood comes later.\n"
      }),
      "Seeded ignition claim"
    );
    await run(
      () => api.createNode({
        node: {
          id: "campfire-safety-gap",
          title: "What rules and fire conditions apply here?",
          type: "knowledge_gap",
          subtype: "safety",
          summary: "The answer changes by place, season, weather, and local law.",
          relationships: [{ type: "context_for", target: `${namespace}:question/how-to-make-a-campfire` }]
        },
        body: "# What rules and fire conditions apply here?\n\nA complete answer needs local fire restrictions, current wind, drought conditions, and whether open flames are allowed.\n"
      }),
      "Seeded safety gap"
    );
    await run(
      () => api.updateNode({
        relativeFile: "content/nodes/start-here.md",
        nodeData: {
          id: "start-here",
          title: "Start Here",
          type: "trail",
          summary: "A simple starter trail that walks from a practical question to an answer and its supporting context.",
          nodes: [
            `${namespace}:question/how-to-make-a-campfire`,
            `${namespace}:response/campfire-basic-answer`,
            `${namespace}:claim/campfire-safe-location`,
            `${namespace}:claim/dry-tinder-and-kindling`,
            `${namespace}:knowledge_gap/campfire-safety-gap`
          ]
        },
        body: "# Start Here\n\nBegin with a practical question, move to a working answer, then inspect the claims and open context that keep the answer grounded.\n"
      }),
      "Linked starter trail"
    );
    const refreshed = await run(() => api.refreshWorkspace(), "Trial workspace ready");
    if (refreshed?.workspace) {
      setSelectedNode(refreshed.workspace.nodes?.find((node) => node.data?.id === "start-here") || refreshed.workspace.nodes?.[0] || null);
      setCenterMode("graph");
      rememberRecentWorkspace(refreshed.workspace, setRecentWorkspaces);
    }
  }

  async function refreshStatus() {
    const result = await run(() => api.workspaceStatus(), "Loaded health and intake report");
    if (result) {
      setStatus({ health: result.health, validation: result.validation, intake_reviews: result.intake_reviews || [] });
      setCenterMode("health");
    }
  }

  async function validateWorkspace() {
    const result = await run(() => api.validate(), "Validated workspace");
    if (result?.validation) {
      setStatus((current) => ({
        health: current?.health || null,
        validation: result.validation,
        intake_reviews: current?.intake_reviews || []
      }));
      setCenterMode("health");
    }
  }

  async function removeMountedImport(importId) {
    const result = await run(() => api.removeImport(importId), "Removed mounted substrate");
    if (result) {
      setStatus({ health: result.health, validation: result.validation, intake_reviews: result.intake_reviews || [] });
      setCenterMode("health");
    }
  }

  async function toggleMountedNode(importId, nodeId, enabled) {
    const result = await run(() => api.toggleImportNodeVisibility({ importId, nodeId, enabled }), enabled ? "Restored mounted node" : "Hid mounted node");
    if (result) {
      setStatus({ health: result.health, validation: result.validation, intake_reviews: result.intake_reviews || [] });
      setCenterMode("health");
    }
  }

  function openMountedNode(nodeId) {
    const node = findWorkspaceNode(nodeId, nodes);
    if (!node) {
      setNotice({ type: "error", text: `Mounted node not found: ${nodeId}` });
      return;
    }
    setSelectedNode(node);
    setDraft(node?.readOnly ? null : makeDraft(node));
    setCenterMode("graph");
  }

  async function duplicateMountedNode(nodeId) {
    const node = findWorkspaceNode(nodeId, nodes);
    if (!node) {
      setNotice({ type: "error", text: `Mounted node not found: ${nodeId}` });
      return;
    }
    setSelectedNode(node);
    setDraft(null);
    await duplicateNodeFrom(node);
  }

  async function startPreview() {
    const result = await run(() => api.startHugoPreview(), "Started Hugo preview");
    if (result?.url) {
      setPreviewUrl(bustPreviewUrl(result.url));
      setCenterMode("preview");
    }
  }

  async function rebuildPreview() {
    const result = await run(() => api.rebuildHugoPreview(), "Rebuilt Hugo preview");
    if (result?.url) {
      setPreviewUrl(bustPreviewUrl(result.url));
      setCenterMode("preview");
    }
  }

  function cloneFrontMatterForNewNode(node) {
    const source = extractFrontMatterShape(node);
    const next = { ...source };
    delete next.id;
    delete next.protocol_id;
    delete next.slug;
    delete next.source_node_id;
    delete next.source_pack_id;
    delete next.source_file;
    delete next.content_id;
    delete next.version_id;
    delete next.signature;
    delete next.relationships;
    delete next.nodes;
    delete next.branches;
    delete next.imported_from;
    delete next.imported;
    delete next.pack_id;
    delete next.pack_mode;
    delete next.readOnly;
    delete next.mounted;
    delete next.workspace_copy_status;
    delete next.created_at;
    delete next.updated_at;
    delete next.filePath;
    delete next.path;
    delete next.relativePath;
    delete next.relativeFile;
    delete next.__file;
    next.title = `Copy of ${source.title || source.id || "Untitled Node"}`;
    next.summary = "";
    next.relationships = [];
    if (next.type === "trail") {
      next.nodes = [];
      next.branches = [];
    }
    return next;
  }

  async function duplicateNodeFrom(base) {
    if (!base) return;
    const frontMatter = cloneFrontMatterForNewNode(base);
    const result = await run(
      () => api.createNode({ node: normalizeFrontMatterForSave(frontMatter), body: `# ${frontMatter.title}\n\n` }),
      "Duplicated node"
    );
    if (!result?.result?.data) return;
    const saved = findWorkspaceNode(
      result.result.data.protocol_id || result.result.data.id || result.result.filePath || frontMatter.title,
      result.workspace?.nodes || []
    );
    if (saved) {
      setSelectedNode(saved);
      setDraft(makeDraft(saved));
    } else {
      setDraft({
        ...frontMatter,
        relativePath: result.result.filePath,
        frontMatter: result.result.data
      });
    }
    setCenterMode("graph");
  }

  async function duplicateNode() {
    const base = draft || selectedNode;
    await duplicateNodeFrom(base);
  }

  async function saveNode() {
    if (!draft) return;
    const relativeFile = draft.relativePath || draft.path || draft.filePath || draft.__file;
    if (!relativeFile) {
      const result = await run(
        () => api.createNode({ node: normalizeFrontMatterForSave(draft.frontMatter || draft), body: draft.body || `# ${draft.title || "Untitled"}\n\n` }),
        "Created node"
      );
      const saved = findWorkspaceNode(
        result?.result?.data?.protocol_id || result?.result?.data?.id || result?.result?.filePath || draft.frontMatter?.title,
        result?.workspace?.nodes || []
      );
      if (saved) {
        setSelectedNode(saved);
        setDraft(makeDraft(saved));
      } else if (result?.result?.data) {
        setDraft({ ...draft, relativePath: result.result.filePath, frontMatter: result.result.data });
      }
      return;
    }
    const nodeData = normalizeFrontMatterForSave(draft.frontMatter || extractFrontMatterShape(draft));
    const result = await run(() => api.updateNode({ relativeFile, nodeData, body: draft.body || "" }), "Saved node");
    const saved = findWorkspaceNode(
      result?.result?.data?.protocol_id || result?.result?.data?.id || result?.result?.filePath || nodeData.protocol_id || nodeData.id || nodeData.title || relativeFile,
      result?.workspace?.nodes || []
    );
    if (saved) {
      setSelectedNode(saved);
      setDraft(makeDraft(saved));
    } else {
      setDraft({
        ...draft,
        relativePath: result?.result?.filePath || relativeFile,
        frontMatter: result?.result?.data || nodeData
      });
    }
  }

  async function deleteCurrentNode() {
    if (!draft) return;
    const nodeRef = resolveNodeFilePath(draft) || draft.frontMatter?.protocol_id || draft.frontMatter?.id || draft.title;
    if (!nodeRef) {
      setNotice({ type: "error", text: "Save this node before removing it." });
      return;
    }
    const planResult = await api.planNodeDeletion?.({ nodeRef });
    if (!planResult?.ok) {
      setNotice({ type: "error", text: planResult?.error || "Could not inspect node removal impact." });
      return;
    }
    const plan = planResult.plan;
    const confirmed = window.confirm(formatDeletionWarning(plan));
    if (!confirmed) return;
    const result = await run(() => api.deleteNode({ nodeRef }), `Removed ${plan?.target?.title || "node"}`);
    if (!result?.workspace) return;
    const nextNodes = result.workspace.nodes || [];
    const nextSelected = nextNodes[0] || null;
    setSelectedNode(nextSelected);
    setDraft(nextSelected?.readOnly ? null : (nextSelected ? makeDraft(nextSelected) : null));
  }

  async function saveSnapshot(reason) {
    if (!reason?.trim()) return;
    const result = await run(() => api.saveSnapshot({ message: reason.trim() }), "Saved snapshot");
    if (result?.ok) setSnapshotOpen(false);
  }

  function selectNode(node) {
    setSelectedNode(node);
    setDraft(node?.readOnly ? null : makeDraft(node));
  }

  function newNode() {
    const title = `Untitled Node ${nodes.length + 1}`;
    const type = "concept";
    const next = {
      title,
      type,
      summary: "",
      relationships: [],
      body: `# ${title}\n\n`,
      frontMatter: { title, type, summary: "", relationships: [] }
    };
    setSelectedNode(null);
    setDraft(next);
    setCenterMode("graph");
  }

  function addRelationship(type, target) {
    if (!draft) return;
    const frontMatter = { ...(draft.frontMatter || extractFrontMatterShape(draft)) };
    const relationships = Array.isArray(frontMatter.relationships) ? [...frontMatter.relationships] : [];
    relationships.push({ type, target, summary: "" });
    setDraft({ ...draft, frontMatter: { ...frontMatter, relationships } });
  }

  function startRelationshipLink(type) {
    setRelationshipLinkMode({ type, source: null });
    setProjectionLayout("single");
    setCenterMode("graph");
    setNotice({ type: "success", text: `Choose the source node, then the target node for ${relationshipLabel(type)}.` });
  }

  function handleGraphNodeClick(node) {
    if (!relationshipLinkMode) {
      selectNode(node);
      return;
    }
    if (!relationshipLinkMode.source) {
      setRelationshipLinkMode({ ...relationshipLinkMode, source: node });
      setSelectedNode(node);
      setDraft(makeDraft(node));
      setNotice({ type: "success", text: `Source set to ${node.title || node.id}. Now choose the target.` });
      return;
    }
    const source = relationshipLinkMode.source;
    const targetRef = projectionNodeRef(node);
    const sourceDraft = makeDraft(source);
    const frontMatter = sourceDraft.frontMatter || extractFrontMatterShape(sourceDraft);
    const relationships = Array.isArray(frontMatter.relationships) ? [...frontMatter.relationships] : [];
    relationships.push({ type: relationshipLinkMode.type, target: targetRef, summary: "" });
    setSelectedNode(source);
    setDraft({ ...sourceDraft, frontMatter: { ...frontMatter, relationships } });
    setRelationshipLinkMode(null);
    setNotice({ type: "success", text: `Added ${relationshipLabel(relationshipLinkMode.type)} to the draft. Save the source node when it looks right.` });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img className="logo-mark" src={xananodeIconUrl} alt="XanaNode protocol icon" />
          <div>
            <div className="brand-title">XanaNode Studio</div>
            <div className="brand-subtitle">Local-first substrate workbench</div>
            <div className="brand-build">{formatBuildLabel(appMetadata)}</div>
          </div>
        </div>
        <div className="top-actions">
          <button onClick={() => setSetupOpen(true)}>New</button>
          <button onClick={openWorkspace}>Open</button>
          <button onClick={() => setIntertwingleOpen(true)}>Intertwingle .substrate</button>
          <button disabled={!workspace} onClick={refreshStatus}>Health</button>
          <select value={buildSuggestionMode} onChange={(event) => setBuildSuggestionMode(event.target.value)} title="Suggestion handling during build">
            <option value="review">Review suggestions</option>
            <option value="apply">Apply safe suggestions</option>
          </select>
          <button disabled={!workspace} onClick={() => run(() => api.build({ suggestionMode: buildSuggestionMode }), buildSuggestionMode === "apply" ? "Built artifacts and applied safe suggestions" : "Built substrate artifacts")}>Build Artifacts</button>
          <button disabled={!workspace} onClick={exportSubstrate}>Export .substrate</button>
          <button disabled={!workspace || !hugoEnabled} onClick={startPreview}>Hugo Projection</button>
          <button disabled={!workspace} onClick={() => setSnapshotOpen(true)}>Save Snapshot</button>
        </div>
      </header>

      {notice && <div className={`notice ${notice.type}`}>{notice.text}</div>}
      {setupOpen && (
        <WorkspaceSetup
          onCreate={createWorkspace}
          onTrial={createTrialWorkspace}
          onClose={() => setSetupOpen(false)}
        />
      )}
      {snapshotOpen && (
        <SnapshotDialog
          defaultMessage={suggestSnapshotMessage(workspace, draft)}
          onSave={saveSnapshot}
          onClose={() => setSnapshotOpen(false)}
        />
      )}
      {intertwingleOpen && (
        <IntertwingleDialog
          targets={federationTargets}
          loading={federationLoading}
          busy={intertwingleBusy}
          progress={intertwingleProgress}
          onLocalFile={intertwingleSubstrateFile}
          onLocalFolder={intertwingleSubstrateFolder}
          onOpenRegistry={openRegistry}
          onOpenTarget={openFederationTarget}
          onClose={() => setIntertwingleOpen(false)}
        />
      )}

      {!workspace ? (
        <Welcome
          onOpen={openWorkspace}
          onOpenRecent={openRecentWorkspace}
          onCreate={() => setSetupOpen(true)}
          onTrial={createTrialWorkspace}
          recentWorkspaces={recentWorkspaces}
          onClearRecent={() => {
            clearRecentWorkspaces();
            setRecentWorkspaces([]);
          }}
        />
      ) : (
        <main className="workspace-grid">
          <aside className="left-panel">
            <section className="panel-card workspace-card">
              <div className="panel-title">Workspace</div>
              <div className="small muted">{workspace.rootDir}</div>
              <div className="manifest-name">{workspace.manifest?.name || workspace.manifest?.id || "Unnamed substrate"}</div>
              <div className="workspace-credit">
                Created by <a href="https://xananode.com/" target="_blank" rel="noreferrer">Christian Siefen</a> for the <a href="https://xananode.com/" target="_blank" rel="noreferrer">XanaNode</a> project.
              </div>
              {isCanonicalWorkspace(workspace) && (
                <div className="canon-warning">
                  You are viewing canonical XanaNode material. Explore freely; edits here become your own proposal until they are accepted back into the canon.
                </div>
              )}
              {isWorkingCopyWorkspace(workspace) && (
                <div className="working-copy-warning">
                  Working copy from {workspace.settings?.source_pack?.name || workspace.settings?.source_pack?.id || "an intertwingled substrate"}. Your changes are local proposals until the source owner accepts them.
                </div>
              )}
              <div className="pill-row">
                <span className="pill">{nodes.length} nodes</span>
                <span className="pill">{workspace.imports?.imports?.length || workspace.imports?.length || 0} imports</span>
                <span className="pill">Git {workspace.git?.enabled ? "on" : "off"}</span>
                {isWorkingCopyWorkspace(workspace) && <span className="pill">working copy</span>}
              </div>
              {workspace.mountedImports?.packs?.length > 0 && (
                <div className="working-copy-warning">
                  Intertwingled substrates stay mounted into this workspace until you snapshot, merge, or remove them. They should not replace your local nodes.
                </div>
              )}
              <ProjectCreditLinks />
            </section>

            <section className="panel-card">
              <div className="panel-row">
                <div className="panel-title">Catalog</div>
                <select value={catalogMode} onChange={(e) => setCatalogMode(e.target.value)}>
                  <option value="type">Type</option>
                  <option value="subtype">Subtype</option>
                  <option value="facet">Facet</option>
                  <option value="status">Status</option>
                  <option value="author">Author</option>
                </select>
              </div>
              <button className="wide primary" onClick={newNode}>+ New Node</button>
              <button className="wide" onClick={importAssets}>Import Media / Sources</button>
              <div className="catalog-list">
                {Object.entries(nodeGroups).map(([group, groupNodes]) => (
                  <details key={group} open>
                    <summary>{group} <span>{groupNodes.length}</span></summary>
                    {groupNodes.map((node) => (
                      <button
                        key={nodeKey(node)}
                        className={`catalog-item ${selectedNode && nodeKey(selectedNode) === nodeKey(node) ? "selected" : ""}`}
                        onClick={() => selectNode(node)}
                      >
                        <span>{node.title || node.id || "Untitled"}</span>
                        <small>{node.type || "node"}</small>
                      </button>
                    ))}
                  </details>
                ))}
              </div>
            </section>
          </aside>
          <section className="center-panel">
            <ProjectionToolbar
              centerMode={centerMode}
              setCenterMode={setCenterMode}
              projectionLayout={projectionLayout}
              setProjectionLayout={setProjectionLayout}
              projectionSplit={projectionSplit}
              setProjectionSplit={setProjectionSplit}
              relationshipLinkMode={relationshipLinkMode}
              onCancelLink={() => setRelationshipLinkMode(null)}
            />
            {projectionLayout === "split" && centerMode !== "health" && centerMode !== "logs" ? (
              <div className="projection-split" style={{ gridTemplateColumns: `${projectionSplit}% minmax(280px, 1fr)` }}>
                <GraphView nodes={nodes} selectedNode={selectedNode} draft={draft} onSelect={handleGraphNodeClick} linkMode={relationshipLinkMode} command={graphCommand} />
                <PreviewView previewUrl={previewUrl} startPreview={startPreview} rebuildPreview={rebuildPreview} stopPreview={stopPreview} logs={previewLogs} compact />
              </div>
            ) : (
              <>
                {centerMode === "graph" && <GraphView nodes={nodes} selectedNode={selectedNode} draft={draft} onSelect={handleGraphNodeClick} linkMode={relationshipLinkMode} command={graphCommand} />}
                {centerMode === "preview" && <PreviewView previewUrl={previewUrl} startPreview={startPreview} rebuildPreview={rebuildPreview} stopPreview={stopPreview} logs={previewLogs} />}
              </>
            )}
                {centerMode === "health" && <HealthView status={status} refreshStatus={refreshStatus} onRemoveImport={removeMountedImport} onToggleMountedNode={toggleMountedNode} onOpenNode={openMountedNode} onDuplicateNode={duplicateMountedNode} />}
            {centerMode === "logs" && <LogView logs={previewLogs} />}
          </section>

          <aside className="right-panel">
            <EditorPanel
              selectedNode={selectedNode}
              draft={draft}
              setDraft={setDraft}
              nodes={nodes}
              suggestions={suggestions}
              addRelationship={addRelationship}
              startRelationshipLink={startRelationshipLink}
              duplicateNode={duplicateNode}
              saveNode={saveNode}
              deleteNode={deleteCurrentNode}
            />
          </aside>
        </main>
      )}
    </div>
  );
}

function ProjectCreditLinks() {
  return (
    <div className="credit-links">
      <a href="https://xananode.com/" target="_blank" rel="noreferrer">XanaNode.com</a>
      <a href="https://github.com/kingc95/XanaNode-Protocol" target="_blank" rel="noreferrer">Protocol</a>
      <a href="https://github.com/kingc95/XanaNode-Core-SDK" target="_blank" rel="noreferrer">Core SDK</a>
      <a href="https://github.com/kingc95/XanaNode-Workspace" target="_blank" rel="noreferrer">Workspace</a>
      <a href="https://github.com/kingc95/XanaNode-Hugo" target="_blank" rel="noreferrer">Hugo</a>
      <a href="https://github.com/kingc95/XanaNode-Studio" target="_blank" rel="noreferrer">Studio</a>
    </div>
  );
}

function Welcome({ onOpen, onOpenRecent, onCreate, onTrial, recentWorkspaces = [], onClearRecent }) {
  return (
    <main className="welcome">
      <div className="welcome-card">
        <div className="kicker">XanaNode Studio</div>
        <h1>Author the substrate itself.</h1>
        <p>Open a local XanaNode workspace, create nodes, connect relationships, validate the substrate, save snapshots, and preview projection layers when you need them.</p>
        <div className="welcome-actions">
          <button className="primary" onClick={onCreate}>Create Workspace</button>
          <button onClick={onTrial}>Try Demo Workspace</button>
          <button onClick={onOpen}>Open Existing</button>
        </div>
        <p className="welcome-credit">Created by <a href="https://xananode.com/" target="_blank" rel="noreferrer">Christian Siefen</a>. Learn the model at <a href="https://xananode.com/" target="_blank" rel="noreferrer">XanaNode.com</a>.</p>
        <ProjectCreditLinks />
      </div>
      <div className="welcome-card recent-card">
        <div className="panel-row">
          <div>
            <div className="kicker">Recent</div>
            <h2>Open where you left off</h2>
          </div>
          <button onClick={onClearRecent} disabled={!recentWorkspaces.length}>Clear</button>
        </div>
        {recentWorkspaces.length ? (
          <div className="recent-list">
            {recentWorkspaces.map((item) => (
              <button key={item.rootDir} className="recent-item" onClick={() => onOpenRecent?.(item.rootDir)}>
                <strong>{item.name || item.manifestName || item.rootDir}</strong>
                <small>{item.rootDir}</small>
              </button>
            ))}
          </div>
        ) : (
          <p className="muted">No recent substrates yet.</p>
        )}
      </div>
    </main>
  );
}

function WorkspaceSetup({ onCreate, onTrial, onClose }) {
  const [name, setName] = useState("New XanaNode Substrate");
  const [author, setAuthor] = useState("");
  const [git, setGit] = useState(true);
  const [includeHugo, setIncludeHugo] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    await onCreate({ name, author, git, includeHugo, useDefaultLocation: true });
    setBusy(false);
  }

  async function trial() {
    setBusy(true);
    await onTrial();
    setBusy(false);
  }

  return (
    <div className="setup-backdrop">
      <form className="setup-panel" onSubmit={submit}>
        <div className="setup-header">
          <div>
            <div className="kicker">New Workspace</div>
            <h2>Create a local substrate</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">x</button>
        </div>
        <label>Substrate name</label>
        <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        <label>Author</label>
        <input value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="Optional" />
        <label className="toggle-row">
          <input type="checkbox" checked={git} onChange={(event) => setGit(event.target.checked)} />
          <span>Save snapshots with local Git</span>
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={includeHugo} onChange={(event) => setIncludeHugo(event.target.checked)} />
          <span>Include Hugo projection preview</span>
        </label>
        <p className="setup-note">Studio creates normal substrate files first. Hugo is optional: add that projection layer when this substrate needs a website preview.</p>
        <div className="setup-actions">
          <button type="submit" className="primary" disabled={!name.trim() || busy}>Create</button>
          <button type="button" onClick={trial} disabled={busy}>Try Demo</button>
        </div>
      </form>
    </div>
  );
}

function SnapshotDialog({ defaultMessage, onSave, onClose }) {
  const [message, setMessage] = useState(defaultMessage);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    await onSave(message);
    setBusy(false);
  }

  return (
    <div className="setup-backdrop">
      <form className="setup-panel compact" onSubmit={submit}>
        <div className="setup-header">
          <div>
            <div className="kicker">Snapshot</div>
            <h2>Save this version</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">x</button>
        </div>
        <label>What changed?</label>
        <textarea rows={4} value={message} onChange={(event) => setMessage(event.target.value)} autoFocus />
        <div className="setup-actions">
          <button type="submit" className="primary" disabled={!message.trim() || busy}>Save Snapshot</button>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

function IntertwingleDialog({ targets, loading, busy, progress, onLocalFile, onLocalFolder, onOpenRegistry, onOpenTarget, onClose }) {
  return (
    <div className="setup-backdrop">
      <div className="setup-panel">
        <div className="setup-header">
          <div>
            <div className="kicker">Intertwingle</div>
            <h2>Bring another substrate into Studio</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">x</button>
        </div>
        <p className="setup-note">Choose a local `.substrate`, `substrate-bundle.json`, `substrate-bundle.jsonl`, another substrate-shaped JSON file, a local substrate folder, or a known online substrate from the protocol registry.</p>
        <div className="setup-actions">
          <button type="button" className="primary" onClick={onLocalFile} disabled={busy}>Choose Substrate File</button>
          <button type="button" onClick={onLocalFolder} disabled={busy}>Choose Folder</button>
          <button type="button" onClick={onOpenRegistry} disabled={busy}>Refresh Online Registry</button>
        </div>
        {(busy || progress) ? <p className="muted">{progress || "Working..."}</p> : null}
        <div className="editor-section">
          <div className="panel-title">Online Substrates</div>
          {loading ? <p className="muted">Loading registry targets...</p> : null}
          {!loading && !targets.length ? <p className="muted">No registry targets loaded yet.</p> : null}
          <div className="registry-targets">
            {targets.map((target) => (
              <button type="button" key={target.id} className="registry-target-card" onClick={() => onOpenTarget(target.id)}>
                <strong>{target.name}</strong>
                <small>{target.id}</small>
                <span>{target.description}</span>
                <em>{target.repository?.url || ""}</em>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectionToolbar({
  centerMode,
  setCenterMode,
  projectionLayout,
  setProjectionLayout,
  projectionSplit,
  setProjectionSplit,
  relationshipLinkMode,
  onCancelLink
}) {
  return (
    <div className="center-tabs projection-toolbar">
      <div className="tab-group">
        <button className={centerMode === "graph" && projectionLayout !== "split" ? "active" : ""} onClick={() => {
          setProjectionLayout("single");
          setCenterMode("graph");
        }}>Graph Projection</button>
        <button className={centerMode === "preview" && projectionLayout !== "split" ? "active" : ""} onClick={() => {
          setProjectionLayout("single");
          setCenterMode("preview");
        }}>Hugo Projection</button>
        <button className={projectionLayout === "split" ? "active" : ""} onClick={() => {
          setProjectionLayout("split");
          setCenterMode("graph");
        }}>Both</button>
        <button className={centerMode === "health" ? "active" : ""} onClick={() => {
          setProjectionLayout("single");
          setCenterMode("health");
        }}>Health</button>
        <button className={centerMode === "logs" ? "active" : ""} onClick={() => {
          setProjectionLayout("single");
          setCenterMode("logs");
        }}>Logs</button>
      </div>
      {projectionLayout === "split" && (
        <label className="split-control">
          <span>Graph size</span>
          <input type="range" min="35" max="75" value={projectionSplit} onChange={(event) => setProjectionSplit(Number(event.target.value))} />
        </label>
      )}
      {relationshipLinkMode && (
        <div className="link-mode-banner">
          <span>{relationshipLinkMode.source ? "Choose target" : "Choose source"} for {relationshipLabel(relationshipLinkMode.type)}</span>
          <button onClick={onCancelLink}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function GraphView({ nodes, selectedNode, draft, onSelect, linkMode, command }) {
  const current = draft || selectedNode || nodes[0] || null;
  const [graphDepth, setGraphDepth] = useState(1);
  const graphNodes = useMemo(() => buildEffectiveGraphNodes(nodes, draft, selectedNode), [nodes, draft, selectedNode]);
  const graph = useMemo(() => buildLocalGraph(graphNodes, current, graphDepth), [graphNodes, current, graphDepth]);
  const graphDensity = useMemo(() => describeGraphDensity(graph), [graph]);
  const denseGraph = graphDensity.mode === "dense";
  const labeledNodeIds = useMemo(() => selectVisibleGraphLabels(graph, { dense: denseGraph }), [graph, denseGraph]);
  const graphKey = useMemo(() => graph.nodes.map((node) => node.id || node.key).join("|"), [graph.nodes]);
  const [viewport, setViewport] = useState(() => fitGraphViewport(graph.nodes));
  const [travelMarkup, setTravelMarkup] = useState("");
  const [panning, setPanning] = useState(false);
  const panRef = useRef(null);
  const previousGraphRef = useRef({ currentId: projectionNodeRef(current), graph, viewport });
  const caption = graph.hasVisibleEdges
    ? `${graph.nodes.length} visible nodes connected to ${current?.title || current?.id || "selected node"}${denseGraph ? ` · dense view (${graphDensity.maxIncident} direct/incident connections at peak)` : ""}`
    : current
      ? `${graph.nodes.length} workspace nodes shown; no relationships connect to ${current.title || current.id || "the selected node"} yet`
      : `${graphNodes.length} workspace nodes`;

  useEffect(() => {
    setViewport(fitGraphViewport(graph.nodes));
  }, [graphKey, current?.id, current?.title, graphDepth]);

  useEffect(() => {
    const previous = previousGraphRef.current;
    const currentId = projectionNodeRef(current);
    if (!previous?.currentId || !currentId || previous.currentId === currentId) {
      previousGraphRef.current = { currentId, graph, viewport };
      return;
    }
    const fromNode = previous.graph?.nodes?.find((node) => node.id === previous.currentId);
    const toNode = previous.graph?.nodes?.find((node) => node.id === currentId);
    const route = findProjectionRoute(previous.graph?.edges || [], previous.currentId, currentId, { maxDepth: 6 });
    const routeNodes = route?.nodeIds
      ?.map((id) => previous.graph?.nodes?.find((node) => node.id === id))
      .filter(Boolean);
    if (fromNode && toNode) {
      setTravelMarkup(buildReadableTravelOverlayMarkup(fromNode, toNode, previous.viewport || viewport, { routeNodes }));
      const timer = window.setTimeout(() => setTravelMarkup(""), Math.max(820, Number(routeNodes?.length || 2) * 260));
      previousGraphRef.current = { currentId, graph, viewport };
      return () => window.clearTimeout(timer);
    }
    previousGraphRef.current = { currentId, graph, viewport };
    setTravelMarkup("");
  }, [current?.id, graphKey]);

  useEffect(() => {
    previousGraphRef.current = { currentId: projectionNodeRef(current), graph, viewport };
  }, [viewport.x, viewport.y, viewport.scale]);

  useEffect(() => {
    if (!command?.command) return;
    if (command.command === "graph:fit") setViewport(fitGraphViewport(graph.nodes));
    if (command.command === "graph:reset") setViewport(DEFAULT_GRAPH_VIEWPORT);
    if (command.command === "graph:zoom-in") setViewport((value) => scaleGraphViewport(value, 1.18));
    if (command.command === "graph:zoom-out") setViewport((value) => scaleGraphViewport(value, 0.84));
  }, [command, graph.nodes]);

  function panBy(x, y) {
    setViewport((value) => ({ ...value, x: value.x + x, y: value.y + y }));
  }

  function handleWheel(event) {
    event.preventDefault();
    setViewport((value) => scaleGraphViewport(value, event.deltaY < 0 ? 1.1 : 0.9));
  }

  function handlePointerDown(event) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    panRef.current = { x: event.clientX, y: event.clientY };
    setPanning(true);
  }

  function handlePointerMove(event) {
    if (!panRef.current) return;
    const next = { x: event.clientX, y: event.clientY };
    const previous = panRef.current;
    panRef.current = next;
    panBy(next.x - previous.x, next.y - previous.y);
  }

  function endPan(event) {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    panRef.current = null;
    setPanning(false);
  }

  if (!graphNodes.length) {
    return (
      <div className="empty-panel">
        <h2>No nodes yet.</h2>
        <p>Create the first node from the catalog panel.</p>
      </div>
    );
  }

  return (
    <div className={`graph-wrap ${linkMode ? "linking" : ""} ${panning ? "panning" : ""}`}>
      <div className="graph-tools" aria-label="Graph projection controls">
        <button type="button" onClick={() => setViewport(fitGraphViewport(graph.nodes))}>Fit</button>
        <button type="button" aria-label="Zoom out" onClick={() => setViewport((value) => scaleGraphViewport(value, 0.84))}>-</button>
        <button type="button" onClick={() => setViewport(DEFAULT_GRAPH_VIEWPORT)}>Reset</button>
        <button type="button" aria-label="Zoom in" onClick={() => setViewport((value) => scaleGraphViewport(value, 1.18))}>+</button>
      </div>
      <div className="graph-depth-tools" aria-label="Graph hop depth">
        {[1, 2, 3, 4].map((depth) => (
          <button
            key={depth}
            type="button"
            className={graphDepth === depth ? "active" : ""}
            onClick={() => setGraphDepth(depth)}
          >
            {depth} hop{depth === 1 ? "" : "s"}
          </button>
        ))}
      </div>
      <div className="graph-pan-tools" aria-label="Pan graph">
        <button type="button" aria-label="Pan up" onClick={() => panBy(0, 58)}>^</button>
        <button type="button" aria-label="Pan left" onClick={() => panBy(58, 0)}>{"<"}</button>
        <button type="button" aria-label="Pan right" onClick={() => panBy(-58, 0)}>{">"}</button>
        <button type="button" aria-label="Pan down" onClick={() => panBy(0, -58)}>v</button>
      </div>
      {linkMode && (
        <div className="graph-instruction">
          {linkMode.source ? `Target for ${linkMode.source.title || linkMode.source.id}` : "Click the source node for this relationship."}
        </div>
      )}
      <svg
        className="graph-svg"
        viewBox="0 0 900 620"
        role="img"
        aria-label="Workspace substrate graph"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <defs>
          {graph.nodes.map((node) => {
            const colors = node.style?.fills || [];
            if (colors.length < 2) return null;
            return (
              <linearGradient id={nodeGradientId(node)} key={node.id || node.key} x1="0%" y1="0%" x2="100%" y2="100%">
                {colors.map((color, index) => (
                  <stop key={`${color}-${index}`} offset={`${Math.round((index / Math.max(1, colors.length - 1)) * 100)}%`} stopColor={color} />
                ))}
              </linearGradient>
            );
          })}
        </defs>
        <rect className="graph-pan-surface" x="0" y="0" width="900" height="620" />
        <g className="graph-layer" transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
          {graph.edges.map((edge) => {
            const targetInset = Math.max(22, Number(edge.target?.r || 24) + 8);
            const sourceInset = Math.max(12, Number(edge.source?.r || 24) + 3);
            return (
            <g key={edge.key} opacity={edge.opacity ?? 1}>
              <path
                className="edge"
                d={projectionEdgePath(edge, { sourceInset, targetInset })}
                stroke={edge.style.color}
                strokeDasharray={edge.style.dash}
                strokeWidth={edge.style.strokeWidth}
              />
              <polygon
                className="edge-arrow"
                points={projectionEdgeArrowPoints(edge, 10, targetInset).map(([x, y]) => `${x},${y}`).join(" ")}
                fill={edge.style.color}
                opacity={edge.arrowOpacity ?? edge.opacity ?? 1}
              />
              {edge.showLabel !== false && !denseGraph && (
                <text className="edge-label" x={(edge.source.x + edge.target.x) / 2} y={(edge.source.y + edge.target.y) / 2 - 6}>
                  {edge.label || humanizeRelationship(edge.type)}
                </text>
              )}
            </g>
          );})}
          {graph.nodes.map((node) => {
            const radius = node.r || (node.selected ? 46 : 32);
            const mediaSrc = node.image || "";
            const hasMedia = Boolean(mediaSrc);
            const labelLines = wrapProjectionText(node.title || node.id || "Untitled", { maxCharsPerLine: node.selected ? 18 : 16 });
            const chipText = node.subtype ? `${node.type || "node"} / ${node.subtype}` : (node.type || "node");
            const typeLabel = node.showType === false ? "" : chipText;
            const longestLabelLine = Math.max(8, ...labelLines.map((line) => line.length));
            const labelWidth = Math.max(72, Math.min(240, longestLabelLine * 8 + 22));
            const labelHeight = Math.max(22, labelLines.length * 14 + 8);
            const typeWidth = Math.max(54, Math.min(132, typeLabel.length * 6.2 + 18));
            const labelY = -radius - labelHeight - 8;
            const typeY = radius + 4;
            const iconLabel = node.style?.projection?.iconLabel || String(node.type || "node").slice(0, 2).toUpperCase();
            const iconAssetSrc = NODE_TYPE_ICON_URLS[node.type || ""];
            const imageRadius = Math.max(8, radius - 7);
            const clipId = `studio-node-clip-${String(node.id || node.key || "node").replace(/[^A-Za-z0-9_-]+/g, "-")}`;
            const nodeId = node.id || node.key;
            const renderLabel = node.showLabel !== false && (!denseGraph || labeledNodeIds.has(nodeId));
            const renderTypeLabel = typeLabel && (!denseGraph || node.selected);
            return (
            <g
              key={node.id || node.key}
              className={`graph-node ${node.selected ? "selected" : ""} distance-${node.distance || 0}`}
              transform={`translate(${node.x} ${node.y})`}
              opacity={node.opacity ?? 1}
              style={{ "--graph-depth-opacity": node.opacity ?? 1 }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onSelect(node.source || node)}
            >
              <title>{node.title || node.id || "Untitled"}</title>
              <circle
                r={radius}
                fill={nodeFill(node)}
                stroke={node.style.outline}
                strokeOpacity={node.strokeOpacity ?? node.opacity ?? 1}
              />
              {hasMedia ? (
                <>
                  <clipPath id={clipId}>
                    <circle r={imageRadius} />
                  </clipPath>
                  <image className="graph-node-media" href={mediaSrc} x={-imageRadius} y={-imageRadius} width={imageRadius * 2} height={imageRadius * 2} preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId})`} />
                </>
              ) : iconAssetSrc ? (
                <image className="graph-node-type-media" href={iconAssetSrc} x={-imageRadius} y={-imageRadius} width={imageRadius * 2} height={imageRadius * 2} preserveAspectRatio="xMidYMid meet" />
              ) : (
                <text className="graph-node-icon" textAnchor="middle" y="8" fill={node.style?.text || "#06131a"}>{iconLabel}</text>
              )}
              {renderLabel && (
                <g className="graph-node-title-chip graph-node-title-chip--top" opacity={node.labelOpacity ?? 1}>
                  <rect x={-labelWidth / 2} y={labelY} width={labelWidth} height={labelHeight} rx="6" />
                  <text className="graph-node-title" textAnchor="middle" y={labelY + 15}>
                    {labelLines.map((line, index) => (
                      <tspan key={`${line}-${index}`} x="0" dy={index === 0 ? 0 : 14}>{line}</tspan>
                    ))}
                  </text>
                </g>
              )}
              {renderTypeLabel && (
                <g className="graph-type-badge" opacity={Math.min(0.76, node.labelOpacity ?? 1)}>
                  <rect x={-typeWidth / 2} y={typeY} width={typeWidth} height="18" rx="9" />
                  <text className="graph-type" textAnchor="middle" y={typeY + 13}>{typeLabel}</text>
                </g>
              )}
            </g>
          );
          })}
        </g>
        <g className="graph-travel-layer" dangerouslySetInnerHTML={{ __html: travelMarkup }} />
      </svg>
      <div className="graph-caption">
        {caption}
      </div>
    </div>
  );
}

function PreviewView({ previewUrl, startPreview, rebuildPreview, stopPreview, logs, compact = false }) {
  if (!previewUrl) {
    return (
      <div className="empty-panel">
        <h2>Hugo preview is not running.</h2>
        <p>Start the local Hugo server and XanaNode will open the site in your default browser.</p>
        <button className="primary" onClick={startPreview}>Start Hugo Preview</button>
      </div>
    );
  }
  return (
    <div className={`preview-shell ${compact ? "compact" : ""}`}>
      <div className="empty-panel preview-status">
        <h2>Hugo preview is running in your browser.</h2>
        <p>
          The server stays live in the background so the Studio canvas can stay focused on the graph and editor.
        </p>
        <div className="preview-actions">
          <button className="primary" onClick={rebuildPreview}>Rebuild Hugo</button>
          <button onClick={stopPreview}>Stop Hugo</button>
        </div>
        <p className="muted">{previewUrl}</p>
      </div>
      {!compact && <div className="preview-debug">
        <div className="panel-title">Preview Logs</div>
        <pre className="preview-log-stream">{logs.length ? logs.join("") : "Waiting for preview activity..."}</pre>
      </div>}
    </div>
  );
}

function HealthView({ status, refreshStatus, onRemoveImport, onToggleMountedNode, onOpenNode, onDuplicateNode }) {
  if (!status) {
    return (
      <div className="empty-panel">
        <h2>No health report yet.</h2>
        <button className="primary" onClick={refreshStatus}>Run Health Check</button>
      </div>
    );
  }
  const health = status.health || {};
  const score = health.score ?? health.health_score ?? "-";
  const issues = health.issues || health.warnings || [];
  const counts = health.counts || {};
  return (
    <div className="health-view">
      <div className="score-card">
        <div className="score">{score}</div>
        <div>Knowledge health</div>
        <small>{counts.suggestions || 0} suggestions, {counts.applied_suggestions || 0} applied</small>
      </div>
      <div className="health-columns">
        <section className="panel-card">
          <div className="panel-title">Issues</div>
          {issues.length ? issues.map((issue, i) => <div className="issue" key={i}>{formatIssue(issue)}</div>) : <p className="muted">No issues reported.</p>}
        </section>
        <section className="panel-card">
          <div className="panel-title">Intertwingle Review</div>
          {status.intake_reviews?.length ? status.intake_reviews.map((review, index) => (
            <details className="issue" key={review.import?.id || index} open={index === 0}>
              {(() => {
                const mountedCount = review.import?.all_nodes?.length || 0;
                const uniqueCount = review.intake?.new_nodes?.length || 0;
                const overlapCount = Math.max(0, mountedCount - uniqueCount);
                const relationshipTouches = review.intake?.relationship_imports?.length || 0;
                const mergeCandidates = review.intake?.merge_candidates?.length || 0;
                const linkSuggestions = review.intake?.autolinks?.length || 0;
                const transclusionSuggestions = review.intake?.transclusions?.length || 0;
                const mostlyOverlap = mountedCount > 0 && uniqueCount === 0;
                return (
                  <>
              <summary>
                <strong>{review.import?.name || review.import?.id || "Mounted substrate"}</strong>
              </summary>
              <div className="mounted-review-stats">
                <div className="mounted-review-stat">
                  <strong>{mountedCount}</strong>
                  <small>mounted nodes</small>
                </div>
                <div className="mounted-review-stat">
                  <strong>{overlapCount}</strong>
                  <small>already represented locally</small>
                </div>
                <div className="mounted-review-stat">
                  <strong>{uniqueCount}</strong>
                  <small>distinct additions</small>
                </div>
                <div className="mounted-review-stat">
                  <strong>{relationshipTouches}</strong>
                  <small>incoming relationships touching local nodes</small>
                </div>
              </div>
              <div className="muted">
                {mergeCandidates} merge candidates, {linkSuggestions} link suggestions, {transclusionSuggestions} transclusion suggestions.
              </div>
              <p className="muted">
                {mostlyOverlap
                  ? "This mounted substrate is currently acting as a reference or comparison layer. Its nodes are still available below to open, hide, or duplicate into your own workspace."
                  : "Mounted nodes stay available even when they overlap partly. Use the list below to open them, hide them, or duplicate specific ones into your own authored workspace."}
              </p>
              <div className="relationship-actions">
                <button type="button" onClick={() => onRemoveImport?.(review.import?.id)}>Remove mounted substrate</button>
              </div>
              {!!review.intake?.new_nodes?.length && (
                <div className="mounted-node-list">
                  <div className="panel-title">Distinct additions from this substrate</div>
                  {review.intake.new_nodes.slice(0, 24).map((item) => (
                    <div className="relationship-chip" key={item.node}>
                      <div className="relationship-chip-main">
                        <strong>{item.title || item.node}</strong>
                        <small>{item.type || "node"}</small>
                      </div>
                      <div className="relationship-chip-actions">
                        <button type="button" onClick={() => onOpenNode?.(item.node)}>Open</button>
                        <button type="button" onClick={() => onDuplicateNode?.(item.node)}>Duplicate into workspace</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {review.import?.disabled_node_ids?.length ? (
                <p className="muted">{review.import.disabled_node_ids.length} node(s) currently hidden from this workspace.</p>
              ) : null}
              <div className="mounted-node-list">
                <div className="panel-title">Mounted nodes in this substrate</div>
                {(review.import?.all_nodes || []).slice(0, 60).map((node) => {
                  const checked = !(review.import?.disabled_node_ids || []).includes(node.id);
                  return (
                    <div className="mounted-node-row" key={node.id}>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => onToggleMountedNode?.(review.import?.id, node.id, event.target.checked)}
                        />
                        <span>
                          <strong>{node.title || node.id}</strong>
                          <small>{node.type || "node"}</small>
                        </span>
                      </label>
                      <div className="relationship-chip-actions">
                        <button type="button" onClick={() => onOpenNode?.(node.id)}>Open</button>
                        <button type="button" onClick={() => onDuplicateNode?.(node.id)}>Duplicate</button>
                      </div>
                    </div>
                  );
                })}
              </div>
                  </>
                );
              })()}
            </details>
          )) : <p className="muted">No mounted substrate intake reviews yet.</p>}
        </section>
        <section className="panel-card">
          <div className="panel-title">Validation</div>
          <pre>{JSON.stringify(status.validation, null, 2)}</pre>
        </section>
      </div>
    </div>
  );
}

function LogView({ logs }) {
  return <pre className="log-view">{logs.length ? logs.join("") : "No preview logs yet."}</pre>;
}

function HelpHint({ title, children, href }) {
  return (
    <details className="help-hint">
      <summary aria-label={`Help: ${title}`}>?</summary>
      <div className="help-popover">
        <strong>{title}</strong>
        <p>{children}</p>
        {href && <a href={href} target="_blank" rel="noreferrer">Open canonical node</a>}
      </div>
    </details>
  );
}

function FieldLabel({ children, helpTitle, help, href }) {
  return (
    <label className="field-label">
      <span>{children}</span>
      {help && <HelpHint title={helpTitle || children} href={href}>{help}</HelpHint>}
    </label>
  );
}

function SelectorChips({ values, selected, emptyLabel, onToggle }) {
  const selectedSet = new Set(selected || []);
  if (!values?.length) return <div className="selector-empty">{emptyLabel}</div>;
  return (
    <div className="selector-chips">
      {values.map((value) => (
        <button
          type="button"
          key={value}
          className={`selector-chip ${selectedSet.has(value) ? "selected" : ""}`}
          onClick={() => onToggle(value)}
        >
          {value}
        </button>
      ))}
    </div>
  );
}

function EditorFold({ title, helpTitle, help, href, defaultOpen = false, children }) {
  return (
    <details className="editor-fold" open={defaultOpen}>
      <summary>
        <span>{title}</span>
        {help && <HelpHint title={helpTitle || title} href={href}>{help}</HelpHint>}
      </summary>
      <div className="editor-fold-body">{children}</div>
    </details>
  );
}

function EditorPanel({ selectedNode, draft, setDraft, nodes, suggestions, addRelationship, startRelationshipLink, duplicateNode, saveNode, deleteNode }) {
  const [relationshipType, setRelationshipType] = useState("related_to");
  const [relationshipCategory, setRelationshipCategory] = useState("all");
  const [relationshipTarget, setRelationshipTarget] = useState("");
  const [relationshipQuery, setRelationshipQuery] = useState("");
  const readOnlyNode = !draft ? selectedNode : null;

  if (!draft && !readOnlyNode) {
    return (
      <div className="editor-empty">
        <h2>No node selected</h2>
        <p>Select a node from the catalog or create a new one.</p>
      </div>
    );
  }

  if (!draft && readOnlyNode) {
    return (
      <div className="editor-empty">
        <h2>{readOnlyNode.title || readOnlyNode.id || "Mounted node"}</h2>
        <p>This node comes from an intertwingled substrate that is currently mounted into your workspace.</p>
        <p>Review it here, then decide whether to keep it mounted, merge it into your local authorship, or remove it later.</p>
        <button className="primary" onClick={duplicateNode}>Duplicate into this workspace</button>
      </div>
    );
  }

  const frontMatter = draft.frontMatter || extractFrontMatterShape(draft);
  const type = frontMatter.type || draft.type || "concept";
  const relationships = Array.isArray(frontMatter.relationships) ? frontMatter.relationships : [];
  const typeDefinition = NODE_TYPES_BY_TYPE[type] || null;
  const allowedSubtypes = typeDefinition?.allowed_subtypes || [];
  const filteredRelationshipDefinitions = relationshipCategory === "all"
    ? RELATIONSHIP_TYPE_DEFINITIONS
    : RELATIONSHIP_TYPE_DEFINITIONS.filter((definition) => definition.category === relationshipCategory);
  const searchedRelationshipDefinitions = filteredRelationshipDefinitions.filter((definition) => {
    const query = relationshipQuery.trim().toLowerCase();
    if (!query) return true;
    return [definition.label, definition.type, definition.category, definition.meaning, definition.inverse]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
  const selectedRelationshipDefinition = RELATIONSHIP_TYPES_BY_TYPE[relationshipType] || null;
  const trailSequence = Array.isArray(frontMatter.nodes) ? frontMatter.nodes : [];
  const availableTrailTargets = nodes.filter((node) => projectionNodeRef(node) !== projectionNodeRef(draft));
  const localNodePath = resolveNodeFilePath(draft);
  const intakeAnalysis = frontMatter.intake_analysis && typeof frontMatter.intake_analysis === "object"
    ? frontMatter.intake_analysis
    : null;

  function updateFrontMatter(key, value) {
    setDraft({ ...draft, frontMatter: { ...frontMatter, [key]: value } });
  }

  function updateSharing(patch) {
    const currentSharing = frontMatter.sharing && typeof frontMatter.sharing === "object" ? frontMatter.sharing : {};
    updateFrontMatter("sharing", { ...currentSharing, ...patch });
  }

  function updateListFrontMatter(key, value) {
    updateFrontMatter(key, value.split(",").map((item) => item.trim()).filter(Boolean));
  }

  function toggleListFrontMatter(key, value) {
    const current = Array.isArray(frontMatter[key]) ? frontMatter[key] : [];
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value];
    updateFrontMatter(key, next);
  }

  function updateRelationship(index, patch) {
    const next = relationships.map((relationship, relationshipIndex) => (
      relationshipIndex === index ? { ...relationship, ...patch } : relationship
    ));
    updateFrontMatter("relationships", next);
  }

  function removeRelationship(index) {
    updateFrontMatter("relationships", relationships.filter((_, relationshipIndex) => relationshipIndex !== index));
  }

  function updateTrailSequence(nextSequence) {
    updateFrontMatter("nodes", nextSequence.filter(Boolean));
  }

  function addTrailNode(target) {
    if (!target) return;
    if (trailSequence.includes(target)) return;
    updateTrailSequence([...trailSequence, target]);
  }

  function moveTrailNode(index, direction) {
    const next = [...trailSequence];
    const swapIndex = index + direction;
    if (swapIndex < 0 || swapIndex >= next.length) return;
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
    updateTrailSequence(next);
  }

  function removeTrailNode(index) {
    updateTrailSequence(trailSequence.filter((_, itemIndex) => itemIndex !== index));
  }

  function applyIntakeSuggestedType() {
    if (!intakeAnalysis?.suggested_type) return;
    updateFrontMatter("type", intakeAnalysis.suggested_type);
  }

  function applyIntakeSuggestedSummary() {
    if (!intakeAnalysis?.suggested_summary) return;
    updateFrontMatter("summary", intakeAnalysis.suggested_summary);
  }

  function applyIntakeMentionRelationships() {
    const next = [...relationships];
    for (const suggestion of intakeAnalysis?.mention_relationships || []) {
      if (!suggestion?.target) continue;
      const exists = next.some((relationship) => relationship.type === (suggestion.type || "mentions") && relationship.target === suggestion.target);
      if (exists) continue;
      next.push({
        type: suggestion.type || "mentions",
        target: suggestion.target,
        summary: suggestion.summary || "This imported text mentions an existing node."
      });
    }
    updateFrontMatter("relationships", next);
  }

  return (
    <div className="editor-panel">
      <div className="panel-row sticky-editor-head">
        <div className="editor-head-copy">
          <div className="panel-title">Node Editor</div>
          <div className="editor-id">{frontMatter.id || draft.id || draft.relativePath || "new node"}</div>
        </div>
        <div className="panel-actions panel-actions-primary">
          <button className="primary" onClick={saveNode}>Save Node</button>
        </div>
      </div>

      <section className="editor-group">
        <FieldLabel help="The name people see first. Keep it human: a person, question, claim, source, place, event, or thing someone can point to." href={canonicalHelpUrl("property", "title")}>Title</FieldLabel>
        <input value={frontMatter.title || ""} onChange={(e) => updateFrontMatter("title", e.target.value)} />

        <FieldLabel help="A node type says what kind of thing this is. Studio reads these from the protocol registry, so the choices stay aligned with Core and Hugo." href={canonicalHelpUrl("node-type", type)}>Type</FieldLabel>
        <select value={type} onChange={(e) => updateFrontMatter("type", e.target.value)}>
          {NODE_TYPE_DEFINITIONS.map((nodeType) => (
            <option value={nodeType.type} key={nodeType.type}>{nodeType.label} ({nodeType.type})</option>
          ))}
        </select>
        {typeDefinition?.purpose && <p className="field-help">{typeDefinition.purpose}</p>}

        <FieldLabel help="A short human sentence that tells readers why this node exists. If the graph only showed this line, it should still make sense." href={canonicalHelpUrl("property", "summary")}>Summary</FieldLabel>
        <textarea rows={3} value={frontMatter.summary || ""} onChange={(e) => updateFrontMatter("summary", e.target.value)} />

        <FieldLabel help="The authored prose for this node. Relationships, sources, and transclusions should carry the structure around it instead of forcing everything into text." href={canonicalHelpUrl("property", "content")}>Content</FieldLabel>
        <textarea className="body-editor" value={draft.body || ""} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
      </section>

      <EditorFold
        title="Classification"
        helpTitle="Classification"
        help="Subtype and facets are useful, but they are there to sharpen the node after the main type and summary are right."
        href={canonicalHelpUrl("property", "subtype")}
      >
        <FieldLabel help="A subtype narrows the main type without inventing a whole new category. For example, a person can be a writer, researcher, maintainer, or witness." href={canonicalHelpUrl("property", "subtype")}>Subtype</FieldLabel>
        <select value={frontMatter.subtype || ""} onChange={(e) => updateFrontMatter("subtype", e.target.value || undefined)}>
          <option value="">No subtype</option>
          {allowedSubtypes.map((subtype) => <option value={subtype} key={subtype}>{subtype}</option>)}
          {frontMatter.subtype && !allowedSubtypes.includes(frontMatter.subtype) && <option value={frontMatter.subtype}>{frontMatter.subtype}</option>}
        </select>

        <FieldLabel help="Use additional subtypes when the node legitimately wears more than one narrower role. This is not a replacement for relationships." href={canonicalHelpUrl("property", "subtypes")}>Additional subtypes</FieldLabel>
        <SelectorChips
          values={allowedSubtypes}
          selected={frontMatter.subtypes || []}
          emptyLabel={allowedSubtypes.length ? "Choose any additional subtypes" : "No protocol subtypes for this type yet"}
          onToggle={(value) => toggleListFrontMatter("subtypes", value)}
        />

        <FieldLabel help="Facets are secondary lenses for filtering and authoring. They help say, for example, that a quote can behave like evidence, a claim, and a source fragment." href={canonicalHelpUrl("property", "facets")}>Facets</FieldLabel>
        <SelectorChips
          values={NODE_TYPES}
          selected={frontMatter.facets || []}
          emptyLabel="Choose secondary node roles"
          onToggle={(value) => toggleListFrontMatter("facets", value)}
        />
      </EditorFold>

      <EditorFold
        title="Publishing and Privacy"
        helpTitle="Authoring State"
        help="Draft keeps a node out of normal builds unless drafts are explicitly included. Shareable controls whether this node is exported into public protocol artifacts by default."
        href={canonicalHelpUrl("concept", "federated-knowledge-substrates")}
      >
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={Boolean(frontMatter.draft)}
            onChange={(event) => updateFrontMatter("draft", event.target.checked || undefined)}
          />
          <span>
            <strong>Draft only</strong>
            <small>Keep this node local to working builds until you choose to publish it.</small>
          </span>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={frontMatter.sharing?.shareable !== false}
            onChange={(event) => updateSharing({
              shareable: event.target.checked,
              scope: event.target.checked ? (frontMatter.sharing?.scope || "public") : "private"
            })}
          />
          <span>
            <strong>Share in exported .substrate files</strong>
            <small>Turn this off for private or local-only nodes.</small>
          </span>
        </label>
        <FieldLabel help="Scope is the export intent for this node. Public nodes ship by default. Private nodes stay local unless you explicitly include private content." href={canonicalHelpUrl("property", "sharing")}>Sharing scope</FieldLabel>
        <select
          value={frontMatter.sharing?.scope || (frontMatter.sharing?.shareable === false ? "private" : "public")}
          onChange={(event) => updateSharing({
            scope: event.target.value,
            shareable: event.target.value !== "private"
          })}
        >
          <option value="public">Public</option>
            <option value="private">Private</option>
            <option value="restricted">Restricted</option>
          </select>
      </EditorFold>

      {intakeAnalysis && (
        <EditorFold
          title="Intake Analysis"
          helpTitle="Intake Analysis"
          help="Core inspected imported text and looked for a likely summary, likely extracted type, existing node mentions, link candidates, and possible transclusions."
          href={canonicalHelpUrl("concept", "xananode")}
        >
          {intakeAnalysis.suggested_type && intakeAnalysis.suggested_type !== type && (
            <div className="relationship-definition">
              <span className="pill">Suggested type</span>
              <p>{intakeAnalysis.suggested_type}</p>
              <div className="relationship-actions">
                <button type="button" onClick={applyIntakeSuggestedType}>Use suggested type</button>
              </div>
            </div>
          )}
          {intakeAnalysis.suggested_summary && intakeAnalysis.suggested_summary !== (frontMatter.summary || "") && (
            <div className="relationship-definition">
              <span className="pill">Suggested summary</span>
              <p>{intakeAnalysis.suggested_summary}</p>
              <div className="relationship-actions">
                <button type="button" onClick={applyIntakeSuggestedSummary}>Use suggested summary</button>
              </div>
            </div>
          )}
          {!!intakeAnalysis.mention_relationships?.length && (
            <div className="relationship-definition">
              <span className="pill">Mention relationships</span>
              <p>{intakeAnalysis.mention_relationships.length} existing node mention{intakeAnalysis.mention_relationships.length === 1 ? "" : "s"} detected from imported text.</p>
              <div className="relationship-actions">
                <button type="button" onClick={applyIntakeMentionRelationships}>Add mention relationships</button>
              </div>
            </div>
          )}
          {!!intakeAnalysis.link_suggestions?.length && (
            <div className="muted">{intakeAnalysis.link_suggestions.length} link candidate{intakeAnalysis.link_suggestions.length === 1 ? "" : "s"} detected.</div>
          )}
          {!!intakeAnalysis.transclusion_suggestions?.length && (
            <div className="muted">{intakeAnalysis.transclusion_suggestions.length} transclusion candidate{intakeAnalysis.transclusion_suggestions.length === 1 ? "" : "s"} detected.</div>
          )}
        </EditorFold>
      )}

      {type === "trail" && (
        <section className="editor-section">
          <div className="panel-row">
            <div className="panel-title">Trail Sequence</div>
            <HelpHint title="Trail Sequence" href={canonicalHelpUrl("concept", "trail")}>
              Trails are ordered paths. Pick the nodes in sequence and Studio will keep the trail structure aligned when you save.
            </HelpHint>
          </div>
          <div className="relationship-form">
            <select value={relationshipTarget} onChange={(e) => setRelationshipTarget(e.target.value)}>
              <option value="">Choose node for trail</option>
              {availableTrailTargets.map((node) => <option value={projectionNodeRef(node)} key={`trail-${nodeKey(node)}`}>{node.title || node.id}</option>)}
            </select>
            <button
              type="button"
              disabled={!relationshipTarget}
              onClick={() => {
                addTrailNode(relationshipTarget);
                setRelationshipTarget("");
              }}
            >
              Add to trail
            </button>
          </div>
          {trailSequence.length ? (
            <div className="trail-sequence-list">
              {trailSequence.map((target, index) => {
                const targetNode = findWorkspaceNode(target, nodes);
                return (
                  <div className="relationship-chip" key={`${target}-${index}`}>
                    <div className="relationship-chip-main">
                      <strong>{index + 1}. {targetNode?.title || target}</strong>
                      <small>{targetNode?.type || ""}</small>
                    </div>
                    <div className="relationship-chip-actions">
                      <button type="button" onClick={() => moveTrailNode(index, -1)} disabled={index === 0}>Up</button>
                      <button type="button" onClick={() => moveTrailNode(index, 1)} disabled={index === trailSequence.length - 1}>Down</button>
                      <button type="button" onClick={() => removeTrailNode(index)}>Remove</button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted">This trail is empty. Add nodes in the order you want readers to follow them.</p>
          )}
        </section>
      )}

      <section className="editor-section">
        <div className="panel-row">
          <div className="panel-title">Relationships</div>
          <HelpHint title="Relationships" href={canonicalHelpUrl("concept", "typed-relationships")}>
            Relationships say why two nodes belong together. Pick the meaning first, then choose a target or click two nodes on the graph.
          </HelpHint>
        </div>
        <div className="relationship-catalog">
          <div className="relationship-filters">
            <select value={relationshipCategory} onChange={(e) => {
            const nextCategory = e.target.value;
            setRelationshipCategory(nextCategory);
            const nextDefinition = nextCategory === "all"
              ? RELATIONSHIP_TYPE_DEFINITIONS[0]
              : RELATIONSHIP_TYPE_DEFINITIONS.find((definition) => definition.category === nextCategory);
            if (nextDefinition && nextCategory !== "all" && RELATIONSHIP_TYPES_BY_TYPE[relationshipType]?.category !== nextCategory) {
              setRelationshipType(nextDefinition.type);
            }
          }}>
            <option value="all">All categories</option>
            {RELATIONSHIP_CATEGORIES.map((category) => <option value={category} key={category}>{category}</option>)}
          </select>
            <input value={relationshipQuery} onChange={(e) => setRelationshipQuery(e.target.value)} placeholder="Search relationship meanings" />
          </div>
          <div className="relationship-type-list">
            {searchedRelationshipDefinitions.slice(0, 24).map((definition) => (
              <button
                type="button"
                className={`relationship-type-option ${relationshipType === definition.type ? "selected" : ""}`}
                key={definition.type}
                onClick={() => setRelationshipType(definition.type)}
                title={definition.meaning}
              >
                <span>{definition.label}</span>
                <small>{definition.type}</small>
              </button>
            ))}
          </div>
        </div>
        {selectedRelationshipDefinition && (
          <div className="relationship-definition">
            <span className="pill">{selectedRelationshipDefinition.category}</span>
            <span>Inverse: {selectedRelationshipDefinition.inverse || "none"}</span>
            <p>{selectedRelationshipDefinition.meaning}</p>
            <div className="relationship-actions">
              <button type="button" onClick={() => startRelationshipLink(relationshipType)}>Click two graph nodes</button>
              <a href={canonicalHelpUrl("relationship-type", relationshipType)} target="_blank" rel="noreferrer">Canonical node</a>
            </div>
          </div>
        )}
        <div className="relationship-form">
          <select value={relationshipTarget} onChange={(e) => setRelationshipTarget(e.target.value)}>
            <option value="">Choose target</option>
            {nodes.map((node) => <option value={projectionNodeRef(node)} key={nodeKey(node)}>{node.title || node.id}</option>)}
          </select>
          <button disabled={!relationshipTarget} onClick={() => {
            addRelationship(relationshipType, relationshipTarget);
            setRelationshipTarget("");
          }}>Add</button>
        </div>
        {relationships.length ? relationships.map((rel, i) => (
          <div className="relationship-chip" key={i}>
            <div className="relationship-chip-main">
              <select
                value={rel.type || "related_to"}
                onChange={(event) => updateRelationship(i, { type: event.target.value })}
                aria-label="Relationship type"
              >
                {RELATIONSHIP_TYPE_DEFINITIONS.map((definition) => (
                  <option value={definition.type} key={definition.type}>{definition.label} ({definition.type})</option>
                ))}
              </select>
              <span>{" -> "} {rel.target || rel.to || "unknown"}</span>
            </div>
            <div className="relationship-chip-actions">
              {RELATIONSHIP_TYPES_BY_TYPE[rel.type]?.inverse && (
                <button type="button" onClick={() => updateRelationship(i, { type: RELATIONSHIP_TYPES_BY_TYPE[rel.type].inverse })}>
                  Use inverse
                </button>
              )}
              <button type="button" className="danger" onClick={() => removeRelationship(i)}>Remove</button>
            </div>
            {RELATIONSHIP_TYPES_BY_TYPE[rel.type]?.inverse && <small>Inverse type: {RELATIONSHIP_TYPES_BY_TYPE[rel.type].inverse}</small>}
          </div>
        )) : <p className="muted">No relationships yet.</p>}
      </section>

      <EditorFold title={`Suggestions${suggestions.length ? ` (${suggestions.length})` : ""}`} defaultOpen={false}>
        {suggestions.length ? suggestions.map((suggestion, i) => (
          <button className="suggestion" key={i} onClick={() => suggestion.action?.()}>{suggestion.text}</button>
        )) : <p className="muted">No suggestions right now.</p>}
      </EditorFold>

      <EditorFold title="Node Actions" defaultOpen={false}>
        <div className="panel-actions panel-actions-secondary">
          <button onClick={duplicateNode}>Duplicate</button>
          {localNodePath && <button className="danger" onClick={deleteNode}>Remove Node</button>}
        </div>
      </EditorFold>
    </div>
  );
}

function groupNodes(nodes, mode) {
  const groups = {};
  for (const node of nodes) {
    let key = node.type || "node";
    if (mode === "subtype") key = node.subtype || node.subtypes?.[0] || "no subtype";
    if (mode === "facet") key = node.facets?.[0] || "no facet";
    if (mode === "author") key = node.created_by || node.author || "unknown author";
    if (mode === "status") key = node.status || "draft/unknown";
    if (!groups[key]) groups[key] = [];
    groups[key].push(node);
  }
  return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)));
}

function canonicalHelpUrl(kind, id) {
  const cleanId = String(id || "").trim();
  if (!cleanId) return "https://xananode.com/";
  if (kind === "node-type") return `https://xananode.com/schema/xananode.canonical%3Aschema/node-type-${encodeURIComponent(cleanId)}/`;
  if (kind === "relationship-type") return `https://xananode.com/schema/xananode.canonical%3Aschema/relationship-type-${encodeURIComponent(cleanId)}/`;
  if (kind === "property") return `https://xananode.com/schema/xananode.canonical%3Aschema/property-${encodeURIComponent(cleanId)}/`;
  if (kind === "concept") return `https://xananode.com/concept/${encodeURIComponent(cleanId)}/`;
  return "https://xananode.com/";
}

function isCanonicalWorkspace(workspace) {
  const manifest = workspace?.manifest || {};
  const text = [
    manifest.id,
    manifest.name,
    manifest.namespace,
    manifest.substrate_id,
    workspace?.rootDir
  ].filter(Boolean).join(" ").toLowerCase();
  return text.includes("xananode.canonical") || text.includes("canonical xananode") || text.includes("xananode canonical");
}

function isWorkingCopyWorkspace(workspace) {
  return workspace?.settings?.mode === "working_copy" || Boolean(workspace?.manifest?.source_pack);
}

function relationshipLabel(type) {
  const definition = RELATIONSHIP_TYPES_BY_TYPE[type];
  return definition ? `${definition.label} (${definition.type})` : type || "related_to";
}

function buildLocalGraph(nodes, current, maxDepth = 1) {
  const projectedNodes = nodes.map((node) => ({
    ...node,
    id: projectionNodeRef(node),
    source: node
  }));
  const focusId = projectionNodeRef(current) || projectedNodes[0]?.id || "";
  const relationships = relationshipsFromProjectionNodes(projectedNodes);
  const neighborhood = buildHopNeighborhood(projectedNodes, relationships, {
    focusId,
    maxDepth,
    edgeScore: (edge) => scoreGraphEdge(edge, projectedNodes, focusId)
  });
  const graph = layoutReadableProjection(neighborhood, {
    focusId,
    registry: GRAPH_PROJECTION_REGISTRY,
    width: 900,
    height: 620,
    maxDepth,
    labelForEdge: (edge) => humanizeRelationship(edge.type || "related_to")
  });
  return {
    ...graph,
    hasVisibleEdges: graph.edges.length > 0
  };
}

function buildEffectiveGraphNodes(nodes, draft, selectedNode) {
  const baseNodes = Array.isArray(nodes) ? [...nodes] : [];
  if (!draft) return baseNodes;

  const draftNode = {
    ...draft,
    ...extractFrontMatterShape(draft),
    body: draft.body || draft.content || "",
    frontMatter: draft.frontMatter || extractFrontMatterShape(draft)
  };
  const draftRef = projectionNodeRef(draftNode);
  const selectedRef = projectionNodeRef(selectedNode);
  const replaceIndex = baseNodes.findIndex((node) => {
    const nodeRef = projectionNodeRef(node);
    return nodeRef && (nodeRef === draftRef || nodeRef === selectedRef || nodeKey(node) === nodeKey(draftNode));
  });

  if (replaceIndex >= 0) {
    baseNodes.splice(replaceIndex, 1, {
      ...baseNodes[replaceIndex],
      ...draftNode,
      id: baseNodes[replaceIndex].id || draftNode.id
    });
    return baseNodes;
  }

  return [...baseNodes, draftNode];
}

const DEFAULT_GRAPH_VIEWPORT = { x: 0, y: 0, scale: 1 };

function fitGraphViewport(nodes) {
  if (!nodes?.length) return DEFAULT_GRAPH_VIEWPORT;
  const readableNodes = nodes.filter((node) => node.selected || Number(node.distance || 0) <= 1);
  return fitReadableProjectionViewport(readableNodes.length ? readableNodes : nodes, {
    padding: 86,
    width: 900,
    height: 620,
    maxScale: 1.45,
    minScale: 0.66
  });
}

function scaleGraphViewport(viewport, factor) {
  return {
    ...viewport,
    scale: clamp((viewport.scale || 1) * factor, 0.32, 3)
  };
}

function describeGraphDensity(graph = {}) {
  const edgeCount = Array.isArray(graph.edges) ? graph.edges.length : 0;
  const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
  const incidentCounts = new Map();
  for (const edge of graph.edges || []) {
    incidentCounts.set(edge.source?.id, (incidentCounts.get(edge.source?.id) || 0) + 1);
    incidentCounts.set(edge.target?.id, (incidentCounts.get(edge.target?.id) || 0) + 1);
  }
  const maxIncident = Math.max(0, ...incidentCounts.values(), 0);
  const dense = edgeCount >= 120 || nodeCount >= 140 || maxIncident >= 70;
  return {
    mode: dense ? "dense" : "normal",
    edgeCount,
    nodeCount,
    maxIncident,
    incidentCounts
  };
}

function selectVisibleGraphLabels(graph = {}, options = {}) {
  const dense = options.dense === true;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  if (!dense) {
    return new Set(nodes.map((node) => node.id || node.key).filter(Boolean));
  }
  const incidentCounts = describeGraphDensity(graph).incidentCounts;
  const ranked = [...nodes]
    .sort((a, b) => {
      const aSelected = a.selected ? 1 : 0;
      const bSelected = b.selected ? 1 : 0;
      if (aSelected !== bSelected) return bSelected - aSelected;
      const aDistance = Number(a.distance || 0);
      const bDistance = Number(b.distance || 0);
      if (aDistance !== bDistance) return aDistance - bDistance;
      const aIncident = incidentCounts.get(a.id) || 0;
      const bIncident = incidentCounts.get(b.id) || 0;
      if (aIncident !== bIncident) return bIncident - aIncident;
      return Number(b.importance || 0) - Number(a.importance || 0);
    });
  const visible = new Set();
  for (const node of ranked) {
    if (node.selected) visible.add(node.id || node.key);
  }
  for (const node of ranked) {
    const id = node.id || node.key;
    if (!id) continue;
    if (Number(node.distance || 0) <= 1 && visible.size < 24) visible.add(id);
    if (visible.size >= 24) break;
  }
  return visible;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nodeFill(node) {
  const colors = node.style?.fills || [];
  if (colors.length > 1) return `url(#${nodeGradientId(node)})`;
  return colors[0] || "rgba(21, 25, 34, 0.96)";
}

function nodeGradientId(node) {
  return `node-gradient-${String(node?.key || "node").replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

function humanizeRelationship(value) {
  return String(value || "related_to").replace(/_/g, " ");
}

function scoreGraphEdge(edge, nodes, focusId) {
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  const sourceImportance = Number(source?.importance || 3);
  const targetImportance = Number(target?.importance || 3);
  const weight = Number(edge.weight || 1);
  const relationshipPriority = {
    defines: 10,
    created: 9,
    created_by: 9,
    participated_in: 8,
    originated_by: 9,
    coined: 9,
    represented_by: 9,
    used_as_primary_media_for: 9,
    depicts: 9,
    authored: 8,
    features: 8,
    featured_in: 8,
    presented: 8,
    presented_by: 8,
    proposed: 7,
    demonstrates: 7,
    demonstrated_by: 7,
    explains: 7,
    explained_by: 7,
    context_for: 6,
    documents: 6,
    extends: 6,
    supports: 6,
    supported_by: 6,
    contrasts: 6,
    depends_on: 6,
    exposes: 6,
    anticipates: 6,
    contains: 6,
    includes: 6,
    uses: 5,
    used_by: 5,
    cites: 5,
    related_to: 4,
    related: 3,
    mentions: 1,
    unresolved_media: 1
  };
  const typePriority = relationshipPriority[edge.type] || 3;
  const directBonus = edge.source === focusId || edge.target === focusId ? 20 : 0;
  const explicitBonus = edge.origin === "relationship" ? 8 : 0;
  const visibilityBonus = edge.visibility === "primary" ? 5 : edge.visibility === "secondary" ? 2 : 0;
  return directBonus + explicitBonus + visibilityBonus + weight * 10 + typePriority + sourceImportance + targetImportance;
}

function trimLabel(value, max) {
  const text = String(value || "Untitled");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}...` : text;
}

function projectionNodeRef(node) {
  return normalizeNodeRef(
    node?.protocolId
    || node?.protocol_id
    || node?.frontMatter?.protocol_id
    || node?.data?.protocol_id
    || node?.id
    || node?.slug
    || node?.title
    || ""
  );
}

function makeDraft(node) {
  if (!node) return null;
  return {
    ...node,
    frontMatter: extractFrontMatterShape(node),
    body: node.body || node.content || `# ${node.title || "Untitled"}\n\n`,
    relativePath: node.relativePath || node.path || node.filePath || node.__file
  };
}

function extractFrontMatterShape(node) {
  const ignored = new Set(["body", "content", "frontMatter", "relativePath", "path", "filePath", "__file", "data", "fullPath", "raw"]);
  const result = { ...(node?.data || {}) };
  for (const [key, value] of Object.entries(node || {})) {
    if (!ignored.has(key)) result[key] = value;
  }
  if (node?.protocolId && !result.protocol_id) result.protocol_id = node.protocolId;
  if (node?.protocol_id && !result.protocol_id) result.protocol_id = node.protocol_id;
  if (!result.relationships) result.relationships = [];
  return result;
}

function normalizeFrontMatterForSave(frontMatter = {}) {
  const next = { ...frontMatter };
  if (next.type === "trail") {
    const sequence = Array.isArray(next.nodes) ? next.nodes.filter(Boolean) : [];
    const otherRelationships = Array.isArray(next.relationships)
      ? next.relationships.filter((relationship) => !["starts_with", "continues_to"].includes(relationship?.type))
      : [];
    const trailRelationships = [];
    if (sequence[0]) {
      trailRelationships.push({
        type: "starts_with",
        target: sequence[0],
        summary: "This trail begins here."
      });
    }
    for (let index = 1; index < sequence.length; index += 1) {
      trailRelationships.push({
        type: "continues_to",
        target: sequence[index],
        summary: "This trail continues to the next node."
      });
    }
    next.relationships = [...otherRelationships, ...trailRelationships];
  }
  return next;
}

function getSuggestions(node, nodes) {
  if (!node) return [];
  const fm = node.frontMatter || extractFrontMatterShape(node);
  const text = `${fm.title || ""} ${fm.summary || ""} ${node.body || ""}`.toLowerCase();
  const suggestions = [];
  const relationships = fm.relationships || [];
  if (fm.type === "claim" && !relationships.some((rel) => ["supports", "evidence_for", "derived_from"].includes(rel.type))) {
    suggestions.push({ text: "This claim probably needs evidence or a source." });
  }
  const matches = nodes
    .filter((candidate) => candidate.title && candidate.title !== fm.title && text.includes(String(candidate.title).toLowerCase()))
    .slice(0, 5);
  for (const match of matches) suggestions.push({ text: `Mention detected: link to ${match.title}` });
  if (!fm.summary) suggestions.push({ text: "Add a short summary so the published site can explain this node." });
  if (!relationships.length) suggestions.push({ text: "This node is isolated. Add at least one relationship." });
  return suggestions;
}

function suggestSnapshotMessage(workspace, draft) {
  if (draft?.frontMatter?.title) return `Updated ${draft.frontMatter.title}`;
  return `Updated ${workspace?.manifest?.name || "XanaNode substrate"}`;
}

function findWorkspaceNode(nodeId, nodes) {
  const target = normalizeNodeRef(nodeId);
  if (!target) return null;
  return nodes.find((node) => {
    const candidates = [
      node.id,
      node.protocolId,
      node.protocol_id,
      node.slug,
      node.title,
      node.relativePath,
      node.path,
      node.filePath,
      node.frontMatter?.id,
      node.frontMatter?.slug,
      node.frontMatter?.node_id,
      node.frontMatter?.protocol_id,
      node.data?.id,
      node.data?.slug,
      node.data?.node_id,
      node.data?.protocol_id
    ].filter(Boolean).map(normalizeNodeRef);
    return candidates.includes(target);
  }) || null;
}

function normalizeNodeRef(value) {
  return String(value || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/^node\//i, "")
    .toLowerCase();
}

function isPreviewHelperNodeId(value) {
  const normalized = normalizeNodeRef(value);
  return /^layer\d+/.test(normalized) || normalized.endsWith("-selectbox") || normalized.startsWith("cy-");
}

function nodeKey(node) {
  return node?.id || node?.slug || node?.relativePath || node?.path || node?.filePath || node?.title || Math.random().toString(36);
}

function formatIssue(issue) {
  if (typeof issue === "string") return issue;
  return issue.message || issue.summary || JSON.stringify(issue);
}

function formatBuildLabel(metadata = {}) {
  const version = metadata.version ? `v${metadata.version}` : "unversioned";
  const commit = metadata.git_commit ? metadata.git_commit.slice(0, 7) : "";
  const built = metadata.built_at && metadata.built_at !== "1970-01-01T00:00:00.000Z"
    ? new Date(metadata.built_at).toLocaleDateString()
    : "";
  return [version, commit, built].filter(Boolean).join(" · ");
}

function bustPreviewUrl(value) {
  try {
    const url = new URL(value);
    url.searchParams.set("studio_refresh", String(Date.now()));
    return url.toString();
  } catch (_) {
    const separator = String(value || "").includes("?") ? "&" : "?";
    return `${value}${separator}studio_refresh=${Date.now()}`;
  }
}

function createUnavailableApi() {
  const unavailable = async () => ({
    ok: false,
    error: "Desktop workspace actions are available in the Electron app."
  });
  return {
    appMetadata: unavailable,
    openWorkspace: unavailable,
    openSubstrateFile: unavailable,
    openSubstrateFolder: unavailable,
    intertwingleSubstrate: unavailable,
    openPack: unavailable,
    createWorkspace: unavailable,
    refreshWorkspace: unavailable,
    workspaceStatus: unavailable,
    createNode: unavailable,
    updateNode: unavailable,
    openWorkspaceAtPath: unavailable,
    planNodeDeletion: unavailable,
    deleteNode: unavailable,
    importAssets: unavailable,
    saveSnapshot: unavailable,
    build: unavailable,
    exportSubstrate: unavailable,
    exportPack: unavailable,
    removeImport: unavailable,
    toggleImportNodeVisibility: unavailable,
    listFederationTargets: unavailable,
    openFederationTarget: unavailable,
    validate: unavailable,
    openInShell: unavailable,
    startHugoPreview: unavailable,
    rebuildHugoPreview: unavailable,
    stopHugoPreview: unavailable,
    readTextFile: unavailable,
    onPreviewLog: () => {},
    onPreviewStopped: () => {},
    onStudioCommand: () => {},
    onWorkspaceProgress: () => {}
  };
}

function loadRecentWorkspaces() {
  try {
    const raw = window.localStorage.getItem("xananode.recentWorkspaces");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
  } catch {
    return [];
  }
}

function saveRecentWorkspaces(items) {
  try {
    window.localStorage.setItem("xananode.recentWorkspaces", JSON.stringify(items.slice(0, 8)));
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

function refreshRecentWorkspace(items, workspace) {
  const next = normalizeRecentWorkspace(workspace);
  if (!next) return items;
  const filtered = (items || []).filter((item) => item.rootDir !== next.rootDir);
  const nextItems = [next, ...filtered].slice(0, 8);
  saveRecentWorkspaces(nextItems);
  return nextItems;
}

function rememberRecentWorkspace(workspace, setRecentWorkspaces) {
  if (!workspace?.rootDir) return;
  setRecentWorkspaces((items) => refreshRecentWorkspace(items, workspace));
}

function clearRecentWorkspaces() {
  try {
    window.localStorage.removeItem("xananode.recentWorkspaces");
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

function normalizeRecentWorkspace(workspace) {
  if (!workspace?.rootDir) return null;
  return {
    rootDir: workspace.rootDir,
    name: workspace.manifest?.name || workspace.manifest?.id || pathBaseName(workspace.rootDir),
    manifestName: workspace.manifest?.name || workspace.manifest?.id || "",
    updatedAt: Date.now()
  };
}

function pathBaseName(target) {
  const clean = String(target || "").replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).filter(Boolean).pop() || clean || "";
}

function resolveWorkspaceRootDir(result) {
  return result?.workspace?.rootDir || result?.rootDir || result?.workspace?.manifest?.rootDir || null;
}

function formatDeletionWarning(plan) {
  if (!plan?.target) return "Remove this node from the open substrate?";
  const lines = [
    `Remove "${plan.target.title || plan.target.id}" from this substrate?`
  ];
  if (Array.isArray(plan.warnings) && plan.warnings.length) {
    lines.push("");
    lines.push(...plan.warnings.map((warning) => `- ${warning}`));
  }
  if (Array.isArray(plan.affected_nodes) && plan.affected_nodes.length) {
    lines.push("");
    lines.push(`Affected nodes: ${plan.affected_nodes.slice(0, 6).map((entry) => entry.node?.title || entry.node?.id).join(", ")}${plan.affected_nodes.length > 6 ? `, and ${plan.affected_nodes.length - 6} more` : ""}`);
  }
  lines.push("");
  lines.push("This will remove the node and clean up local relationships and trail references that point to it.");
  return lines.join("\n");
}

function resolveNodeFilePath(node) {
  return node?.relativePath
    || node?.relativeFile
    || node?.path
    || node?.filePath
    || node?.__file
    || node?.frontMatter?.relativePath
    || node?.frontMatter?.relativeFile
    || node?.frontMatter?.path
    || node?.frontMatter?.filePath
    || node?.frontMatter?.__file
    || null;
}

createRoot(document.getElementById("root")).render(<App />);
