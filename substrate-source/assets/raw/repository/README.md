# XanaNode Studio

Created by [Christian Siefen](https://xananode.com/) for the [XanaNode project](https://xananode.com/).

Local-first desktop studio for making and maintaining XanaNode substrates.

Canonical protocol statement:

XanaNode is a protocol for independently authored knowledge substrates that preserve relationships, provenance, lineage, disagreement, and addressable fragments, so knowledge can move across tools and media without losing its structure.

Studio is where an author can shape a substrate directly: create a node, choose what kind of thing it is, connect it to other nodes with named relationships, check the work, and preview how the substrate can be projected for readers.

A substrate can be projected in more than one way. The graph projection helps authors see structure. The Hugo projection shows the same substrate as a readable website. Hugo is one lens, not the substrate itself.

This project is a XanaNode-compatible authoring application. Canonical specification: `https://github.com/kingc95/XanaNode`. Studio/reference implementation code is licensed under `Apache-2.0`; the XanaNode name and logo remain project trademarks.

## Current stack

```text
XanaNode Protocol
  |
@xananode/core
  |
@xananode/workspace
  |
XanaNode Studio
```

Hugo also depends on Core directly. That is intentional: people who use the Hugo theme without Studio still get the same protocol validation path.

## Repository substrate source

This repository now also emits its own explicit `substrate-source/` folder. That generated substrate treats Studio itself as a first-class XanaNode substrate so higher layers can federate with the Studio repo instead of re-deriving Studio facts ad hoc.

From `XanaNode-Master/`:

```bash
npm run studio:build-substrate-source
```

From this repository directly:

```bash
node tools/build-substrate-source.mjs
```

That writes:

- `substrate-source/substrate.json`
- `substrate-source/nodes.json`
- `substrate-source/relationships.json`
- `substrate-source/nodes/*.json`
- preserved raw repository artifacts under `substrate-source/assets/raw/repository/`

## What this version includes

- Electron + React + Vite desktop app
- Three-panel Studio layout
  - left: catalog views of the substrate
  - center: graph projection, Hugo projection, health, and logs
  - right: node editor
- Open existing workspace
- Intertwingle an existing `.substrate`, substrate folder, or registry-cloned substrate as a local working copy
- Create new workspace
- Create nodes
- Edit node title, type, subtype, facets, summary, and content
- Pick relationship types from the protocol registry
- Click two graph nodes to draft a relationship visually
- Import media/source assets through the Workspace API
- Build substrate artifacts through Workspace/Core
- Export portable `.substrate` archives for Hugo or other projection layers
- Run validation/health checks
- Save Git snapshots using friendlier language
- Start/stop local Hugo preview and embed it in the center panel
- live bridged dependencies on `XanaNode-Workspace`, `XanaNode-Core-SDK`, and `XanaNode-Hugo` during shared local development

## Install

```bash
npm run dev:bootstrap
```

That is the preferred setup when Studio lives inside `XanaNode-Master`. It links Studio's vendor paths back to the live sibling repos, then installs the root workspace dependencies once.

For a standalone Studio clone, the fallback setup is still:

```bash
git submodule update --init --recursive
npm install
```

## Run in development

```bash
npm run dev
```

The dev launcher will fall back to the next free local port if 5173 is already in use, and Electron will connect to that resolved URL automatically.

## Run Electron directly

```bash
npm start
```

## Build renderer

```bash
npm run build
```

## Test

```bash
npm test
```

## Important notes

Studio is not replacing Hugo. Hugo remains the public website projection for now. Studio can run Hugo locally when you want to see that lens, but the graph projection is available without starting Hugo.

Studio is also not trying to make Git the user experience. Git is used underneath as the default versioning layer, but the UI should speak in terms like **Save Snapshot**, **History**, **Publish**, and **Propose Change**.

Studio's **Intertwingle .substrate** action lets you pick a `.substrate` archive, a substrate folder, `substrate.json`, or another JSON file inside a substrate. If you already have a workspace open, Studio mounts that incoming substrate into the current workspace and keeps your local nodes in place. If no workspace is open yet, Studio can still open the incoming substrate as its own editable **working copy** under `Documents/XanaNode Studio Workspaces`.

The long-term flow is registry-first. The protocol registry lists known online federation targets, Workspace knows how to validate and clone them, and Studio should present that registry through Workspace rather than teaching users a separate import model. The thing being brought in is always another substrate, whether it arrived as a folder, a Git checkout, or a `.substrate` bundle.

If the incoming substrate came from another author or from the XanaNode Canonical substrate, Studio keeps the source node IDs and records the source substrate. Your changes are local **proposals** until the source substrate owner accepts them. In Studio language, **Intertwingle** means bringing another substrate into your local authoring context without silently claiming ownership. A **working copy** is your editable local copy when you intentionally open a substrate on its own, a **mounted substrate** is a temporary federated layer inside your current workspace, a **proposal** is an edit against a substrate you do not directly govern, and a **snapshot** is the local save point.

The demo workspace starts with a plain question: **How do you make a campfire?** That small example is there on purpose. It shows that a substrate can start with an everyday inquiry, then grow into claims, evidence, sources, safety gaps, and relationships.

## Next implementation steps

1. Preserve every unknown field while editing front matter.
2. Load the XanaNode Canonical substrate as a built-in manual graph.
3. Add author profile setup wizard.
4. Add Git history and visual diff UI.
5. Add substrate manager for mounted, unmounted, and intertwingled substrates.
6. Add media preview and source extraction.
7. Add AI/co-pilot integration as an optional provider interface.
8. Add native packaging through Electron Forge or Tauri alternative.

## Dependency Wiring

Inside `XanaNode-Master`, Studio should behave like part of one local development workspace. The effective local bridge is:

```text
vendor/xananode-workspace-repo -> XanaNode-Workspace
vendor/xananode-core -> XanaNode-Core-SDK
vendor/xananode-hugo -> XanaNode-Hugo
```

Workspace and Hugo still carry their own fallback Core paths, and Core still carries its fallback Protocol path. For shared local development, the root bridge makes those resolve to the live sibling repositories.

The older standalone-clone layout is still:

```text
XanaNode-Studio
  vendor/xananode-hugo -> XanaNode-Hugo
    vendor/xananode-core -> XanaNode-Core-SDK
      vendor/xananode-protocol -> XanaNode
  vendor/xananode-workspace-repo -> XanaNode-Workspace
    vendor/xananode-core -> XanaNode-Core-SDK
      vendor/xananode-protocol -> XanaNode
```

Hugo carries Core directly because Hugo must work for people who never open Studio. Workspace carries Core because it owns local substrate management, build orchestration, and health workflows. Studio now also links Core directly in local development so its graph projection and protocol assets do not depend on Workspace's internal folder shape.

After cloning Studio by itself, initialize everything with:

```bash
git submodule update --init --recursive
npm install
```

The package dependency is:

```json
"@xananode/workspace": "file:./vendor/xananode-workspace-repo"
```

Studio invokes the Hugo renderer from `vendor/xananode-hugo` when available. In the shared local workspace that path is linked to the live `XanaNode-Hugo` repo. The preview process prepares Hugo artifacts first and falls back to Core build output only if the Hugo prepare step fails.
