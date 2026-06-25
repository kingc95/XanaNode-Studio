import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const outDir = path.join(root, "src", "generated");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function git(args, cwd = root) {
  const result = spawnSync("git", ["-c", "safe.directory=*", ...args], { cwd, encoding: "utf8", shell: false });
  return result.status === 0 ? result.stdout.trim() : "";
}

const metadata = {
  name: pkg.name,
  product_name: "XanaNode Studio",
  version: pkg.version,
  built_at: new Date().toISOString(),
  git_commit: git(["rev-parse", "HEAD"]),
  git_branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
  repository: "kingc95/XanaNode-Studio",
  runtime: `node ${process.version}`,
  platform: `${process.platform}/${process.arch}`,
  dependencies: {
    workspace: git(["rev-parse", "HEAD"], path.join(root, "vendor", "xananode-workspace-repo")),
    hugo_theme: git(["rev-parse", "HEAD"], path.join(root, "vendor", "xananode-hugo")),
    core_sdk: git(["rev-parse", "HEAD"], path.join(root, "vendor", "xananode-workspace-repo", "vendor", "xananode-core")),
    protocol: git(["rev-parse", "HEAD"], path.join(root, "vendor", "xananode-workspace-repo", "vendor", "xananode-core", "vendor", "xananode-protocol"))
  }
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "build-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Wrote Studio build metadata ${metadata.version} ${metadata.git_commit || "no-git"}`);
