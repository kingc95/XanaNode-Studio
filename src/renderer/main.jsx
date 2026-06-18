import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";

const NODE_TYPES = [
  "person",
  "concept",
  "claim",
  "source",
  "essay",
  "observation",
  "media",
  "event",
  "place",
  "organization",
  "project",
  "technology",
  "publication",
  "community",
  "relationship",
  "revision",
  "trail",
  "schema",
  "fragment"
];
const RELATIONSHIP_HINTS = {
  claim: ["supports", "contradicts", "evidence_for", "derived_from", "cites", "qualified_by"],
  source: ["supports", "derived_from", "cites", "contains", "transcludes"],
  concept: ["related_to", "broader_than", "narrower_than", "explains", "derived_from"],
  publication: ["contains", "created_by", "cites", "derived_from"],
  event: ["caused_by", "resulted_in", "occurred_at", "involved"],
  trail: ["starts_with", "continues_to", "ends_with"]
};

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
  const [centerMode, setCenterMode] = useState("preview");
  const [catalogMode, setCatalogMode] = useState("type");
  const api = window.xananode || createUnavailableApi();
  const previewFrameRef = useRef(null);
  const lastPreviewNodeRef = useRef("");

  useEffect(() => {
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
          title: "Typed Relationships Preserve Context",
          type: "claim",
          summary: "A claim node seeded so Studio has something to edit and validate.",
          relationships: [{ type: "supports", target: "xananode-studio" }]
        },
        body: "# Typed Relationships Preserve Context\n\nThis starter claim is here so you can test editing, relationships, health, build, and preview without creating content first.\n"
      }),
      "Seeded trial claim"
    );
    await run(
      () => api.createNode({
        node: {
          id: "xananode-studio",
          title: "XanaNode Studio",
          type: "project",
          summary: "A local-first workbench for authoring XanaNode substrates.",
          relationships: []
        },
        body: "# XanaNode Studio\n\nUse this seeded project node to test the catalog, editor, preview, and snapshot workflow.\n"
      }),
      "Seeded trial project"
    );
    const refreshed = await run(() => api.refreshWorkspace(), "Trial workspace ready");
    if (refreshed?.workspace) {
      setSelectedNode(refreshed.workspace.nodes?.[0] || null);
      setCenterMode("preview");
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
      await run(
        () => api.createNode({ node: draft.frontMatter || draft, body: draft.body || `# ${draft.title || "Untitled"}\n\n` }),
        "Created node"
      );
      setDraft(null);
      return;
    }
    const nodeData = draft.frontMatter || extractFrontMatterShape(draft);
    await run(() => api.updateNode({ relativeFile, nodeData, body: draft.body || "" }), "Saved node");
    setDraft(null);
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
  }

  function addRelationship(type, target) {
    if (!draft) return;
    const frontMatter = { ...(draft.frontMatter || extractFrontMatterShape(draft)) };
    const relationships = Array.isArray(frontMatter.relationships) ? [...frontMatter.relationships] : [];
    relationships.push({ type, target, summary: "" });
    setDraft({ ...draft, frontMatter: { ...frontMatter, relationships } });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="logo-mark">X</div>
          <div>
            <div className="brand-title">XanaNode Studio</div>
            <div className="brand-subtitle">Local-first substrate workbench</div>
          </div>
        </div>
        <div className="top-actions">
          <button onClick={() => setSetupOpen(true)}>New</button>
          <button onClick={openWorkspace}>Open</button>
          <button disabled={!workspace} onClick={refreshStatus}>Health</button>
          <button disabled={!workspace} onClick={() => run(() => api.build(), "Built artifacts")}>Build</button>
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
              <div className="pill-row">
                <span className="pill">{nodes.length} nodes</span>
                <span className="pill">{workspace.imports?.imports?.length || workspace.imports?.length || 0} imports</span>
                <span className="pill">Git {workspace.git?.enabled ? "on" : "off"}</span>
              </div>
            </section>

            <section className="panel-card">
              <div className="panel-row">
                <div className="panel-title">Catalog</div>
                <select value={catalogMode} onChange={(e) => setCatalogMode(e.target.value)}>
                  <option value="type">Type</option>
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
            <div className="center-tabs">
              <button className={centerMode === "preview" ? "active" : ""} onClick={() => setCenterMode("preview")}>Hugo Preview</button>
              <button className={centerMode === "health" ? "active" : ""} onClick={() => setCenterMode("health")}>Health</button>
              <button className={centerMode === "logs" ? "active" : ""} onClick={() => setCenterMode("logs")}>Logs</button>
            </div>
            {centerMode === "preview" && <PreviewView previewUrl={previewUrl} startPreview={startPreview} iframeRef={previewFrameRef} onFrameLoad={handlePreviewFrameLoad} logs={previewLogs} />}
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
        <h1>Author the substrate for the Hugo preview.</h1>
        <p>Open a local XanaNode workspace, edit nodes, manage relationships, preview the published Hugo site, validate the substrate, and save clean snapshots without making Git the interface.</p>
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

function PreviewView({ previewUrl, startPreview, iframeRef, onFrameLoad, logs }) {
  if (!previewUrl) {
    return (
      <div className="empty-panel">
        <h2>Hugo preview is not running.</h2>
        <p>Start the local Hugo server to see the substrate exactly as it will publish.</p>
        <button className="primary" onClick={startPreview}>Start Hugo Preview</button>
      </div>
    );
  }
  return (
    <div className="preview-shell">
      <iframe ref={iframeRef} className="preview-frame" src={previewUrl} title="XanaNode Hugo Preview" onLoad={onFrameLoad} />
      <div className="preview-debug">
        <div className="panel-title">Preview Logs</div>
        <pre className="preview-log-stream">{logs.length ? logs.join("") : "Waiting for preview activity..."}</pre>
      </div>
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

function EditorPanel({ draft, setDraft, nodes, suggestions, addRelationship, saveNode }) {
  const [relationshipType, setRelationshipType] = useState("related_to");
  const [relationshipTarget, setRelationshipTarget] = useState("");

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
  const relationshipHints = RELATIONSHIP_HINTS[type] || ["related_to", "derived_from", "supports", "contradicts"];

  function updateFrontMatter(key, value) {
    setDraft({ ...draft, frontMatter: { ...frontMatter, [key]: value } });
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

      <label>Title</label>
      <input value={frontMatter.title || ""} onChange={(e) => updateFrontMatter("title", e.target.value)} />

      <label>Type</label>
      <select value={type} onChange={(e) => updateFrontMatter("type", e.target.value)}>
        {NODE_TYPES.map((nodeType) => <option key={nodeType}>{nodeType}</option>)}
      </select>

      <label>Summary</label>
      <textarea rows={3} value={frontMatter.summary || ""} onChange={(e) => updateFrontMatter("summary", e.target.value)} />

      <label>Content</label>
      <textarea className="body-editor" value={draft.body || ""} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />

      <section className="editor-section">
        <div className="panel-title">Relationships</div>
        <div className="relationship-form">
          <select value={relationshipType} onChange={(e) => setRelationshipType(e.target.value)}>
            {[...new Set([relationshipType, ...relationshipHints])].map((type) => <option key={type}>{type}</option>)}
          </select>
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
          <div className="relationship-chip" key={i}>{rel.type || "related_to"} {"->"} {rel.target || rel.to || "unknown"}</div>
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
    if (mode === "author") key = node.created_by || node.author || "unknown author";
    if (mode === "status") key = node.status || "draft/unknown";
    if (!groups[key]) groups[key] = [];
    groups[key].push(node);
  }
  return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)));
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
  const ignored = new Set(["body", "content", "frontMatter", "relativePath", "path", "filePath", "__file"]);
  const result = {};
  for (const [key, value] of Object.entries(node || {})) {
    if (!ignored.has(key)) result[key] = value;
  }
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

function createUnavailableApi() {
  const unavailable = async () => ({
    ok: false,
    error: "Desktop workspace actions are available in the Electron app."
  });
  return {
    openWorkspace: unavailable,
    createWorkspace: unavailable,
    refreshWorkspace: unavailable,
    workspaceStatus: unavailable,
    createNode: unavailable,
    updateNode: unavailable,
    importAssets: unavailable,
    saveSnapshot: unavailable,
    build: unavailable,
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
