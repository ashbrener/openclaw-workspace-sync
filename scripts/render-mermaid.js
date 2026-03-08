#!/usr/bin/env node
/**
 * Pre-publish script: renders Mermaid code blocks in README.md to SVG images,
 * then replaces the ```mermaid blocks with <img> tags so npm renders them.
 *
 * GitHub renders Mermaid natively, so the original README.md (in git) keeps
 * the code blocks. This script only mutates README.md at publish time;
 * `git checkout README.md` restores the original after publish.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const readmePath = join(root, "README.md");
const diagramDir = join(root, "docs", "diagrams");

if (!existsSync(diagramDir)) {
  mkdirSync(diagramDir, { recursive: true });
}

const readme = readFileSync(readmePath, "utf-8");
const mermaidBlock = /```mermaid\n([\s\S]*?)```/g;

let index = 0;
let replaced = readme;

for (const match of readme.matchAll(mermaidBlock)) {
  const mermaidSource = match[1];
  const svgName = `mode-${index}.svg`;
  const svgPath = join(diagramDir, svgName);
  const tmpInput = join(diagramDir, `_tmp-${index}.mmd`);

  writeFileSync(tmpInput, mermaidSource);

  try {
    execFileSync(
      join(root, "node_modules", ".bin", "mmdc"),
      ["-i", tmpInput, "-o", svgPath, "-b", "transparent", "--theme", "neutral"],
      { timeout: 30_000, stdio: "pipe" },
    );
  } catch (err) {
    console.error(`Failed to render diagram ${index}:`, err.message);
    process.exit(1);
  }

  // Clean up temp file
  try { execFileSync("rm", [tmpInput]); } catch {}

  const imgTag = `<p align="center">\n  <img src="./docs/diagrams/${svgName}" alt="sync mode diagram" width="700" />\n</p>`;
  replaced = replaced.replace(match[0], imgTag);
  index++;
}

if (index === 0) {
  console.log("No mermaid blocks found in README.md");
  process.exit(0);
}

writeFileSync(readmePath, replaced);
console.log(`Rendered ${index} mermaid diagram(s) to docs/diagrams/`);
