import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import nodeTypeRegistry from "../../vendor/xananode-workspace-repo/vendor/xananode-core/vendor/xananode-protocol/schemas/xananode-node-types.v0.3.0.json";
import relationshipTypeRegistry from "../../vendor/xananode-workspace-repo/vendor/xananode-core/vendor/xananode-protocol/schemas/xananode-relationship-types.v0.5.0.json";
import xananodeIconUrl from "../../vendor/xananode-workspace-repo/vendor/xananode-core/vendor/xananode-protocol/media/images/xananode-icon.svg";
import buildMetadata from "../generated/build-metadata.json";
import "./styles/app.css";

const NODE_TYPE_DEFINITIONS = [...nodeTypeRegistry.node_types].sort((a, b) => a.label.localeCompare(b.label));
const NODE_TYPES = NODE_TYPE_DEFINITIONS.map((definition) => definition.type);
const NODE_TYPES_BY_TYPE = Object.fromEntries(NODE_TYPE_DEFINITIONS.map((definition) => [definition.type, definition]));
const RELATIONSHIP_TYPE_DEFINITIONS = [...relationshipTypeRegistry.relationship_types].sort((a, b) => {
  const categoryCompare = a.category.localeCompare(b.category);
  return categoryCompare || a.label.localeCompare(b.label);
});
const RELATIONSHIP_TYPES_BY_TYPE = Object.fromEntries(RELATIONSHIP_TYPE_DEFINITIONS.map((definition) => [definition.type, definition]));
const RELATIONSHIP_CATEGORIES = [...new Set(RELATIONSHIP_TYPE_DEFINITIONS.map((definition) => definition.category))].sort();

function App() {
  const [workspace, setWorkspace] = useState(null);
  const [status, setStatus] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [draft, setDraft] = useState(null);
  const [notice, setNotice] = useState(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewLogs, setPreviewLogs] = useState([]);
  const [centerMode, setCenterMode] = useState("graph");
  const [catalogMode, setCatalogMode] = useState("type");
  const [appMetadata, setAppMetadata] = useState(buildMetadata);
  const [projectionLayout, setProjectionLayout] = useState("single");
  const [projectionSplit, setProjectionSplit] = useState(55);
  const [relationshipLinkMode, setRelationshipLinkMode] = useState(null);
  const api = window.xananode || createUnavailableApi();
  const previewFrameRef = useRef(null);
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
    return () => {
      offLog?.();
      offStop?.();
    };
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), notice.type === "error" ? 7000 : 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

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

  function handlePreviewFrameLoad() {
    const frameWindow = previewFrameRef.current?.contentWindow;
    if (!frameWindow) return;

    try {
      loadPreviewLocation(frameWindow.location.href, "iframe load");
    } catch {
      setPreviewLogs((logs) => [
        ...logs.slice(-120),
        "[iframe load] Preview loaded. Node-click sync needs the Hugo preview bridge because the iframe is cross-origin.\n"
      ]);
    }
  }

  const nodes = workspace?.nodes || [];
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
    }
  }

  async function openPack() {
    const result = await run(() => api.openPack(), "Opened pack working copy");
    if (result?.workspace) {
      setStatus(null);
      setSelectedNode(result.workspace.nodes?.[0] || null);
      setDraft(null);
      setCenterMode("graph");
    }
  }

  async function createWorkspace(defaults = {}) {
    const result = await run(
      () => api.createWorkspace({
        name: defaults.name || "New XanaNode Substrate",
        author: defaults.author || "",
        git: defaults.git !== false,
        useDefaultLocation: defaults.useDefaultLocation !== false
      }),
      "Created workspace"
    );
    if (result?.workspace) {
      setStatus(null);
      setSelectedNode(result.workspace.nodes?.[0] || null);
      setDraft(null);
      setSetupOpen(false);
    }
    return result;
  }

  async function createTrialWorkspace() {
    const result = await createWorkspace({
      name: "XanaNode Studio Trial",
      author: "Studio Trial",
      git: false,
      useDefaultLocation: true
    });
    if (!result?.workspace) return;
    await run(
      () => api.createNode({
        node: {
          id: "how-to-make-a-campfire",
          title: "How do you make a campfire?",
          type: "question",
          subtype: "how_to",
          summary: "A practical question node for learning how inquiries, claims, sources, and steps connect.",
          relationships: [
            { type: "raises", target: "campfire-safety-gap" },
            { type: "requires_information", target: "campfire-safety-gap" }
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
            { type: "answers", target: "how-to-make-a-campfire" },
            { type: "requires", target: "campfire-safe-location" },
            { type: "requires", target: "dry-tinder-and-kindling" }
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
          relationships: [{ type: "supports", target: "campfire-basic-answer" }]
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
          relationships: [{ type: "supports", target: "campfire-basic-answer" }]
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
          relationships: [{ type: "context_for", target: "how-to-make-a-campfire" }]
        },
        body: "# What rules and fire conditions apply here?\n\nA complete answer needs local fire restrictions, current wind, drought conditions, and whether open flames are allowed.\n"
      }),
      "Seeded safety gap"
    );
    const refreshed = await run(() => api.refreshWorkspace(), "Trial workspace ready");
    if (refreshed?.workspace) {
      setSelectedNode(refreshed.workspace.nodes?.[0] || null);
      setCenterMode("graph");
    }
  }

  async function refreshStatus() {
    const result = await run(() => api.workspaceStatus(), "Workspace status refreshed");
    if (result) setStatus({ health: result.health, validation: result.validation });
  }

  async function startPreview() {
    const result = await run(() => api.startHugoPreview(), "Started Hugo preview");
    if (result?.url) {
      setPreviewUrl(result.url);
      setCenterMode("preview");
    }
  }

  async function saveNode() {
    if (!draft) return;
    const relativeFile = draft.relativePath || draft.path || draft.filePath || draft.__file;
    if (!relativeFile) {
      const result = await run(
        () => api.createNode({ node: draft.frontMatter || draft, body: draft.body || `# ${draft.title || "Untitled"}\n\n` }),
        "Created node"
      );
      const saved = findWorkspaceNode(result?.result?.data?.id || draft.frontMatter?.id || draft.frontMatter?.title, result?.workspace?.nodes || []);
      if (saved) {
        setSelectedNode(saved);
        setDraft(makeDraft(saved));
      }
      return;
    }
    const nodeData = draft.frontMatter || extractFrontMatterShape(draft);
    const result = await run(() => api.updateNode({ relativeFile, nodeData, body: draft.body || "" }), "Saved node");
    const saved = findWorkspaceNode(
      nodeData.protocol_id || nodeData.id || nodeData.title || relativeFile,
      result?.workspace?.nodes || []
    );
    if (saved) {
      setSelectedNode(saved);
      setDraft(makeDraft(saved));
    } else {
      setDraft({ ...draft, frontMatter: nodeData });
    }
  }

  async function saveSnapshot(reason) {
    if (!reason?.trim()) return;
    const result = await run(() => api.saveSnapshot({ message: reason.trim() }), "Saved snapshot");
    if (result?.ok) setSnapshotOpen(false);
  }

  function selectNode(node) {
    setSelectedNode(node);
    setDraft(makeDraft(node));
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
    const targetRef = node.id || node.slug || node.title;
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
          <button onClick={openPack}>Open Pack</button>
          <button disabled={!workspace} onClick={refreshStatus}>Health</button>
          <button disabled={!workspace} onClick={() => run(() => api.build(), "Built artifacts")}>Build</button>
          <button disabled={!workspace} onClick={() => run(() => api.exportPack(), "Exported pack")}>Export Pack</button>
          <button disabled={!workspace} onClick={startPreview}>Preview</button>
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

      {!workspace ? (
        <Welcome onOpen={openWorkspace} onCreate={() => setSetupOpen(true)} onTrial={createTrialWorkspace} />
      ) : (
        <main className="workspace-grid">
          <aside className="left-panel">
            <section className="panel-card workspace-card">
              <div className="panel-title">Workspace</div>
              <div className="small muted">{workspace.rootDir}</div>
              <div className="manifest-name">{workspace.manifest?.name || workspace.manifest?.id || "Unnamed substrate"}</div>
              {isCanonicalWorkspace(workspace) && (
                <div className="canon-warning">
                  You are viewing canonical XanaNode material. Explore freely; edits here become your own proposal until they are accepted back into the canon.
                </div>
              )}
              {isWorkingCopyWorkspace(workspace) && (
                <div className="working-copy-warning">
                  Working copy from {workspace.settings?.source_pack?.name || workspace.settings?.source_pack?.id || "an imported pack"}. Your changes are local proposals until the source owner accepts them.
                </div>
              )}
              <div className="pill-row">
                <span className="pill">{nodes.length} nodes</span>
                <span className="pill">{workspace.imports?.imports?.length || workspace.imports?.length || 0} imports</span>
                <span className="pill">Git {workspace.git?.enabled ? "on" : "off"}</span>
                {isWorkingCopyWorkspace(workspace) && <span className="pill">working copy</span>}
              </div>
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
              <button className="wide" onClick={() => run(() => api.importAssets(), "Imported assets")}>Import Media / Sources</button>
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
                <GraphView nodes={nodes} selectedNode={selectedNode} draft={draft} onSelect={handleGraphNodeClick} linkMode={relationshipLinkMode} />
                <PreviewView previewUrl={previewUrl} startPreview={startPreview} iframeRef={previewFrameRef} onFrameLoad={handlePreviewFrameLoad} logs={previewLogs} compact />
              </div>
            ) : (
              <>
                {centerMode === "graph" && <GraphView nodes={nodes} selectedNode={selectedNode} draft={draft} onSelect={handleGraphNodeClick} linkMode={relationshipLinkMode} />}
                {centerMode === "preview" && <PreviewView previewUrl={previewUrl} startPreview={startPreview} iframeRef={previewFrameRef} onFrameLoad={handlePreviewFrameLoad} logs={previewLogs} />}
              </>
            )}
            {centerMode === "health" && <HealthView status={status} refreshStatus={refreshStatus} />}
            {centerMode === "logs" && <LogView logs={previewLogs} />}
          </section>

          <aside className="right-panel">
            <EditorPanel
              draft={draft}
              setDraft={setDraft}
              nodes={nodes}
              suggestions={suggestions}
              addRelationship={addRelationship}
              startRelationshipLink={startRelationshipLink}
              saveNode={saveNode}
            />
          </aside>
        </main>
      )}
    </div>
  );
}

function Welcome({ onOpen, onCreate, onTrial }) {
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
      </div>
    </main>
  );
}

function WorkspaceSetup({ onCreate, onTrial, onClose }) {
  const [name, setName] = useState("New XanaNode Substrate");
  const [author, setAuthor] = useState("");
  const [git, setGit] = useState(true);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    await onCreate({ name, author, git, useDefaultLocation: true });
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
        <p className="setup-note">Studio will create the folder in Documents/XanaNode Studio Workspaces so you can start immediately.</p>
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

function GraphView({ nodes, selectedNode, draft, onSelect, linkMode }) {
  const current = draft || selectedNode || nodes[0] || null;
  const graph = useMemo(() => buildLocalGraph(nodes, current), [nodes, current]);

  if (!nodes.length) {
    return (
      <div className="empty-panel">
        <h2>No nodes yet.</h2>
        <p>Create the first node from the catalog panel.</p>
      </div>
    );
  }

  return (
    <div className={`graph-wrap ${linkMode ? "linking" : ""}`}>
      {linkMode && (
        <div className="graph-instruction">
          {linkMode.source ? `Target for ${linkMode.source.title || linkMode.source.id}` : "Click the source node for this relationship."}
        </div>
      )}
      <svg className="graph-svg" viewBox="0 0 900 620" role="img" aria-label="Workspace substrate graph">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(85, 214, 190, 0.72)" />
          </marker>
          {graph.nodes.map((node) => {
            const colors = nodeTypeColors(node.source);
            if (colors.length < 2) return null;
            return (
              <linearGradient id={nodeGradientId(node)} key={node.key} x1="0%" y1="0%" x2="100%" y2="100%">
                {colors.map((color, index) => (
                  <stop key={`${color}-${index}`} offset={`${Math.round((index / Math.max(1, colors.length - 1)) * 100)}%`} stopColor={color} />
                ))}
              </linearGradient>
            );
          })}
        </defs>
        {graph.edges.map((edge) => (
          <g key={edge.key}>
            <line
              className="edge"
              x1={edge.source.x}
              y1={edge.source.y}
              x2={edge.target.x}
              y2={edge.target.y}
              stroke={relationshipColor(edge.type)}
              strokeDasharray={relationshipDash(edge.type)}
              markerEnd="url(#arrow)"
            />
            <text className="edge-label" x={(edge.source.x + edge.target.x) / 2} y={(edge.source.y + edge.target.y) / 2 - 6}>
              {humanizeRelationship(edge.type)}
            </text>
          </g>
        ))}
        {graph.nodes.map((node) => (
          <g
            key={node.key}
            className={`graph-node ${node.selected ? "selected" : ""}`}
            transform={`translate(${node.x} ${node.y})`}
            onClick={() => onSelect(node.source)}
          >
            <circle
              r={node.selected ? 46 : 32}
              fill={nodeFill(node)}
              stroke={nodeStroke(node.source)}
            />
            <text textAnchor="middle" y="-3">{trimLabel(node.title, node.selected ? 24 : 16)}</text>
            <text className="graph-type" textAnchor="middle" y="15">{node.type || "node"}</text>
          </g>
        ))}
      </svg>
      <div className="graph-caption">
        {current ? `${graph.nodes.length} visible nodes around ${current.title || current.id || "selected node"}` : `${nodes.length} workspace nodes`}
      </div>
    </div>
  );
}

function PreviewView({ previewUrl, startPreview, iframeRef, onFrameLoad, logs, compact = false }) {
  if (!previewUrl) {
    return (
      <div className="empty-panel">
        <h2>Hugo preview is not running.</h2>
        <p>Start the local Hugo server when you want to inspect that projection layer.</p>
        <button className="primary" onClick={startPreview}>Start Hugo Preview</button>
      </div>
    );
  }
  return (
    <div className={`preview-shell ${compact ? "compact" : ""}`}>
      <iframe ref={iframeRef} className="preview-frame" src={previewUrl} title="XanaNode Hugo Preview" onLoad={onFrameLoad} />
      {!compact && <div className="preview-debug">
        <div className="panel-title">Preview Logs</div>
        <pre className="preview-log-stream">{logs.length ? logs.join("") : "Waiting for preview activity..."}</pre>
      </div>}
    </div>
  );
}

function HealthView({ status, refreshStatus }) {
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
  return (
    <div className="health-view">
      <div className="score-card">
        <div className="score">{score}</div>
        <div>Knowledge health</div>
      </div>
      <div className="health-columns">
        <section className="panel-card">
          <div className="panel-title">Issues</div>
          {issues.length ? issues.map((issue, i) => <div className="issue" key={i}>{formatIssue(issue)}</div>) : <p className="muted">No issues reported.</p>}
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

function EditorPanel({ draft, setDraft, nodes, suggestions, addRelationship, startRelationshipLink, saveNode }) {
  const [relationshipType, setRelationshipType] = useState("related_to");
  const [relationshipCategory, setRelationshipCategory] = useState("all");
  const [relationshipTarget, setRelationshipTarget] = useState("");
  const [relationshipQuery, setRelationshipQuery] = useState("");

  if (!draft) {
    return (
      <div className="editor-empty">
        <h2>No node selected</h2>
        <p>Select a node from the catalog or create a new one.</p>
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

  function updateFrontMatter(key, value) {
    setDraft({ ...draft, frontMatter: { ...frontMatter, [key]: value } });
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

  return (
    <div className="editor-panel">
      <div className="panel-row sticky-editor-head">
        <div>
          <div className="panel-title">Node Editor</div>
          <div className="small muted">{frontMatter.id || draft.id || draft.relativePath || "new node"}</div>
        </div>
        <button className="primary" onClick={saveNode}>Save Node</button>
      </div>

      <FieldLabel help="The name people see first. Keep it human: a person, question, claim, source, place, event, or thing someone can point to." href={canonicalHelpUrl("property", "title")}>Title</FieldLabel>
      <input value={frontMatter.title || ""} onChange={(e) => updateFrontMatter("title", e.target.value)} />

      <FieldLabel help="A node type says what kind of thing this is. Studio reads these from the protocol registry, so the choices stay aligned with Core and Hugo." href={canonicalHelpUrl("node-type", type)}>Type</FieldLabel>
      <select value={type} onChange={(e) => updateFrontMatter("type", e.target.value)}>
        {NODE_TYPE_DEFINITIONS.map((nodeType) => (
          <option value={nodeType.type} key={nodeType.type}>{nodeType.label} ({nodeType.type})</option>
        ))}
      </select>
      {typeDefinition?.purpose && <p className="field-help">{typeDefinition.purpose}</p>}

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

      <FieldLabel help="A short human sentence that tells readers why this node exists. If the graph only showed this line, it should still make sense." href={canonicalHelpUrl("property", "summary")}>Summary</FieldLabel>
      <textarea rows={3} value={frontMatter.summary || ""} onChange={(e) => updateFrontMatter("summary", e.target.value)} />

      <FieldLabel help="The authored prose for this node. Relationships, sources, and transclusions should carry the structure around it instead of forcing everything into text." href={canonicalHelpUrl("property", "content")}>Content</FieldLabel>
      <textarea className="body-editor" value={draft.body || ""} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />

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
            {nodes.map((node) => <option value={node.id || node.slug || node.title} key={nodeKey(node)}>{node.title || node.id}</option>)}
          </select>
          <button disabled={!relationshipTarget} onClick={() => {
            addRelationship(relationshipType, relationshipTarget);
            setRelationshipTarget("");
          }}>Add</button>
        </div>
        {relationships.length ? relationships.map((rel, i) => (
          <div className="relationship-chip" key={i}>
            <strong>{relationshipLabel(rel.type)}</strong>
            <span>{" -> "} {rel.target || rel.to || "unknown"}</span>
            {RELATIONSHIP_TYPES_BY_TYPE[rel.type]?.inverse && <small> inverse: {RELATIONSHIP_TYPES_BY_TYPE[rel.type].inverse}</small>}
          </div>
        )) : <p className="muted">No relationships yet.</p>}
      </section>

      <section className="editor-section">
        <div className="panel-title">Suggestions</div>
        {suggestions.map((suggestion, i) => (
          <button className="suggestion" key={i} onClick={() => suggestion.action?.()}>{suggestion.text}</button>
        ))}
      </section>
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

function buildLocalGraph(nodes, current) {
  const graphNodes = current && !nodes.some((node) => nodeKey(node) === nodeKey(current))
    ? [current, ...nodes]
    : nodes;
  const byRef = new Map();
  for (const node of graphNodes) {
    for (const ref of nodeRefs(node)) byRef.set(ref, node);
  }

  const currentRef = normalizeNodeRef(current?.id || current?.slug || current?.title || "");
  const rawEdges = [];
  for (const node of graphNodes) {
    const relationships = nodeRelationships(node);
    for (const rel of relationships) {
      const sourceRef = normalizeNodeRef(rel.source || node.protocolId || node.protocol_id || node.id || node.slug || node.title);
      const targetRef = normalizeNodeRef(rel.target || rel.to || rel.node || rel.id);
      const source = byRef.get(sourceRef);
      const target = byRef.get(targetRef);
      if (!sourceRef || !targetRef || !source || !target) continue;
      rawEdges.push({
        sourceRef,
        targetRef,
        source,
        target,
        type: rel.type || "related_to"
      });
    }
  }

  const visibleRefs = new Set();
  if (currentRef) visibleRefs.add(currentRef);
  for (const edge of rawEdges) {
    if (edge.sourceRef === currentRef) visibleRefs.add(edge.targetRef);
    if (edge.targetRef === currentRef) visibleRefs.add(edge.sourceRef);
  }

  if (!visibleRefs.size) {
    for (const node of graphNodes.slice(0, 16)) visibleRefs.add(normalizeNodeRef(node.id || node.slug || node.title));
  }

  let visibleNodes = [...visibleRefs]
    .map((ref) => byRef.get(ref))
    .filter(Boolean);
  if (visibleNodes.length < Math.min(graphNodes.length, 8)) {
    const existing = new Set(visibleNodes.map((node) => nodeKey(node)));
    for (const node of graphNodes) {
      if (visibleNodes.length >= 8) break;
      if (!existing.has(nodeKey(node))) visibleNodes.push(node);
    }
  }
  visibleNodes = visibleNodes.slice(0, 18);

  const centerX = 450;
  const centerY = 310;
  const radius = visibleNodes.length > 10 ? 245 : 205;
  const selectedIndex = Math.max(0, visibleNodes.findIndex((node) => normalizeNodeRef(node.id || node.slug || node.title) === currentRef));
  const arranged = visibleNodes.map((node, index) => {
    const selected = index === selectedIndex;
    if (selected) return { key: nodeKey(node), source: node, title: node.title || node.id || "Untitled", type: node.type, selected: true, x: centerX, y: centerY };
    const orbitIndex = index > selectedIndex ? index - 1 : index;
    const orbitCount = Math.max(1, visibleNodes.length - 1);
    const angle = (Math.PI * 2 * orbitIndex) / orbitCount - Math.PI / 2;
    return {
      key: nodeKey(node),
      source: node,
      title: node.title || node.id || "Untitled",
      type: node.type,
      selected: false,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius
    };
  });

  const arrangedByRef = new Map();
  for (const node of arranged) {
    for (const ref of nodeRefs(node.source)) arrangedByRef.set(ref, node);
  }

  const edges = rawEdges
    .map((edge, index) => ({
      key: `${edge.sourceRef}-${edge.type}-${edge.targetRef}-${index}`,
      source: arrangedByRef.get(edge.sourceRef),
      target: arrangedByRef.get(edge.targetRef),
      type: edge.type
    }))
    .filter((edge) => edge.source && edge.target && edge.source.key !== edge.target.key)
    .slice(0, 40);

  return { nodes: arranged, edges };
}

function nodeRefs(node) {
  return [
    node?.id,
    node?.protocolId,
    node?.protocol_id,
    node?.slug,
    node?.title,
    node?.relativePath,
    node?.path,
    node?.filePath,
    node?.frontMatter?.id,
    node?.frontMatter?.slug
  ].filter(Boolean).map(normalizeNodeRef);
}

function nodeRelationships(node) {
  const candidates = [
    node?.frontMatter?.relationships,
    node?.relationships,
    node?.data?.relationships
  ];
  const relationships = candidates.find(Array.isArray) || [];
  return relationships.map((relationship) => ({
    ...relationship,
    target: relationship.target || relationship.to || relationship.node || relationship.id
  }));
}

function nodeTypeColors(node) {
  const frontMatter = node?.frontMatter || node?.data || node || {};
  const types = [
    frontMatter.type || node?.type,
    ...(Array.isArray(frontMatter.facets) ? frontMatter.facets : [])
  ].filter(Boolean);
  const colors = types
    .map((type) => NODE_TYPES_BY_TYPE[type]?.color)
    .filter(Boolean);
  return [...new Set(colors)];
}

function nodeFill(node) {
  const colors = nodeTypeColors(node.source || node);
  if (colors.length > 1) return `url(#${nodeGradientId(node)})`;
  return colors[0] || "rgba(21, 25, 34, 0.96)";
}

function nodeGradientId(node) {
  return `node-gradient-${String(node?.key || "node").replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

function nodeStroke(node) {
  return nodeTypeColors(node)[0] || "rgba(255, 255, 255, 0.3)";
}

function relationshipColor(type) {
  return RELATIONSHIP_TYPES_BY_TYPE[type]?.color || "rgba(85, 214, 190, 0.72)";
}

function relationshipDash(type) {
  const style = RELATIONSHIP_TYPES_BY_TYPE[type]?.line_style || "";
  if (style === "dashed") return "8 6";
  if (style === "dotted") return "2 6";
  if (style === "double") return "12 3 2 3";
  return "";
}

function humanizeRelationship(value) {
  return String(value || "related_to").replace(/_/g, " ");
}

function trimLabel(value, max) {
  const text = String(value || "Untitled");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}...` : text;
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

function createUnavailableApi() {
  const unavailable = async () => ({
    ok: false,
    error: "Desktop workspace actions are available in the Electron app."
  });
  return {
    appMetadata: unavailable,
    openWorkspace: unavailable,
    openPack: unavailable,
    createWorkspace: unavailable,
    refreshWorkspace: unavailable,
    workspaceStatus: unavailable,
    createNode: unavailable,
    updateNode: unavailable,
    importAssets: unavailable,
    saveSnapshot: unavailable,
    build: unavailable,
    exportPack: unavailable,
    validate: unavailable,
    openInShell: unavailable,
    startHugoPreview: unavailable,
    stopHugoPreview: unavailable,
    readTextFile: unavailable,
    onPreviewLog: () => {},
    onPreviewStopped: () => {}
  };
}

createRoot(document.getElementById("root")).render(<App />);
