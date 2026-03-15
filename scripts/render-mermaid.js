#!/usr/bin/env node
/**
 * Renders Mermaid code blocks in README.src.md to SVG images,
 * then writes README.md with the mermaid blocks replaced by <img> tags.
 *
 * Source of truth: README.src.md (what you edit, has mermaid blocks)
 * Output: README.md (generated, has <img> tags pointing to committed SVGs)
 *
 * Run manually or let the GitHub Action handle it on push.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const srcPath = join(root, "README.src.md");
const outPath = join(root, "README.md");
const diagramDir = join(root, "docs", "diagrams");
const configFile = join(root, "scripts", "mermaid-config.json");
const cssFile = join(root, "scripts", "mermaid-style.css");

if (!existsSync(srcPath)) {
  console.error("README.src.md not found");
  process.exit(1);
}

if (!existsSync(diagramDir)) {
  mkdirSync(diagramDir, { recursive: true });
}

const readme = readFileSync(srcPath, "utf-8");
const mermaidBlock = /```mermaid\n([\s\S]*?)```/g;

let index = 0;
let output = readme;

for (const match of readme.matchAll(mermaidBlock)) {
  const mermaidSource = match[1];
  const svgName = `mode-${index}.svg`;
  const svgPath = join(diagramDir, svgName);
  const tmpInput = join(diagramDir, `_tmp-${index}.mmd`);

  writeFileSync(tmpInput, mermaidSource);

  try {
    execFileSync(
      join(root, "node_modules", ".bin", "mmdc"),
      ["-i", tmpInput, "-o", svgPath, "-b", "white", "-c", configFile, "-C", cssFile],
      { timeout: 30_000, stdio: "pipe" },
    );
  } catch (err) {
    console.error(`Failed to render diagram ${index}:`, err.message);
    process.exit(1);
  }

  try { unlinkSync(tmpInput); } catch {}

  const rawUrl = `https://raw.githubusercontent.com/ashbrener/openclaw-workspace-sync/main/docs/diagrams/${svgName}`;
  const altText = index <= 2 ? "sync mode diagram" : "backup pipeline diagram";
  const imgTag = `<p align="center">\n  <img src="${rawUrl}" alt="${altText}" width="700" />\n</p>`;
  output = output.replace(match[0], imgTag);
  index++;
}

if (index === 0) {
  console.log("No mermaid blocks found in README.src.md — copying as-is");
}

writeFileSync(outPath, output);
console.log(`Rendered ${index} diagram(s) → README.md`);
