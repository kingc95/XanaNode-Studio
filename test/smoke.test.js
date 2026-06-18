import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildWorkspace,
  computeKnowledgeHealth,
  createNode,
  initWorkspace,
  openWorkspace
} from "@xananode/workspace";

assert.ok(fs.existsSync("src/main/main.js"));
assert.ok(fs.existsSync("src/preload/preload.cjs"));
assert.ok(fs.existsSync("src/renderer/main.jsx"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xananode-studio-"));
const workspace = await initWorkspace(dir, {
  name: "Studio Smoke Test",
  author: "Studio Tester",
  git: false
});

assert.equal(workspace.manifest.name, "Studio Smoke Test");

await createNode(
  dir,
  {
    title: "Studio Claim",
    type: "claim",
    summary: "A smoke-test claim."
  },
  "# Studio Claim\n\nThis claim was created from the Studio test.\n"
);

const reopened = await openWorkspace(dir);
assert.ok(reopened.nodes.some((node) => node.title === "Studio Claim"));

const health = await computeKnowledgeHealth(dir);
assert.equal(typeof health.score, "number");

const built = await buildWorkspace(dir, { out: path.join(dir, "public") });
assert.ok(fs.existsSync(path.join(built.outputDir, "substrate.json")));
