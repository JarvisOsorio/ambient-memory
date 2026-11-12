#!/usr/bin/env node
/**
 * Build a versioned source+dist tarball/zip Jarvis can copy off this machine.
 * Does NOT publish to npm or GitHub.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const outDir = path.join(root, "release");
fs.mkdirSync(outDir, { recursive: true });

const stagingName = `ambient-memory-${version}`;
const staging = path.join(outDir, stagingName);
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

const include = [
  "bin",
  "src",
  "scripts",
  "test",
  "packaging",
  "dist",
  ".github",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  ".gitignore",
];

for (const item of include) {
  const src = path.join(root, item);
  if (!fs.existsSync(src)) continue;
  execFileSync("cp", ["-a", src, path.join(staging, item)]);
}

// Strip node_modules if somehow present
fs.rmSync(path.join(staging, "node_modules"), { recursive: true, force: true });

const tarPath = path.join(outDir, `${stagingName}.tar.gz`);
const zipPath = path.join(outDir, `${stagingName}.zip`);
execFileSync("tar", ["-czf", tarPath, "-C", outDir, stagingName]);
try {
  execFileSync("zip", ["-qr", zipPath, stagingName], { cwd: outDir });
} catch {
  console.warn("zip not available — tar.gz only");
}

const sha = execFileSync("sha256sum", [tarPath], { encoding: "utf8" }).trim();
fs.writeFileSync(path.join(outDir, `${stagingName}.tar.gz.sha256`), sha + "\n");

console.log(JSON.stringify({ tarPath, zipPath: fs.existsSync(zipPath) ? zipPath : null, sha }, null, 2));
