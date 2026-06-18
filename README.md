# XanaNode Studio

Local-first desktop studio for authoring XanaNode knowledge substrates.

This is the first usable scaffold for the real Studio app. It is intentionally built as a modular desktop shell around `@xananode/workspace`, which itself sits on `@xananode/core`.

## Current stack

```text
XanaNode Protocol
  ↓
@xananode/core
  ↓
@xananode/workspace
  ↓
XanaNode Studio
```

## What this first version includes

- Electron + React + Vite desktop app
- Three-panel Studio layout
  - left: substrate catalog / tools
  - center: Hugo preview, health, logs
  - right: node editor
- Open existing workspace
- Create new workspace
- Create nodes
- Edit node title/type/summary/content
- Add relationships with type-aware hints
- Import media/source assets through the Workspace API
- Build substrate artifacts through Workspace/Core
- Run validation/health checks
- Save Git snapshots using friendlier language
- Start/stop local Hugo preview and embed it in the center panel
- Git submodule dependency on `XanaNode-Workspace`

## Install

```bash
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

This is not trying to replace Hugo. Hugo remains the canonical published viewer for now. Studio runs Hugo locally and embeds the real rendered output so the editor does not drift from the website.

This is also not trying to make Git visible to normal users. Git is used underneath as the default versioning layer, but the UI uses terms like **Save Snapshot**, **History**, **Publish**, and **Propose Change**.

## Next implementation steps

1. Replace prompt-based new-node flow with a proper modal.
2. Add a real front matter editor that preserves unknown fields.
3. Add relationship schema registry autocomplete from `@xananode/core`.
4. Add author profile setup wizard.
5. Add Git history and visual diff UI.
6. Add import manager for federated substrates.
7. Add media preview and source extraction.
8. Add AI/co-pilot integration as an optional provider interface.
9. Add native packaging through Electron Forge or Tauri alternative.

## Dependency Wiring

Studio uses Git submodules for XanaNode packages that live in their own repos:

```text
vendor/xananode-hugo
vendor/xananode-workspace-repo
```

Workspace then carries Core SDK as its own submodule, and Core SDK carries the protocol repo as its own submodule:

```text
XanaNode-Studio
  vendor/xananode-hugo -> XanaNode-Hugo
  vendor/xananode-workspace-repo -> XanaNode-Workspace
    vendor/xananode-core -> XanaNode-Core-SDK
      vendor/xananode-protocol -> xananode
```

After cloning, initialize everything with:

```bash
git submodule update --init --recursive
npm install
```

The package dependency is:

```json
"@xananode/workspace": "file:./vendor/xananode-workspace-repo"
```
