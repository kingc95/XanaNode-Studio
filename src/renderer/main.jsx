import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import nodeTypeRegistry from "../../vendor/xananode-core/vendor/xananode-protocol/schemas/xananode-node-types.v0.3.0.json";
import relationshipTypeRegistry from "../../vendor/xananode-core/vendor/xananode-protocol/schemas/xananode-relationship-types.v0.5.0.json";
import xananodeIconUrl from "../../vendor/xananode-core/vendor/xananode-protocol/media/images/xananode-icon.svg";
import {
  buildReadableTravelOverlayMarkup,
  buildViewerTravelPlan,
  buildViewerGraphModel,
  createProjectionRegistry,
  describeViewerGraphDensity,
  fitReadableProjectionViewport,
  projectionEdgeArrowPoints,
  projectionEdgePath,
  relationshipsFromProjectionNodes,
  scoreViewerEdge,
  selectViewerLabeledNodes,
  wrapProjectionText
} from "../../vendor/xananode-core/src/index.js";
import buildMetadata from "../generated/build-metadata.json";
import "./styles/app.css";

const NODE_TYPE_DEFINITIONS = [...nodeTypeRegistry.node_types].sort((a, b) => a.label.localeCompare(b.label));
const NODE_TYPES = NODE_TYPE_DEFINITIONS.map((definition) => definition.type);
const NODE_TYPES_BY_TYPE = Object.fromEntries(NODE_TYPE_DEFINITIONS.map((definition) => [definition.type, definition]));
const NODE_TYPE_ORDER = new Map(NODE_TYPE_DEFINITIONS.map((definition, index) => [definition.type, index]));
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
const RESERVED_FRONTMATTER_KEYS = new Set([
  "id",
  "protocol_id",
  "protocolId",
  "namespace",
  "title",
  "type",
  "summary",
  "subtype",
  "subtypes",
  "facets",
  "relationships",
  "nodes",
  "branches",
  "trail_nodes",
  "trail_branches",
  "draft",
  "sharing",
  "importance",
  "created_by",
  "created_at",
  "updated_at",
  "primary_media",
  "primary_media_node",
  "media_type",
  "mime_type",
  "asset_path",
  "asset_role",
  "url",
  "file",
  "source_node_id",
  "source_pack_id",
  "source_file",
  "content_id",
  "version_id",
  "signature",
  "slug",
  "relativeFile",
  "relativePath",
  "path",
  "filePath",
  "__file",
  "fullPath",
  "readOnly",
  "mounted",
  "workspace_copy_status",
  "imported",
  "imported_from",
  "pack_id",
  "pack_mode",
  "intake_analysis"
]);

function App() {
  const [workspace, setWorkspace] = useState(null);
  const [status, setStatus] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [draft, setDraft] = useState(null);
  const [notice, setNotice] = useState(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [intertwingleOpen, setIntertwingleOpen] = useState(false);
  const [intakeChooserOpen, setIntakeChooserOpen] = useState(false);
  const [augmentIntake, setAugmentIntake] = useState(null);
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
  const [relationshipPicker, setRelationshipPicker] = useState(null);
  const [relationshipNewNodePicker, setRelationshipNewNodePicker] = useState(null);
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
        setCenterMode("graph");
      } else if (command === "projection:both") {
        setProjectionLayout("split");
        setCenterMode("graph");
      } else if (command === "preview:rebuild") {
        rebuildPreview();
      } else if (command === "preview:start") {
        startPreview();
      } else if (command === "augment:start") {
        run(() => api.startAugment?.(), "Started Augment service");
      } else if (command === "augment:stop") {
        run(() => api.stopAugment?.(), "Stopped Augment service");
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
    setCenterMode("graph");
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

  async function importAssetFiles() {
    const result = await run(() => api.importAssets(), "Imported assets");
    if (result?.sessions?.length) {
      setAugmentIntake({
        sessions: result.sessions.map((entry) => ({
          ...entry,
          applying: false
        }))
      });
    }
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

  async function launchAugmentSession(payload, successLabel = "Created Augment intake session") {
    const created = await run(() => api.augmentCreateSession?.(payload), successLabel);
    if (!created?.session?.id) return null;
    await run(() => api.augmentExtractSession?.({ sessionId: created.session.id }), "Extracted intake candidates");
    const candidatesResult = await run(() => api.augmentListCandidates?.({ sessionId: created.session.id }), "Loaded intake candidates");
    if (!candidatesResult?.candidates) return null;
    setAugmentIntake((current) => ({
      sessions: [
        ...(current?.sessions || []),
        {
          sourceFile: payload.sourceType === "text" ? null : undefined,
          session: created.session,
          candidates: candidatesResult.candidates,
          applying: false
        }
      ]
    }));
    setIntakeChooserOpen(false);
    return created.session;
  }

  async function importAssets() {
    setIntakeChooserOpen(true);
  }

  async function setAugmentCandidateStatus(sessionId, candidateId, status) {
    const result = await run(
      () => api.augmentUpdateCandidate?.({ candidateId, status }),
      status === "accepted" ? "Accepted intake candidate" : status === "rejected" ? "Rejected intake candidate" : "Reset intake candidate"
    );
    if (!result) return;
    setAugmentIntake((current) => {
      if (!current) return current;
      return {
        ...current,
        sessions: current.sessions.map((entry) => (
          entry.session?.id !== sessionId
            ? entry
            : {
              ...entry,
              candidates: entry.candidates.map((candidate) => (
                candidate.id === candidateId ? { ...candidate, status } : candidate
              ))
            }
        ))
      };
    });
  }

  async function applyAugmentSession(sessionId) {
    const sessionEntry = augmentIntake?.sessions?.find((entry) => entry.session?.id === sessionId) || null;
    setAugmentIntake((current) => current ? {
      ...current,
      sessions: current.sessions.map((entry) => (
        entry.session?.id === sessionId ? { ...entry, applying: true } : entry
      ))
    } : current);
    const result = await run(
      () => api.applyAugmentSession?.({
        sessionId,
        session: sessionEntry?.session || undefined,
        sourceFile: sessionEntry?.sourceFile || undefined,
        acceptPendingNodes: false,
        acceptPendingRelationships: false
      }),
      "Added Augment intake to workspace"
    );
    if (result?.workspace) {
      setWorkspace(result.workspace);
      setSelectedNode(result.workspace.nodes?.[0] || null);
      setDraft(null);
      setAugmentIntake((current) => {
        if (!current) return current;
        const remaining = current.sessions.filter((entry) => entry.session?.id !== sessionId);
        return remaining.length ? { ...current, sessions: remaining } : null;
      });
    } else {
      setAugmentIntake((current) => current ? {
        ...current,
        sessions: current.sessions.map((entry) => (
          entry.session?.id === sessionId ? { ...entry, applying: false } : entry
        ))
      } : current);
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
    const result = await run(() => api.startHugoPreview(), "Started Hugo background");
    if (result?.url) {
      setPreviewUrl(bustPreviewUrl(result.url));
      if (centerMode === "preview") setCenterMode("graph");
    }
  }

  async function rebuildPreview() {
    const result = await run(() => api.rebuildHugoPreview(), "Rebuilt Hugo background");
    if (result?.url) {
      setPreviewUrl(bustPreviewUrl(result.url));
      if (centerMode === "preview") setCenterMode("graph");
    }
  }

  async function stopPreview() {
    await run(() => api.stopHugoPreview(), "Stopped Hugo background");
    setPreviewUrl("");
    if (centerMode === "preview") setCenterMode("graph");
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

  async function finalizePendingRelationship(savedNode, pendingSourceRef, pendingType) {
    if (!savedNode || !pendingSourceRef || !pendingType) return null;
    const sourceNode = findWorkspaceNode(pendingSourceRef, workspace?.nodes || []);
    if (!sourceNode) {
      setNotice({ type: "error", text: `Saved the new node, but could not find the relationship source: ${pendingSourceRef}` });
      return null;
    }
    const sourceRelativeFile = resolveNodeFilePath(sourceNode);
    if (!sourceRelativeFile) {
      setNotice({ type: "error", text: `Saved the new node, but the relationship source is not editable here: ${sourceNode.title || sourceNode.id}` });
      return null;
    }
    const sourceDraft = makeDraft(sourceNode);
    const sourceFrontMatter = extractFrontMatterShape(sourceDraft);
    const relationships = Array.isArray(sourceFrontMatter.relationships) ? [...sourceFrontMatter.relationships] : [];
    const targetRef = projectionNodeRef(savedNode);
    const exists = relationships.some((relationship) => relationship?.type === pendingType && normalizeNodeRef(relationship?.target) === normalizeNodeRef(targetRef));
    if (!exists) {
      relationships.push({
        type: pendingType,
        target: targetRef,
        summary: ""
      });
    }
    const updatedNodeData = normalizeFrontMatterForSave({
      ...sourceFrontMatter,
      relationships
    });
    return run(
      () => api.updateNode({ relativeFile: sourceRelativeFile, nodeData: updatedNodeData, body: sourceDraft.body || "" }),
      `Linked ${sourceNode.title || sourceNode.id} to ${savedNode.title || savedNode.id}`
    );
  }

  async function saveNode() {
    if (!draft) return;
    const pendingRelationshipSource = draft.__pendingRelationshipSource;
    const pendingRelationshipType = draft.__pendingRelationshipType;
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
      if (saved && pendingRelationshipSource && pendingRelationshipType) {
        await finalizePendingRelationship(saved, pendingRelationshipSource, pendingRelationshipType);
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
    if (saved && pendingRelationshipSource && pendingRelationshipType) {
      await finalizePendingRelationship(saved, pendingRelationshipSource, pendingRelationshipType);
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

  function createNewDraft(options = {}) {
    const title = options.title || `Untitled Node ${nodes.length + 1}`;
    const type = options.type || "concept";
    const next = {
      title,
      type,
      summary: "",
      relationships: [],
      body: `# ${title}\n\n`,
      frontMatter: { title, type, summary: "", relationships: [] }
    };
    if (options.pendingRelationshipSource) {
      next.__pendingRelationshipSource = projectionNodeRef(options.pendingRelationshipSource);
      next.__pendingRelationshipType = options.pendingRelationshipType || "related_to";
    }
    setSelectedNode(null);
    setDraft(next);
    setCenterMode("graph");
  }

  async function createRelationshipNodeFromRelationship(sourceNode, relationship) {
    if (!sourceNode || !relationship) return;
    const relationshipType = relationship.type || "related_to";
    const targetNode = findWorkspaceNode(relationship.target || relationship.to || relationship.node || relationship.id, nodes);
    const title = relationship.title || `${sourceNode.title || sourceNode.id || "Source"} ${relationshipLabel(relationshipType).replace(/\s*\([^)]*\)/g, "")} ${targetNode?.title || relationship.target || "Target"}`;
    const result = await run(() => api.createRelationshipNode({
      relationship: {
        ...relationship,
        source: projectionNodeRef(sourceNode),
        target: projectionNodeRef(targetNode) || relationship.target || relationship.to || relationship.node || relationship.id,
        type: relationshipType
      },
      options: {
        sourceNode,
        targetNode,
        title,
        summary: relationship.summary || `A first-class relationship node for ${relationshipLabel(relationshipType)}.`,
        evidence: relationship.evidence,
        confidence: relationship.confidence,
        review_status: relationship.review_status,
        evidence_strength: relationship.evidence_strength,
        asserted_by: relationship.asserted_by,
        asserted_at: relationship.asserted_at,
        reviewed_by: relationship.reviewed_by,
        importance: relationship.importance || 4,
        subtype: relationship.subtype,
        relationships: relationship.relationships || []
      }
    }), `Created relationship node for ${relationshipLabel(relationshipType)}`);
    const created = result?.workspace?.nodes ? findWorkspaceNode(result.result?.data?.protocol_id || result.result?.data?.id, result.workspace.nodes) : null;
    if (created) {
      setSelectedNode(created);
      setDraft(created.readOnly ? null : makeDraft(created));
      setCenterMode("graph");
    }
  }

  async function collapseRelationshipNodeToSimple(node) {
    if (!node) return;
    const nodeRef = node.relativeFile || node.protocolId || node.protocol_id || node.id;
    const result = await run(() => api.collapseRelationshipNode({
      nodeRef,
      options: { relationship: node }
    }), `Collapsed ${node.title || node.id || "relationship node"} to a simple relationship`);
    if (result?.workspace) {
      const nextSelected = findWorkspaceNode(node.source_node || node.protocolId || node.protocol_id || node.id, result.workspace.nodes || []) || result.workspace.nodes?.[0] || null;
      setSelectedNode(nextSelected);
      setDraft(nextSelected?.readOnly ? null : (nextSelected ? makeDraft(nextSelected) : null));
      setCenterMode("graph");
    }
  }

  function newNode() {
    createNewDraft();
  }

  function addRelationship(type, target) {
    if (!draft) return;
    const frontMatter = { ...(draft.frontMatter || extractFrontMatterShape(draft)) };
    const relationships = Array.isArray(frontMatter.relationships) ? [...frontMatter.relationships] : [];
    relationships.push({ type, target, summary: "" });
    setDraft({ ...draft, frontMatter: { ...frontMatter, relationships } });
  }

  function addRelationshipFromPicker(targetRef, type = relationshipPicker?.relationshipType || "related_to") {
    if (!relationshipPicker || !targetRef) return;
    addRelationship(type, targetRef);
    setRelationshipPicker(null);
    setNotice({ type: "success", text: `Added ${relationshipLabel(type)} to the draft. Save the source node when it looks right.` });
  }

  function openRelationshipPicker(sourceNode, type = "related_to") {
    if (!sourceNode) return;
    if (sourceNode.readOnly) {
      setNotice({ type: "error", text: "Duplicate mounted nodes into this workspace before authoring new relationships from them." });
      return;
    }
    const sourceDraft = sourceNode?.frontMatter ? sourceNode : makeDraft(sourceNode);
    setSelectedNode(sourceNode);
    setDraft(sourceDraft);
    setRelationshipPicker({
      sourceNode,
      relationshipType: type,
      sourceLabel: sourceNode.title || sourceNode.id || "Selected node"
    });
    setProjectionLayout("single");
    setCenterMode("graph");
  }

  function closeRelationshipPicker() {
    setRelationshipPicker(null);
  }

  function openRelationshipNewNodePicker(sourceNode, type = "related_to") {
    if (!sourceNode) return;
    if (sourceNode.readOnly) {
      setNotice({ type: "error", text: "Duplicate mounted nodes into this workspace before authoring new relationships from them." });
      return;
    }
    setSelectedNode(sourceNode);
    setDraft(sourceNode?.frontMatter ? sourceNode : makeDraft(sourceNode));
    setRelationshipNewNodePicker({
      sourceNode,
      relationshipType: type,
      nodeType: sourceNode.type || "concept",
      title: ""
    });
    setProjectionLayout("single");
    setCenterMode("graph");
  }

  function closeRelationshipNewNodePicker() {
    setRelationshipNewNodePicker(null);
  }

  function createRelationshipNewNode(payload = {}) {
    if (!relationshipNewNodePicker?.sourceNode) return;
    const title = String(payload.title ?? relationshipNewNodePicker.title ?? "").trim() || `Untitled Node ${nodes.length + 1}`;
    const type = payload.nodeType || relationshipNewNodePicker.nodeType || "concept";
    const relationshipType = payload.relationshipType || relationshipNewNodePicker.relationshipType || "related_to";
    createNewDraft({
      title,
      type,
      pendingRelationshipSource: relationshipNewNodePicker.sourceNode,
      pendingRelationshipType: relationshipType
    });
    setRelationshipNewNodePicker(null);
  }

  function handleGraphNodeClick(node) {
    selectNode(node);
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
          <details className="topbar-menu">
            <summary>Build</summary>
            <div className="topbar-menu-panel">
              <select value={buildSuggestionMode} onChange={(event) => setBuildSuggestionMode(event.target.value)} title="Suggestion handling during build">
                <option value="review">Review suggestions</option>
                <option value="apply">Apply safe suggestions</option>
              </select>
              <button disabled={!workspace} onClick={() => run(() => api.build({ suggestionMode: buildSuggestionMode }), buildSuggestionMode === "apply" ? "Built substrate and applied safe suggestions" : "Built substrate")}>Build Substrate</button>
              <button disabled={!workspace} onClick={exportSubstrate}>Export .substrate</button>
              <button disabled={!workspace || !hugoEnabled} onClick={startPreview}>Start Hugo</button>
              <button disabled={!workspace} onClick={stopPreview}>Stop Hugo</button>
              <button disabled={!workspace} onClick={() => setSnapshotOpen(true)}>Save Snapshot</button>
            </div>
          </details>
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
      {intakeChooserOpen && (
        <AugmentSourceChooser
          onImportFiles={async () => {
            await importAssetFiles();
            setIntakeChooserOpen(false);
          }}
          onSubmitUrl={(payload) => launchAugmentSession(payload, "Created URL intake")}
          onSubmitWikipedia={(payload) => launchAugmentSession(payload, "Created Wikipedia intake")}
          onSubmitGithub={(payload) => launchAugmentSession(payload, "Created GitHub intake")}
          onSubmitText={(payload) => launchAugmentSession(payload, "Created text intake")}
          onClose={() => setIntakeChooserOpen(false)}
        />
      )}
      {augmentIntake && (
        <AugmentIntakeDialog
          intake={augmentIntake}
          onSetStatus={setAugmentCandidateStatus}
          onApplySession={applyAugmentSession}
          onClose={() => setAugmentIntake(null)}
        />
      )}
      {relationshipPicker && (
        <RelationshipPickerDialog
          sourceNode={relationshipPicker.sourceNode}
          sourceLabel={relationshipPicker.sourceLabel}
          relationshipType={relationshipPicker.relationshipType}
          nodes={nodes}
          onClose={closeRelationshipPicker}
          onChangeRelationshipType={(nextType) => setRelationshipPicker((value) => value ? { ...value, relationshipType: nextType } : value)}
          onPickTarget={(targetRef, type) => addRelationshipFromPicker(targetRef, type)}
        />
      )}
      {relationshipNewNodePicker && (
        <RelationshipNewNodeDialog
          sourceNode={relationshipNewNodePicker.sourceNode}
          relationshipType={relationshipNewNodePicker.relationshipType}
          title={relationshipNewNodePicker.title}
          nodeType={relationshipNewNodePicker.nodeType}
          onChangeTitle={(value) => setRelationshipNewNodePicker((current) => current ? { ...current, title: value } : current)}
          onChangeNodeType={(value) => setRelationshipNewNodePicker((current) => current ? { ...current, nodeType: value } : current)}
          onChangeRelationshipType={(value) => setRelationshipNewNodePicker((current) => current ? { ...current, relationshipType: value } : current)}
          onClose={closeRelationshipNewNodePicker}
          onCreate={createRelationshipNewNode}
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
                Created by <a href="https://xananode.com/person/christian-siefen/" target="_blank" rel="noreferrer">Christian Siefen</a> for the <a href="https://xananode.com/" target="_blank" rel="noreferrer">XanaNode</a> project. Follow development on <a href="https://github.com/kingc95" target="_blank" rel="noreferrer">kingc95</a>.
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
                          <span className="catalog-item-head">
                            <NodeTypeIcon type={node.type} size={24} />
                            <span>{node.title || node.id || "Untitled"}</span>
                          </span>
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
            />
            {projectionLayout === "split" && centerMode !== "health" && centerMode !== "logs" ? (
              <div className="projection-split" style={{ gridTemplateColumns: `${projectionSplit}% minmax(280px, 1fr)` }}>
                <GraphView workspaceRoot={workspace?.rootDir} nodes={nodes} selectedNode={selectedNode} draft={draft} onSelect={handleGraphNodeClick} onQuickRelationshipToExisting={openRelationshipPicker} onQuickRelationshipToNew={openRelationshipNewNodePicker} onPromoteRelationshipEdge={createRelationshipNodeFromRelationship} onCollapseRelationshipNode={collapseRelationshipNodeToSimple} command={graphCommand} />
                <LogView logs={previewLogs} compact />
              </div>
            ) : (
              <>
                {centerMode === "graph" && <GraphView workspaceRoot={workspace?.rootDir} nodes={nodes} selectedNode={selectedNode} draft={draft} onSelect={handleGraphNodeClick} onQuickRelationshipToExisting={openRelationshipPicker} onQuickRelationshipToNew={openRelationshipNewNodePicker} onPromoteRelationshipEdge={createRelationshipNodeFromRelationship} onCollapseRelationshipNode={collapseRelationshipNodeToSimple} command={graphCommand} />}
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
              openRelationshipPicker={openRelationshipPicker}
              openRelationshipNewNodePicker={openRelationshipNewNodePicker}
              createRelationshipNodeFromRelationship={createRelationshipNodeFromRelationship}
              collapseRelationshipNodeToSimple={collapseRelationshipNodeToSimple}
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

function isWikipediaFileUrlValue(value) {
  return /wikipedia\.org\/wiki\/File:/i.test(String(value || ""));
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
        <p className="welcome-credit">Created by <a href="https://xananode.com/person/christian-siefen/" target="_blank" rel="noreferrer">Christian Siefen</a>. Trace the project at <a href="https://xananode.com/" target="_blank" rel="noreferrer">XanaNode.com</a> and follow development on <a href="https://github.com/kingc95" target="_blank" rel="noreferrer">kingc95</a>.</p>
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

function RelationshipPickerDialog({ sourceNode, sourceLabel, relationshipType, nodes, onClose, onChangeRelationshipType, onPickTarget }) {
  const [relationshipCategory, setRelationshipCategory] = useState("all");
  const [relationshipQuery, setRelationshipQuery] = useState("");
  const [nodeQuery, setNodeQuery] = useState("");
  const [selectedTarget, setSelectedTarget] = useState("");
  const sourceRef = projectionNodeRef(sourceNode);
  const filteredRelationshipDefinitions = (relationshipCategory === "all"
    ? RELATIONSHIP_TYPE_DEFINITIONS
    : RELATIONSHIP_TYPE_DEFINITIONS.filter((definition) => definition.category === relationshipCategory)
  ).filter((definition) => {
    const query = relationshipQuery.trim().toLowerCase();
    if (!query) return true;
    return [definition.label, definition.type, definition.category, definition.meaning, definition.inverse]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
  const selectedRelationshipDefinition = RELATIONSHIP_TYPES_BY_TYPE[relationshipType] || null;
  const groupedNodes = useMemo(() => groupNodes(
    sortNodesForPicker(nodes).filter((node) => projectionNodeRef(node) !== sourceRef),
    "type"
  ), [nodes, sourceRef]);
  const filteredNodeGroups = useMemo(() => {
    const query = nodeQuery.trim().toLowerCase();
    if (!query) return groupedNodes;
    return Object.fromEntries(Object.entries(groupedNodes).map(([group, groupNodes]) => [
      group,
      groupNodes.filter((node) => {
        const haystack = [node.title, node.id, node.type, node.subtype, node.summary]
          .filter(Boolean)
          .map((value) => String(value).toLowerCase());
        return haystack.some((value) => value.includes(query));
      })
    ]).filter(([, groupNodes]) => groupNodes.length));
  }, [groupedNodes, nodeQuery]);

  return (
    <div className="setup-backdrop">
      <div className="setup-panel chooser-panel relationship-picker-panel">
        <div className="setup-header">
          <div>
            <div className="kicker">Relationship</div>
            <h2>Choose a relationship and a target</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">x</button>
        </div>
        <p className="setup-note">Source: <strong>{sourceLabel || sourceNode?.title || sourceNode?.id || "Selected node"}</strong></p>
        <div className="relationship-picker-toolbar">
          <select value={relationshipCategory} onChange={(event) => setRelationshipCategory(event.target.value)}>
            <option value="all">All categories</option>
            {RELATIONSHIP_CATEGORIES.map((category) => <option value={category} key={category}>{category}</option>)}
          </select>
          <input value={relationshipQuery} onChange={(event) => setRelationshipQuery(event.target.value)} placeholder="Search relationship types" />
        </div>
        <div className="relationship-type-list relationship-type-list--compact">
          {filteredRelationshipDefinitions.map((definition) => (
            <button
              type="button"
              className={`relationship-type-option ${relationshipType === definition.type ? "selected" : ""}`}
              key={definition.type}
              onClick={() => onChangeRelationshipType?.(definition.type)}
              title={definition.meaning}
            >
              <span>{definition.label}</span>
              <small>{definition.type}</small>
            </button>
          ))}
        </div>
        {selectedRelationshipDefinition && (
          <div className="relationship-definition">
            <span className="pill">{selectedRelationshipDefinition.category}</span>
            <span>Inverse: {selectedRelationshipDefinition.inverse || "none"}</span>
            <p>{selectedRelationshipDefinition.meaning}</p>
          </div>
        )}
        <div className="relationship-picker-toolbar">
          <input value={nodeQuery} onChange={(event) => setNodeQuery(event.target.value)} placeholder="Search nodes by title or type" />
        </div>
        <div className="relationship-node-groups">
          {Object.entries(filteredNodeGroups).length ? Object.entries(filteredNodeGroups).map(([group, groupNodes]) => (
            <details key={group} open>
              <summary>{group} <span>{groupNodes.length}</span></summary>
              <div className="relationship-node-list">
                {groupNodes.map((node) => (
                  <button
                    type="button"
                    key={nodeKey(node)}
                    className={`relationship-node-option ${selectedTarget === projectionNodeRef(node) ? "selected" : ""}`}
                    onClick={() => setSelectedTarget(projectionNodeRef(node))}
                    title={node.title || node.id || node.type || "Untitled"}
                  >
                    <NodeTypeIcon type={node.type} size={28} />
                    <span>
                      <strong>{node.title || node.id || "Untitled"}</strong>
                      <small>{node.type || "node"}</small>
                    </span>
                  </button>
                ))}
              </div>
            </details>
          )) : <p className="muted">No nodes match the current search.</p>}
        </div>
        <div className="setup-actions">
          <button type="button" className="primary" disabled={!selectedTarget} onClick={() => onPickTarget?.(selectedTarget, relationshipType)}>Apply</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function RelationshipNewNodeDialog({ sourceNode, relationshipType, nodeType, title, onClose, onChangeTitle, onChangeNodeType, onChangeRelationshipType, onCreate }) {
  const [relationshipCategory, setRelationshipCategory] = useState(RELATIONSHIP_TYPES_BY_TYPE[relationshipType]?.category || "all");
  const [relationshipQuery, setRelationshipQuery] = useState("");
  const [localRelationshipType, setLocalRelationshipType] = useState(relationshipType || "related_to");
  const [localNodeType, setLocalNodeType] = useState(nodeType || "concept");
  const [localTitle, setLocalTitle] = useState(title || "");
  const suggestedTypes = NODE_TYPE_DEFINITIONS.filter((definition) => definition.type !== "relationship");
  const filteredRelationshipDefinitions = (relationshipCategory === "all"
    ? RELATIONSHIP_TYPE_DEFINITIONS
    : RELATIONSHIP_TYPE_DEFINITIONS.filter((definition) => definition.category === relationshipCategory)
  ).filter((definition) => {
    const query = relationshipQuery.trim().toLowerCase();
    if (!query) return true;
    return [definition.label, definition.type, definition.category, definition.meaning, definition.inverse]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
  const selectedRelationshipDefinition = RELATIONSHIP_TYPES_BY_TYPE[relationshipType] || null;

  useEffect(() => {
    setRelationshipCategory(RELATIONSHIP_TYPES_BY_TYPE[relationshipType]?.category || "all");
    setRelationshipQuery("");
    setLocalRelationshipType(relationshipType || "related_to");
  }, [relationshipType]);

  useEffect(() => {
    setLocalNodeType(nodeType || "concept");
  }, [nodeType]);

  useEffect(() => {
    setLocalTitle(title || "");
  }, [title]);

  return (
    <div className="setup-backdrop">
      <div className="setup-panel chooser-panel relationship-picker-panel">
        <div className="setup-header">
          <div>
            <div className="kicker">New node</div>
            <h2>Create a related node</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">x</button>
        </div>
        <p className="setup-note">
          Source: <strong>{sourceNode?.title || sourceNode?.id || "Selected node"}</strong>. Studio will create the new node and then attach {relationshipLabel(relationshipType)}.
        </p>
        <div className="relationship-picker-toolbar">
          <select value={relationshipCategory} onChange={(event) => setRelationshipCategory(event.target.value)}>
            <option value="all">All categories</option>
            {RELATIONSHIP_CATEGORIES.map((category) => <option value={category} key={category}>{category}</option>)}
          </select>
          <input value={relationshipQuery} onChange={(event) => setRelationshipQuery(event.target.value)} placeholder="Search relationship types" />
        </div>
        <div className="relationship-type-list relationship-type-list--compact">
          {filteredRelationshipDefinitions.map((definition) => (
            <button
              type="button"
              className={`relationship-type-option ${localRelationshipType === definition.type ? "selected" : ""}`}
              key={definition.type}
              onClick={() => {
                setLocalRelationshipType(definition.type);
                onChangeRelationshipType?.(definition.type);
              }}
              title={definition.meaning}
            >
              <span>{definition.label}</span>
              <small>{definition.type}</small>
            </button>
          ))}
        </div>
        {selectedRelationshipDefinition && (
          <div className="relationship-definition">
            <span className="pill">{selectedRelationshipDefinition.category}</span>
            <span>Inverse: {selectedRelationshipDefinition.inverse || "none"}</span>
            <p>{selectedRelationshipDefinition.meaning}</p>
          </div>
        )}
        <div className="relationship-picker-toolbar">
          <input
            value={localTitle}
            onChange={(event) => {
              setLocalTitle(event.target.value);
              onChangeTitle?.(event.target.value);
            }}
            placeholder="New node title"
            autoFocus
          />
          <select
            value={localNodeType}
            onChange={(event) => {
              setLocalNodeType(event.target.value);
              onChangeNodeType?.(event.target.value);
            }}
          >
            {suggestedTypes.map((definition) => (
              <option value={definition.type} key={definition.type}>{definition.label} ({definition.type})</option>
            ))}
          </select>
        </div>
        <div className="relationship-definition">
          <span className="pill">{localNodeType || "node"}</span>
          <span>Relationship: {relationshipLabel(localRelationshipType)}</span>
          <p>The new node will open in the editor after creation so you can finish the content immediately.</p>
        </div>
        <div className="setup-actions">
          <button type="button" className="primary" onClick={() => onCreate?.({ title: localTitle, nodeType: localNodeType, relationshipType: localRelationshipType, sourceNode })}>Create and relate</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function NodeTypeIcon({ type, size = 28, variant = "badge" }) {
  const kind = String(type || "node");
  const colors = NODE_TYPES_BY_TYPE[kind]?.color || {};
  const fill = colors.bg || "#5b6472";
  const outline = colors.outline || "rgba(255, 255, 255, 0.5)";
  const accent = colors.fg || "#f8fafc";
  return (
    <svg
      className={`node-type-icon ${variant === "glyph" ? "node-type-icon--glyph" : "node-type-icon--badge"}`}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      x={variant === "glyph" ? -size / 2 : 0}
      y={variant === "glyph" ? -size / 2 : 0}
      aria-hidden="true"
      focusable="false"
    >
      {variant === "badge" && <circle cx="32" cy="32" r="27" fill={fill} stroke={outline} strokeWidth="4" />}
      {kind === "person" && (
        <>
          <circle cx="32" cy="22" r="8" fill={accent} opacity="0.95" />
          <path d="M18 48c2-9 9-14 14-14s12 5 14 14" fill="none" stroke={accent} strokeWidth="5" strokeLinecap="round" />
        </>
      )}
      {kind === "organization" && (
        <>
          <path d="M20 18h24v30H20z" fill="none" stroke={accent} strokeWidth="4" strokeLinejoin="round" />
          <path d="M24 24h4M32 24h4M40 24h4M24 30h4M32 30h4M40 30h4M24 36h4M32 36h4M40 36h4" stroke={accent} strokeWidth="4" strokeLinecap="round" />
          <path d="M28 48V38h8v10" fill="none" stroke={accent} strokeWidth="4" strokeLinecap="round" />
        </>
      )}
      {kind === "place" && (
        <>
          <path d="M32 14c-8 0-14 6-14 14 0 10 14 22 14 22s14-12 14-22c0-8-6-14-14-14z" fill="none" stroke={accent} strokeWidth="4" strokeLinejoin="round" />
          <circle cx="32" cy="28" r="5" fill={accent} />
        </>
      )}
      {kind === "concept" && (
        <>
          <path d="M24 37c0-5 4-9 8-9s8 4 8 9c0 3-1 5-3 7v4H27v-4c-2-2-3-4-3-7z" fill="none" stroke={accent} strokeWidth="4" strokeLinejoin="round" />
          <path d="M28 50h8" stroke={accent} strokeWidth="4" strokeLinecap="round" />
        </>
      )}
      {kind === "source" || kind === "publication" || kind === "essay" || kind === "fragment" || kind === "revision" || kind === "schema" || kind === "item" ? (
        <>
          <path d="M22 14h16l10 10v26H22z" fill="none" stroke={accent} strokeWidth="4" strokeLinejoin="round" />
          <path d="M38 14v10h10" fill="none" stroke={accent} strokeWidth="4" strokeLinejoin="round" />
          <path d="M28 28h12M28 34h12M28 40h8" stroke={accent} strokeWidth="4" strokeLinecap="round" />
        </>
      ) : null}
      {kind === "question" && (
        <>
          <path d="M24 24c0-5 4-8 8-8 5 0 8 3 8 7 0 4-3 6-6 8-2 1-3 2-3 5" fill="none" stroke={accent} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="32" cy="45" r="3" fill={accent} />
        </>
      )}
      {(kind === "claim" || kind === "response" || kind === "community" || kind === "media" || kind === "project" || kind === "trail" || kind === "technology" || kind === "knowledge_gap" || kind === "observation" || kind === "problem") && (
        <>
          <path d="M18 20h28v18H36l-8 8v-8H18z" fill="none" stroke={accent} strokeWidth="4" strokeLinejoin="round" />
          {kind === "problem" && <path d="M32 24v8M32 38h0" stroke={accent} strokeWidth="4" strokeLinecap="round" />}
          {kind === "observation" && <circle cx="32" cy="29" r="6" fill="none" stroke={accent} strokeWidth="4" />}
          {kind === "technology" && <path d="M28 24h8l2 4-2 4h-8l-2-4z" fill="none" stroke={accent} strokeWidth="4" strokeLinejoin="round" />}
          {kind === "trail" && <path d="M22 38c6-8 14-8 20 0" fill="none" stroke={accent} strokeWidth="4" strokeLinecap="round" />}
          {kind === "knowledge_gap" && <path d="M26 31h12M32 24v14" stroke={accent} strokeWidth="4" strokeLinecap="round" />}
        </>
      )}
      {!(kind === "person" || kind === "organization" || kind === "place" || kind === "concept" || kind === "source" || kind === "publication" || kind === "essay" || kind === "fragment" || kind === "revision" || kind === "schema" || kind === "item" || kind === "question" || kind === "claim" || kind === "response" || kind === "community" || kind === "media" || kind === "project" || kind === "trail" || kind === "technology" || kind === "knowledge_gap" || kind === "observation" || kind === "problem") && (
        <>
          <circle cx="24" cy="24" r="4" fill={accent} />
          <circle cx="40" cy="24" r="4" fill={accent} />
          <circle cx="32" cy="40" r="4" fill={accent} />
          <path d="M24 24L32 40L40 24" fill="none" stroke={accent} strokeWidth="3.5" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

function AugmentSourceChooser({ onImportFiles, onSubmitUrl, onSubmitWikipedia, onSubmitGithub, onSubmitText, onClose }) {
  const [mode, setMode] = useState("files");
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [textTitle, setTextTitle] = useState("");
  const [textBody, setTextBody] = useState("");

  async function handleFiles() {
    setBusy(true);
    await onImportFiles();
    setBusy(false);
  }

  async function submitCurrent(event) {
    event.preventDefault();
    setBusy(true);
      try {
        if (mode === "url") {
          await onSubmitUrl({
            title: title.trim() || "Imported URL",
            sourceType: "url",
            sourceUrl: url.trim()
          });
        } else if (mode === "wikipedia") {
          const wikiFile = isWikipediaFileUrlValue(url);
          await onSubmitWikipedia({
            title: title.trim() || (wikiFile ? "Wikipedia File" : "Wikipedia Article"),
            sourceType: "url",
            sourceUrl: url.trim()
          });
        } else if (mode === "github") {
        await onSubmitGithub({
          title: title.trim() || "GitHub Repository",
          sourceType: "github",
          sourceUrl: url.trim()
        });
      } else if (mode === "text") {
        await onSubmitText({
          title: textTitle.trim() || "Captured Note",
          sourceType: "text",
          sourceText: textBody
        });
      }
    } finally {
      setBusy(false);
    }
  }

  const needsUrl = mode === "url" || mode === "wikipedia" || mode === "github";
  const submitDisabled = busy || (needsUrl ? !url.trim() : mode === "text" ? !textBody.trim() : false);

  return (
    <div className="setup-backdrop">
      <form className="setup-panel chooser-panel" onSubmit={submitCurrent}>
        <div className="setup-header">
          <div>
            <div className="kicker">Augment Intake</div>
            <h2>Bring a source into this substrate</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">x</button>
        </div>
        <p className="setup-note">Choose how you want to capture something. Files still work, but URLs, Wikipedia pages, GitHub repositories, and pasted text come through Augment too.</p>

        <div className="chooser-mode-row">
          <button type="button" className={mode === "files" ? "primary" : ""} onClick={() => setMode("files")}>Files</button>
          <button type="button" className={mode === "url" ? "primary" : ""} onClick={() => setMode("url")}>URL</button>
          <button type="button" className={mode === "wikipedia" ? "primary" : ""} onClick={() => setMode("wikipedia")}>Wikipedia</button>
          <button type="button" className={mode === "github" ? "primary" : ""} onClick={() => setMode("github")}>GitHub</button>
          <button type="button" className={mode === "text" ? "primary" : ""} onClick={() => setMode("text")}>Paste Text</button>
        </div>

        {mode === "files" ? (
          <div className="editor-section chooser-block">
            <div className="panel-title">Local files</div>
            <p className="muted">Choose PDFs, text files, markdown, media, or other local source files. Text-like files and PDFs go through Augment review first. Other assets still import directly as media/source nodes.</p>
            <div className="setup-actions">
              <button type="button" className="primary" disabled={busy} onClick={handleFiles}>Choose Files</button>
            </div>
          </div>
        ) : (
          <div className="editor-section chooser-block">
            <label>Title</label>
              <input
                value={mode === "text" ? textTitle : title}
                onChange={(event) => mode === "text" ? setTextTitle(event.target.value) : setTitle(event.target.value)}
                placeholder={mode === "github" ? "Repository capture title" : mode === "wikipedia" ? "Wikipedia article or file title" : mode === "url" ? "Source capture title" : "Captured note title"}
                autoFocus
              />
            {needsUrl ? (
              <>
                <label>{mode === "github" ? "GitHub repository URL" : mode === "wikipedia" ? "Wikipedia URL" : "URL"}</label>
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder={mode === "github" ? "https://github.com/owner/repo" : mode === "wikipedia" ? "https://en.wikipedia.org/wiki/..." : "https://..."}
                />
              </>
            ) : (
              <>
                <label>Text</label>
                <textarea rows={10} value={textBody} onChange={(event) => setTextBody(event.target.value)} placeholder="Paste notes, excerpts, or a draft source here." />
              </>
            )}
              <div className="setup-actions">
                <button type="submit" className="primary" disabled={submitDisabled}>
                  {mode === "github"
                    ? "Extract Repository"
                    : mode === "wikipedia"
                      ? (isWikipediaFileUrlValue(url) ? "Extract File Page" : "Extract Article")
                      : mode === "url"
                        ? "Extract URL"
                        : "Extract Text"}
                </button>
              <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

function AugmentIntakeDialog({ intake, onSetStatus, onApplySession, onClose }) {
  return (
    <div className="setup-backdrop">
      <div className="setup-panel intake-panel">
        <div className="setup-header">
          <div>
            <div className="kicker">Augment Intake</div>
            <h2>Review extracted nodes before bringing them into this workspace</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">x</button>
        </div>
        <p className="setup-note">Text files and PDFs come through Augment first. Accept what belongs in this substrate, then add only the accepted results into your current workspace. Everything else stays out.</p>
        <div className="intake-session-list">
          {intake.sessions.map((entry) => {
            const sessionId = entry.session?.id;
            const nodeCount = entry.candidates.filter((candidate) => candidate.kind === "node").length;
            const relationshipCount = entry.candidates.filter((candidate) => candidate.kind === "relationship").length;
            const acceptedCount = entry.candidates.filter((candidate) => candidate.status === "accepted").length;
            return (
              <section className="editor-section intake-session-card" key={sessionId}>
                <div className="panel-row">
                  <div>
                    <div className="panel-title">{entry.session?.title || "Untitled intake"}</div>
                    <div className="small muted">{entry.sourceFile}</div>
                  </div>
                  <button type="button" className="primary" disabled={entry.applying} onClick={() => onApplySession(sessionId)}>
                    {entry.applying ? "Adding..." : "Add to Workspace"}
                  </button>
                </div>
                <div className="pill-row">
                  <span className="pill">{nodeCount} nodes</span>
                  <span className="pill">{relationshipCount} relationships</span>
                  <span className="pill">{acceptedCount} accepted</span>
                </div>
                <div className="intake-candidate-list">
                  {entry.candidates.map((candidate) => (
                    <article className={`intake-candidate ${candidate.status === "accepted" ? "accepted" : "rejected"}`} key={candidate.id}>
                      <div className="panel-row">
                        <div>
                          <strong>{candidate.title || "Untitled candidate"}</strong>
                          <div className="small muted">
                            {candidate.kind === "relationship"
                              ? `${candidate.relationshipType || "related_to"} relationship`
                              : `${String(candidate.nodeType || "concept").toUpperCase()} node`}
                          </div>
                        </div>
                        <div className="candidate-actions">
                          <button type="button" className={candidate.status === "accepted" ? "primary" : ""} onClick={() => onSetStatus(sessionId, candidate.id, candidate.status === "accepted" ? null : "accepted")}>Accept</button>
                        </div>
                      </div>
                      {candidate.summary ? <p>{candidate.summary}</p> : null}
                      {candidate.sourceFragment ? <blockquote>{candidate.sourceFragment}</blockquote> : null}
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
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
  setProjectionSplit
}) {
  return (
    <div className="center-tabs projection-toolbar">
      <div className="tab-group">
        <button className={centerMode === "graph" && projectionLayout !== "split" ? "active" : ""} onClick={() => {
          setProjectionLayout("single");
          setCenterMode("graph");
        }}>Graph Projection</button>
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
    </div>
  );
}

function GraphView({ workspaceRoot, nodes, selectedNode, draft, onSelect, onQuickRelationshipToExisting, onQuickRelationshipToNew, onPromoteRelationshipEdge, onCollapseRelationshipNode, command }) {
  const current = draft || selectedNode || nodes[0] || null;
  const [graphDepth, setGraphDepth] = useState(1);
  const [contextMenu, setContextMenu] = useState(null);
  const graphNodes = useMemo(() => buildEffectiveGraphNodes(nodes, draft, selectedNode), [nodes, draft, selectedNode]);
  const graph = useMemo(() => buildLocalGraph(graphNodes, current, graphDepth), [graphNodes, current, graphDepth]);
  const graphDensity = useMemo(() => describeViewerGraphDensity(graph), [graph]);
  const denseGraph = graphDensity.mode === "dense";
  const labeledNodeIds = useMemo(() => selectViewerLabeledNodes(graph, { dense: denseGraph }), [graph, denseGraph]);
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
    const travelPlan = buildViewerTravelPlan(previous.graph, previous.currentId, currentId, { maxDepth: 6 });
    if (travelPlan?.currentNode && travelPlan?.nextNode) {
      setTravelMarkup(buildReadableTravelOverlayMarkup(
        travelPlan.currentNode,
        travelPlan.nextNode,
        previous.viewport || viewport,
        { routeNodes: travelPlan.routeNodes || [] }
      ));
      const timer = window.setTimeout(() => setTravelMarkup(""), Math.max(820, Number(travelPlan.routeNodes?.length || 2) * 260));
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

  function openNodeContextMenu(event, node) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      kind: "node",
      x: event.clientX,
      y: event.clientY,
      node: node.source || node,
      relationshipType: "related_to"
    });
  }

  function openEdgeContextMenu(event, edge) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      kind: "edge",
      x: event.clientX,
      y: event.clientY,
      edge,
      sourceNode: edge.source?.source || edge.source,
      targetNode: edge.target?.source || edge.target,
      relationshipType: edge.type || "related_to"
    });
  }

  function closeNodeContextMenu() {
    setContextMenu(null);
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
    <div className={`graph-wrap ${panning ? "panning" : ""}`}>
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
      {contextMenu && (
        <div
          className="graph-node-menu"
          style={{ left: Math.min(contextMenu.x, window.innerWidth - 320), top: Math.min(contextMenu.y, window.innerHeight - 220) }}
        >
          <div className="graph-node-menu-title">
            {contextMenu.kind === "edge"
              ? `${contextMenu.sourceNode?.title || contextMenu.sourceNode?.id || "Source"} → ${contextMenu.targetNode?.title || contextMenu.targetNode?.id || "Target"}`
              : contextMenu.node?.title || contextMenu.node?.id || "Selected node"}
          </div>
          {contextMenu.kind === "node" && (
            <label className="graph-node-menu-field">
              <span>Relationship</span>
              <select
                value={contextMenu.relationshipType}
                onChange={(event) => setContextMenu((value) => value ? { ...value, relationshipType: event.target.value } : value)}
              >
                {RELATIONSHIP_TYPE_DEFINITIONS.map((definition) => (
                  <option value={definition.type} key={`graph-menu-${definition.type}`}>{definition.label} ({definition.type})</option>
                ))}
              </select>
            </label>
          )}
          <div className="graph-node-menu-actions">
            {contextMenu.kind === "edge" ? (
              <button
                type="button"
                onClick={() => {
                  onPromoteRelationshipEdge?.(contextMenu.sourceNode, {
                    type: contextMenu.relationshipType,
                    target: projectionNodeRef(contextMenu.targetNode)
                  });
                  closeNodeContextMenu();
                }}
              >
                Make relationship node
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    onQuickRelationshipToExisting?.(contextMenu.node, contextMenu.relationshipType);
                    closeNodeContextMenu();
                  }}
                >
                  Relationship to existing
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onQuickRelationshipToNew?.(contextMenu.node, contextMenu.relationshipType);
                    closeNodeContextMenu();
                  }}
                >
                  Relationship to new
                </button>
                {contextMenu.node?.type === "relationship" && (
                  <button
                    type="button"
                    onClick={() => {
                      onCollapseRelationshipNode?.(contextMenu.node);
                      closeNodeContextMenu();
                    }}
                  >
                    Collapse to simple relationship
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              onClick={() => {
                onSelect?.(contextMenu.node || contextMenu.sourceNode || contextMenu.edge?.source?.source || contextMenu.edge?.source);
                closeNodeContextMenu();
              }}
            >
              Edit this node
            </button>
          </div>
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
        onContextMenu={(event) => {
          event.preventDefault();
          if (contextMenu) closeNodeContextMenu();
        }}
        onClick={() => {
          if (contextMenu) closeNodeContextMenu();
        }}
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
            const edgePath = projectionEdgePath(edge, { sourceInset, targetInset });
            const safeKey = `ep-${String(edge.key).replace(/[^a-zA-Z0-9]/g, "_")}`;
            const pm = edgePath.match(/M\s*([\d.-]+)\s+([\d.-]+)\s+Q\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)/);
            const [psx, psy, pcx, pcy, ptx, pty] = pm ? pm.slice(1).map(Number) : [];
            const goesLeft = pm && ptx < psx;
            const textD = pm ? (goesLeft ? `M ${ptx} ${pty} Q ${pcx} ${pcy} ${psx} ${psy}` : edgePath) : edgePath;
            const startOffset = goesLeft ? "25%" : "75%";
            return (
            <g key={edge.key} opacity={edge.opacity ?? 1}>
              <path
                className="edge"
                d={edgePath}
                stroke={edge.style.color}
                strokeDasharray={edge.style.dash}
                strokeWidth={edge.style.strokeWidth}
                onContextMenu={(event) => openEdgeContextMenu(event, edge)}
              />
              <polygon
                className="edge-arrow"
                points={projectionEdgeArrowPoints(edge, 10, targetInset).map(([x, y]) => `${x},${y}`).join(" ")}
                fill={edge.style.color}
                opacity={edge.arrowOpacity ?? edge.opacity ?? 1}
                onContextMenu={(event) => openEdgeContextMenu(event, edge)}
              />
              {edge.showLabel !== false && !denseGraph && pm && (
                <>
                  <defs>
                    <path id={safeKey} d={textD} />
                  </defs>
                  <text
                    className="edge-label"
                    onContextMenu={(event) => openEdgeContextMenu(event, edge)}
                  >
                    <textPath href={`#${safeKey}`} startOffset={startOffset} dy="-5">
                      {edge.label || humanizeRelationship(edge.type)}
                    </textPath>
                  </text>
                </>
              )}
            </g>
          );})}
          {graph.nodes.map((node) => {
            const radius = node.r || (node.selected ? 46 : 32);
            const mediaSrc = resolveGraphNodeMediaSrc(node, workspaceRoot);
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
              onContextMenu={(event) => openNodeContextMenu(event, node)}
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
              ) : (
                <NodeTypeIcon type={node.type} size={imageRadius * 2} variant="glyph" />
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

function parseLoosePropertyValue(value = "") {
  const text = String(value).trim();
  if (!text) return "";
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      return JSON.parse(text);
    } catch {
      return value;
    }
  }
  return value;
}

function formatPropertyValue(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  if (value === undefined || value === null) return "";
  return String(value);
}

function fieldOptionList(field = {}) {
  const options = Array.isArray(field.options) ? field.options : [];
  return options.map((option) => (
    typeof option === "string"
      ? { value: option, label: option }
      : { value: option?.value ?? "", label: option?.label ?? option?.value ?? "" }
  )).filter((option) => option.value || option.label);
}

function EditorPanel({ selectedNode, draft, setDraft, nodes, suggestions, addRelationship, openRelationshipPicker, openRelationshipNewNodePicker, createRelationshipNodeFromRelationship, collapseRelationshipNodeToSimple, duplicateNode, saveNode, deleteNode }) {
  const [relationshipTarget, setRelationshipTarget] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [customValue, setCustomValue] = useState("");
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
  const draftRef = normalizeNodeRef(projectionNodeRef(draft));
  const typeDefinition = NODE_TYPES_BY_TYPE[type] || null;
  const allowedSubtypes = typeDefinition?.allowed_subtypes || [];
  const trailSequence = Array.isArray(frontMatter.nodes) ? frontMatter.nodes : [];
  const selectedSubtypes = uniqueList([
    frontMatter.subtype,
    ...(Array.isArray(frontMatter.subtypes) ? frontMatter.subtypes : [])
  ]);
  const typeSpecificFields = Array.isArray(typeDefinition?.editable_fields)
    ? typeDefinition.editable_fields.map((field) => ({
      ...field,
      list: field?.value_kind === "string_list" || field?.value_kind === "list"
    }))
    : [];
  const reservedKeys = new Set([
    ...RESERVED_FRONTMATTER_KEYS,
    ...typeSpecificFields.map((field) => field.key)
  ]);
  const customPropertyEntries = Object.entries(frontMatter)
    .filter(([key]) => !reservedKeys.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
  const sortedExistingNodes = sortNodesForPicker(nodes);
  const availableTrailTargets = sortedExistingNodes.filter((node) => projectionNodeRef(node) !== projectionNodeRef(draft));
  const relationshipRows = (() => {
    const rows = [];
    for (const node of nodes || []) {
      const sourceNode = node?.source || node;
      const sourceRef = normalizeNodeRef(projectionNodeRef(sourceNode));
      if (!sourceRef) continue;
      const nodeFrontMatter = sourceNode?.frontMatter || sourceNode?.data || sourceNode || {};
      const nodeRelationships = Array.isArray(nodeFrontMatter.relationships)
        ? nodeFrontMatter.relationships
        : Array.isArray(sourceNode?.relationships)
          ? sourceNode.relationships
          : [];
      for (const [relationshipIndex, relationship] of nodeRelationships.entries()) {
        const type = relationship?.type || "related_to";
        const targetRef = normalizeNodeRef(relationship?.target || relationship?.to || relationship?.node || "");
        const isOutgoing = sourceRef === draftRef;
        const isIncoming = targetRef && targetRef === draftRef;
        if (!isOutgoing && !isIncoming) continue;
        const inverseType = RELATIONSHIP_TYPES_BY_TYPE[type]?.inverse || "";
        const targetNode = targetRef ? findWorkspaceNode(targetRef, nodes) : null;
        rows.push({
          key: `${sourceRef}:${targetRef || "unknown"}:${type}:${relationshipIndex}`,
          relationship,
          sourceNode,
          targetNode,
          sourceRef,
          targetRef,
          relationshipIndex,
          type,
          inverseType,
          editable: isOutgoing
        });
      }
    }
    return rows;
  })();
  const localNodePath = resolveNodeFilePath(draft);
  const intakeAnalysis = frontMatter.intake_analysis && typeof frontMatter.intake_analysis === "object"
    ? frontMatter.intake_analysis
    : null;

  function updateFrontMatter(key, value) {
    setDraft({ ...draft, frontMatter: { ...frontMatter, [key]: value } });
  }

  function removeFrontMatterKey(key) {
    const next = { ...frontMatter };
    delete next[key];
    setDraft({ ...draft, frontMatter: next });
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

  function toggleSubtype(value) {
    const current = selectedSubtypes;
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value];
    setDraft({
      ...draft,
      frontMatter: {
        ...frontMatter,
        subtype: next[0] || undefined,
        subtypes: next.slice(1)
      }
    });
  }

  function updateCustomProperty(key, value) {
    if (!key) return;
    if (value === "") {
      removeFrontMatterKey(key);
      return;
    }
    updateFrontMatter(key, parseLoosePropertyValue(value));
  }

  function addCustomProperty() {
    const key = customKey.trim();
    if (!key) return;
    updateCustomProperty(key, customValue);
    setCustomKey("");
    setCustomValue("");
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
        </div>
        <div className="panel-actions panel-actions-primary">
          <button type="button" onClick={duplicateNode}>Duplicate</button>
          {type === "relationship" && <button type="button" onClick={() => collapseRelationshipNodeToSimple?.(draft)}>Collapse to simple</button>}
          {localNodePath && <button type="button" className="danger" onClick={deleteNode}>Remove</button>}
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
        defaultOpen={false}
      >
        <FieldLabel help="Choose one or more subtypes when the node needs a narrower role. The first selected subtype becomes the primary one, and the rest stay attached as additional subtypes." href={canonicalHelpUrl("property", "subtypes")}>Subtypes</FieldLabel>
        <SelectorChips
          values={allowedSubtypes}
          selected={selectedSubtypes}
          emptyLabel={allowedSubtypes.length ? "Choose any matching subtypes" : "No protocol subtypes for this type yet"}
          onToggle={toggleSubtype}
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
        title="Properties"
        helpTitle="Properties"
        help="Use typed properties when the protocol already expects them, then add custom fields only for details the standard shape does not cover yet."
        href={canonicalHelpUrl("property", typeSpecificFields[0]?.key || "title")}
        defaultOpen={typeSpecificFields.length > 0 || customPropertyEntries.length > 0}
      >
        {typeSpecificFields.length ? (
          <>
            <div className="panel-title">Type-specific fields</div>
            {typeSpecificFields.map((field) => (
              <div className="property-field" key={field.key}>
                <FieldLabel help={field.help} href={canonicalHelpUrl("property", field.key)}>{field.label}</FieldLabel>
                {field.value_kind === "boolean" ? (
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={Boolean(frontMatter[field.key])}
                      onChange={(event) => {
                        if (!event.target.checked) {
                          removeFrontMatterKey(field.key);
                          return;
                        }
                        updateFrontMatter(field.key, true);
                      }}
                    />
                    <span>
                      <strong>{field.label}</strong>
                      {field.help ? <small>{field.help}</small> : null}
                    </span>
                  </label>
                ) : field.value_kind === "enum" ? (
                  <select
                    value={formatPropertyValue(frontMatter[field.key])}
                    onChange={(event) => {
                      if (!event.target.value) {
                        removeFrontMatterKey(field.key);
                        return;
                      }
                      updateFrontMatter(field.key, event.target.value);
                    }}
                  >
                    <option value="">None</option>
                    {fieldOptionList(field).map((option) => (
                      <option value={option.value} key={`${field.key}-${option.value}`}>{option.label}</option>
                    ))}
                  </select>
                ) : field.list ? (
                  <input
                    value={Array.isArray(frontMatter[field.key]) ? frontMatter[field.key].join(", ") : ""}
                    onChange={(event) => {
                      const next = event.target.value.split(",").map((item) => item.trim()).filter(Boolean);
                      if (!next.length) {
                        removeFrontMatterKey(field.key);
                        return;
                      }
                      updateFrontMatter(field.key, next);
                    }}
                    placeholder="comma, separated, values"
                  />
                ) : (
                  <input
                    type={field.value_kind === "date" ? "date" : field.value_kind === "url" ? "url" : "text"}
                    value={formatPropertyValue(frontMatter[field.key])}
                    onChange={(event) => {
                      if (!event.target.value.trim()) {
                        removeFrontMatterKey(field.key);
                        return;
                      }
                      updateFrontMatter(field.key, event.target.value);
                    }}
                  />
                )}
              </div>
            ))}
          </>
        ) : (
          <div className="selector-empty">No protocol-specific fields are surfaced for this node type yet.</div>
        )}

        <div className="panel-title">Custom fields</div>
        <p className="field-help">These save directly onto the node so you can carry extra properties now without waiting for Studio to grow a dedicated control.</p>
        <div className="custom-property-form">
          <input
            value={customKey}
            onChange={(event) => setCustomKey(event.target.value)}
            placeholder="field_name"
          />
          <textarea
            rows={2}
            value={customValue}
            onChange={(event) => setCustomValue(event.target.value)}
            placeholder="value or JSON"
          />
          <button type="button" onClick={addCustomProperty} disabled={!customKey.trim()}>Add field</button>
        </div>
        {customPropertyEntries.length ? (
          <div className="custom-property-list">
            {customPropertyEntries.map(([key, value]) => (
              <div className="custom-property-card" key={key}>
                <div className="custom-property-head">
                  <strong>{key}</strong>
                  <button type="button" onClick={() => removeFrontMatterKey(key)}>Remove</button>
                </div>
                <textarea
                  rows={Array.isArray(value) || (value && typeof value === "object") ? 4 : 2}
                  value={formatPropertyValue(value)}
                  onChange={(event) => updateCustomProperty(key, event.target.value)}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="selector-empty">No custom fields yet.</div>
        )}
      </EditorFold>

      <EditorFold
        title="Publishing and Privacy"
        helpTitle="Authoring State"
        help="Draft keeps a node out of normal builds unless drafts are explicitly included. Shareable controls whether this node is exported into public protocol artifacts by default."
        href={canonicalHelpUrl("concept", "federated-knowledge-substrates")}
        defaultOpen={false}
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
        <EditorFold
          title={`Trail Sequence${trailSequence.length ? ` (${trailSequence.length})` : ""}`}
          helpTitle="Trail Sequence"
          help="Trails are ordered reading or movement paths through the graph. Pick the nodes in sequence and Studio will preserve that route when you save."
          href={canonicalHelpUrl("concept", "trail")}
          defaultOpen={trailSequence.length > 0}
        >
          <div className="panel-row">
            <div className="panel-title">Trail Sequence</div>
          </div>
          <div className="relationship-form">
            <select value={relationshipTarget} onChange={(e) => setRelationshipTarget(e.target.value)}>
              <option value="">Choose node for trail</option>
              {availableTrailTargets.map((node) => <option value={projectionNodeRef(node)} key={`trail-${nodeKey(node)}`}>{formatNodePickerLabel(node)}</option>)}
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
        </EditorFold>
      )}

      <EditorFold
        title={`Relationships${relationships.length ? ` (${relationships.length})` : ""}`}
        helpTitle="Relationships"
        help="Relationships say why two nodes belong together. Pick the meaning first, then choose a target or click two nodes on the graph."
        href={canonicalHelpUrl("concept", "typed-relationships")}
        defaultOpen={relationships.length > 0}
      >
        <div className="panel-row">
          <div className="panel-title">Relationships</div>
        </div>
        <div className="relationship-actions">
          <button type="button" disabled={!draft} onClick={() => openRelationshipPicker?.(draft)}>From this node to existing</button>
          <button type="button" disabled={!draft} onClick={() => openRelationshipNewNodePicker?.(draft)}>From this node to new</button>
        </div>
        {relationshipRows.length ? relationshipRows.map((row) => {
          const sourceLabel = row.sourceNode?.title || row.sourceNode?.id || row.sourceRef || "unknown source";
          const targetLabel = row.targetNode?.title || row.targetRef || "unknown target";
          const targetTypeLabel = relationshipLabel(row.inverseType || row.type);
          const sourceTypeLabel = relationshipLabel(row.type);
          return (
            <div
              className="relationship-chip"
              key={row.key}
              onContextMenu={(event) => {
                if (!row.editable) return;
                if (type === "relationship") return;
                if (!createRelationshipNodeFromRelationship) return;
                event.preventDefault();
                event.stopPropagation();
                createRelationshipNodeFromRelationship(draft, row.relationship);
              }}
            >
              <div className="relationship-chip-main">
                {row.editable ? (
                  <select
                    value={row.type || "related_to"}
                    onChange={(event) => updateRelationship(row.relationshipIndex, { type: event.target.value })}
                    aria-label="Relationship type"
                  >
                    {RELATIONSHIP_TYPE_DEFINITIONS.map((definition) => (
                      <option value={definition.type} key={definition.type}>{definition.label} ({definition.type})</option>
                    ))}
                  </select>
                ) : (
                  <span>{sourceTypeLabel}</span>
                )}
                <span>{sourceLabel}</span>
                <span>{" -> "}</span>
                <span>{targetLabel}</span>
                <small className="muted">target side: {targetTypeLabel}</small>
              </div>
              {row.editable && (
                <div className="relationship-chip-actions">
                  {type !== "relationship" && (
                    <button type="button" onClick={() => createRelationshipNodeFromRelationship?.(draft, row.relationship)}>Make relationship node</button>
                  )}
                  <button type="button" className="danger" onClick={() => removeRelationship(row.relationshipIndex)}>Remove</button>
                </div>
              )}
            </div>
          );
        }) : <p className="muted">No relationships yet.</p>}
      </EditorFold>

      <EditorFold title={`Suggestions${suggestions.length ? ` (${suggestions.length})` : ""}`} defaultOpen={false}>
        {suggestions.length ? suggestions.map((suggestion, i) => (
          <button className="suggestion" key={i} onClick={() => suggestion.action?.()}>{suggestion.text}</button>
        )) : <p className="muted">No suggestions right now.</p>}
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
  const sortedGroups = Object.entries(groups).map(([key, groupNodes]) => [key, sortNodesForPicker(groupNodes)]);
  return Object.fromEntries(sortedGroups.sort(([a], [b]) => compareGroupKeys(mode, a, b)));
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
  const relationshipNodeSignatures = new Set();
  for (const node of projectedNodes) {
    const sourceNode = node?.source || node;
    const frontMatter = sourceNode?.frontMatter || sourceNode?.data || sourceNode || {};
    const relationshipType = frontMatter.relationship_type || frontMatter.relationshipType || sourceNode?.relationship_type || sourceNode?.relationshipType;
    const sourceRef = normalizeNodeRef(frontMatter.source_node || frontMatter.source_node_id || sourceNode?.source_node || sourceNode?.source_node_id);
    const targetRef = normalizeNodeRef(frontMatter.target_node || frontMatter.target_node_id || sourceNode?.target_node || sourceNode?.target_node_id);
    const typeRef = normalizeNodeRef(relationshipType || frontMatter.subtype || frontMatter.type || sourceNode?.subtype || sourceNode?.type);
    if (sourceRef && targetRef && typeRef && (sourceNode?.type === "relationship" || frontMatter.type === "relationship" || relationshipType)) {
      relationshipNodeSignatures.add(`${sourceRef}|${typeRef}|${targetRef}`);
    }
  }

  const edgeFilter = (edge) => {
      const sourceRef = normalizeNodeRef(edge?.source?.id || edge?.source?.key || edge?.source);
      const targetRef = normalizeNodeRef(edge?.target?.id || edge?.target?.key || edge?.target);
      const typeRef = normalizeNodeRef(edge?.type || "related_to");
      if (!sourceRef || !targetRef || !typeRef) return true;
      return !relationshipNodeSignatures.has(`${sourceRef}|${typeRef}|${targetRef}`);
  };

  const { graph } = buildViewerGraphModel(projectedNodes, relationships, {
    focusId,
    exhaustive: true,
    registry: GRAPH_PROJECTION_REGISTRY,
    width: 900,
    height: 620,
    maxDepth,
    edgeFilter,
    edgeScore: (edge) => scoreViewerEdge(edge, projectedNodes, focusId),
    labelForEdge: (edge) => humanizeRelationship(edge.type || "related_to")
  });
  return {
    ...graph,
    hasVisibleEdges: graph.edges.length > 0
  };
}

function buildEffectiveGraphNodes(nodes, draft, selectedNode) {
  const baseNodes = Array.isArray(nodes) ? [...nodes] : [];
  const hydratedBaseNodes = hydratePrimaryMediaNodes(baseNodes);
  if (!draft) return hydratedBaseNodes;

  const draftNode = {
    ...draft,
    ...extractFrontMatterShape(draft),
    body: draft.body || draft.content || "",
    frontMatter: draft.frontMatter || extractFrontMatterShape(draft)
  };
  const draftRef = projectionNodeRef(draftNode);
  const selectedRef = projectionNodeRef(selectedNode);
  const replaceIndex = hydratedBaseNodes.findIndex((node) => {
    const nodeRef = projectionNodeRef(node);
    return nodeRef && (nodeRef === draftRef || nodeRef === selectedRef || nodeKey(node) === nodeKey(draftNode));
  });

  if (replaceIndex >= 0) {
    hydratedBaseNodes.splice(replaceIndex, 1, {
      ...hydratedBaseNodes[replaceIndex],
      ...draftNode,
      id: hydratedBaseNodes[replaceIndex].id || draftNode.id
    });
    return hydratePrimaryMediaNodes(hydratedBaseNodes);
  }

  return hydratePrimaryMediaNodes([...hydratedBaseNodes, draftNode]);
}

function hydratePrimaryMediaNodes(nodes = []) {
  const byRef = new Map();
  for (const node of nodes) {
    for (const ref of [
      projectionNodeRef(node),
      node?.protocolId,
      node?.protocol_id,
      node?.frontMatter?.protocol_id,
      node?.data?.protocol_id,
      node?.id
    ].filter(Boolean)) {
      byRef.set(normalizeNodeRef(ref), node);
    }
  }

  const primaryMediaByNodeRef = new Map();
  for (const node of nodes) {
    const sourceRef = normalizeNodeRef(projectionNodeRef(node));
    const relationships = Array.isArray(node?.frontMatter?.relationships)
      ? node.frontMatter.relationships
      : Array.isArray(node?.data?.relationships)
        ? node.data.relationships
        : Array.isArray(node?.relationships)
          ? node.relationships
          : [];
    for (const relationship of relationships) {
      const type = relationship?.type || "";
      const targetRef = normalizeNodeRef(relationship?.target || relationship?.to || relationship?.node || "");
      if (!targetRef) continue;
      if (type === "has_primary_media" && sourceRef) {
        primaryMediaByNodeRef.set(sourceRef, targetRef);
      }
      if (type === "used_as_primary_media_for") {
        primaryMediaByNodeRef.set(targetRef, sourceRef);
      }
    }
  }

  return nodes.map((node) => {
    const frontMatter = node?.frontMatter || node?.data || node || {};
    const nodeRef = normalizeNodeRef(projectionNodeRef(node));
    const primaryMediaRef = normalizeNodeRef(
      frontMatter.primary_media
      || frontMatter.primary_media_node?.protocol_id
      || frontMatter.primary_media_node?.id
      || primaryMediaByNodeRef.get(nodeRef)
      || ""
    );
    const resolvedMediaNode = primaryMediaRef ? byRef.get(primaryMediaRef) : null;
    if (!resolvedMediaNode) return node;
    const resolvedMediaFrontMatter = extractFrontMatterShape(resolvedMediaNode);
    if (!resolvedMediaFrontMatter.file) {
      resolvedMediaFrontMatter.file = resolvedMediaFrontMatter.asset_path || resolvedMediaFrontMatter.asset || "";
    }
    return {
      ...node,
      primary_media: primaryMediaRef,
      primary_media_node: resolvedMediaNode,
      frontMatter: {
        ...frontMatter,
        primary_media: primaryMediaRef,
        primary_media_node: resolvedMediaFrontMatter
      }
    };
  });
}

const DEFAULT_GRAPH_VIEWPORT = { x: 0, y: 0, scale: 1 };

function fitGraphViewport(nodes) {
  if (!nodes?.length) return DEFAULT_GRAPH_VIEWPORT;
  return fitReadableProjectionViewport(nodes, {
    padding: 86,
    width: 900,
    height: 620,
    maxScale: 1.45,
    minScale: 0.66
  });
}

function resolveGraphNodeMediaSrc(node, workspaceRoot) {
  const source = node?.source || node;
  const frontMatter = source?.frontMatter || source?.data || source || {};
  const mediaNode = frontMatter.primary_media_node || source?.primary_media_node || {};
  const candidates = [
    mediaNode.image,
    mediaNode.file,
    mediaNode.thumbnail,
    mediaNode.url,
    mediaNode.source_url,
    mediaNode.asset,
    mediaNode.asset_path,
    source?.image,
    frontMatter.image,
    frontMatter.asset,
    frontMatter.asset_path,
    source?.asset,
    source?.asset_path
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = resolveGraphMediaCandidate(candidate, workspaceRoot);
    if (resolved) return resolved;
  }
  return "";
}

function resolveGraphMediaCandidate(candidate, workspaceRoot) {
  const value = String(candidate || "").trim();
  if (!value) return "";
  if (/^(https?:|data:|blob:|file:)/i.test(value)) return value;
  if (/^[A-Za-z]:[\\/]/.test(value)) return toFileHref(value);
  if (value.startsWith("/")) return value;
  if (!workspaceRoot) return "";
  return toFileHref(`${workspaceRoot}\\${value.replaceAll("/", "\\")}`);
}

function toFileHref(filePath) {
  return `file:///${String(filePath || "").replaceAll("\\", "/").replace(/^([A-Za-z]):/, "$1:")}`;
}

function scaleGraphViewport(viewport, factor) {
  return {
    ...viewport,
    scale: clamp((viewport.scale || 1) * factor, 0.32, 3)
  };
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

function trimLabel(value, max) {
  const text = String(value || "Untitled");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}...` : text;
}

function uniqueList(values = []) {
  return values.filter((value, index, list) => value && list.indexOf(value) === index);
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
  const normalizedSubtypes = uniqueList([
    next.subtype,
    ...(Array.isArray(next.subtypes) ? next.subtypes : [])
  ]);
  next.subtype = normalizedSubtypes[0] || undefined;
  next.subtypes = normalizedSubtypes.slice(1);
  if (!next.subtypes.length) delete next.subtypes;
  if (!next.subtype) delete next.subtype;
  for (const field of [
    "protocolId",
    "relativeFile",
    "relativePath",
    "path",
    "filePath",
    "__file",
    "fullPath",
    "data",
    "raw",
    "source_file",
    "__pendingRelationshipSource",
    "__pendingRelationshipType"
  ]) {
    delete next[field];
  }
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

function compareGroupKeys(mode, keyA, keyB) {
  if (mode === "type") {
    const rankA = NODE_TYPE_ORDER.get(keyA);
    const rankB = NODE_TYPE_ORDER.get(keyB);
    if (rankA !== undefined || rankB !== undefined) {
      if (rankA === undefined) return 1;
      if (rankB === undefined) return -1;
      return rankA - rankB;
    }
  }
  return String(keyA || "").localeCompare(String(keyB || ""));
}

function sortNodesForPicker(nodes = []) {
  return [...nodes].sort(compareNodesForPicker);
}

function compareNodesForPicker(nodeA, nodeB) {
  const typeA = String(NODE_TYPES_BY_TYPE[nodeA?.type]?.label || nodeA?.type || "node");
  const typeB = String(NODE_TYPES_BY_TYPE[nodeB?.type]?.label || nodeB?.type || "node");
  const typeCompare = typeA.localeCompare(typeB);
  if (typeCompare) return typeCompare;
  const titleA = String(nodeA?.title || nodeA?.id || "");
  const titleB = String(nodeB?.title || nodeB?.id || "");
  const titleCompare = titleA.localeCompare(titleB);
  if (titleCompare) return titleCompare;
  return String(nodeKey(nodeA)).localeCompare(String(nodeKey(nodeB)));
}

function formatNodePickerLabel(node) {
  const title = node?.title || node?.id || "Untitled";
  const typeLabel = NODE_TYPES_BY_TYPE[node?.type]?.label || node?.type || "node";
  return `${title} — ${typeLabel}`;
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
    applyAugmentSession: unavailable,
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
    augmentStatus: unavailable,
    startAugment: unavailable,
    stopAugment: unavailable,
    augmentCreateSession: unavailable,
    augmentExtractSession: unavailable,
    augmentListCandidates: unavailable,
    augmentBulkReview: unavailable,
    augmentUpdateCandidate: unavailable,
    augmentSuggestRelationships: unavailable,
    augmentGetSubstrate: unavailable,
    startHugoPreview: unavailable,
    rebuildHugoPreview: unavailable,
    stopHugoPreview: unavailable,
    readTextFile: unavailable,
    onPreviewLog: () => {},
    onPreviewStopped: () => {},
    onStudioCommand: () => {},
    onWorkspaceProgress: () => {},
    onAugmentLog: () => {},
    onAugmentStopped: () => {}
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
