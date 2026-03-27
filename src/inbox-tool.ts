import { join, resolve, relative, isAbsolute } from "node:path";
import { existsSync, readdirSync, renameSync, mkdirSync, statSync, cpSync, rmSync } from "node:fs";

export const INBOX_TOOL_NAME = "workspace_inbox";

export const InboxToolSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description:
        "Action to perform: list (show inbox files + workspace dirs), move (move inbox files to a target dir), peek (show contents of a specific inbox file path).",
      enum: ["list", "move", "peek"],
    },
    target: {
      type: "string",
      description:
        'For "move": relative directory path within the workspace to move files into (e.g. "CODE/myproject"). Created if it doesn\'t exist. For "peek": filename in _inbox to inspect.',
    },
    files: {
      type: "array",
      items: { type: "string" },
      description:
        'For "move": specific filenames to move from _inbox. If omitted, moves all inbox files.',
    },
  },
  required: ["action"],
};

type InboxToolParams = {
  action: "list" | "move" | "peek";
  target?: string;
  files?: string[];
};

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function listDirsRecursive(base: string, prefix: string, depth: number, maxDepth: number): string[] {
  if (depth >= maxDepth) return [];
  try {
    const entries = readdirSync(base, { withFileTypes: true });
    const dirs: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "_inbox" || e.name === "_outbox") continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      dirs.push(rel);
      dirs.push(...listDirsRecursive(join(base, e.name), rel, depth + 1, maxDepth));
    }
    return dirs;
  } catch {
    return [];
  }
}

export function createInboxTool(workspaceDir: string) {
  const inboxDir = join(workspaceDir, "_inbox");

  return {
    name: INBOX_TOOL_NAME,
    label: "Workspace Inbox",
    description:
      "Manage files that arrived in the workspace _inbox from cloud sync. " +
      "Actions: list (show inbox files and workspace directories), " +
      "move (move inbox files to a workspace directory), " +
      "peek (inspect an inbox file).",
    parameters: InboxToolSchema,
    async execute(_toolCallId: string, params: InboxToolParams) {
      const { action, target, files } = params;

      if (action === "list") {
        const inboxFiles: string[] = [];
        if (existsSync(inboxDir)) {
          for (const entry of readdirSync(inboxDir, { withFileTypes: true })) {
            const stat = statSync(join(inboxDir, entry.name));
            inboxFiles.push(
              entry.isDirectory()
                ? `📁 ${entry.name}/`
                : `📄 ${entry.name} (${formatBytes(stat.size)})`,
            );
          }
        }

        const workspaceDirs = listDirsRecursive(workspaceDir, "", 0, 3);

        return jsonResult({
          inbox: inboxFiles.length > 0 ? inboxFiles : ["(empty)"],
          workspaceDirectories: workspaceDirs.length > 0 ? workspaceDirs : ["(none)"],
          hint: 'Use action "move" with a target directory to move inbox files.',
        });
      }

      if (action === "peek") {
        if (!target) {
          return jsonResult({ error: "target (filename) is required for peek" });
        }
        const filePath = join(inboxDir, target);
        if (!existsSync(filePath)) {
          return jsonResult({ error: `File not found in inbox: ${target}` });
        }
        const stat = statSync(filePath);
        if (stat.isDirectory()) {
          const contents = readdirSync(filePath);
          return jsonResult({
            type: "directory",
            name: target,
            entries: contents.length > 50 ? [...contents.slice(0, 50), `… +${contents.length - 50} more`] : contents,
          });
        }
        return jsonResult({
          type: "file",
          name: target,
          size: formatBytes(stat.size),
          modified: stat.mtime.toISOString(),
        });
      }

      if (action === "move") {
        if (!target) {
          return jsonResult({ error: "target directory is required for move" });
        }

        if (isAbsolute(target)) {
          return jsonResult({ error: "target must be a relative path within the workspace" });
        }

        const destDir = resolve(workspaceDir, target);
        const wsReal = resolve(workspaceDir);
        if (!destDir.startsWith(wsReal)) {
          return jsonResult({ error: "target must be within the workspace" });
        }

        if (!existsSync(inboxDir)) {
          return jsonResult({ moved: [], error: "inbox is empty" });
        }

        const filesToMove = files ?? readdirSync(inboxDir);
        if (filesToMove.length === 0) {
          return jsonResult({ moved: [], message: "No files to move" });
        }

        mkdirSync(destDir, { recursive: true });

        const moved: string[] = [];
        const errors: string[] = [];

        for (const name of filesToMove) {
          const src = join(inboxDir, name);
          const dest = join(destDir, name);
          try {
            if (!existsSync(src)) {
              errors.push(`${name}: not found in inbox`);
              continue;
            }
            // Use copy+delete for cross-device moves
            const srcStat = statSync(src);
            if (srcStat.isDirectory()) {
              cpSync(src, dest, { recursive: true });
              rmSync(src, { recursive: true, force: true });
            } else {
              try {
                renameSync(src, dest);
              } catch {
                cpSync(src, dest);
                rmSync(src);
              }
            }
            moved.push(`${name} → ${relative(workspaceDir, dest)}`);
          } catch (err) {
            errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        return jsonResult({
          moved,
          errors: errors.length > 0 ? errors : undefined,
          remaining: existsSync(inboxDir) ? readdirSync(inboxDir).length : 0,
        });
      }

      return jsonResult({ error: `Unknown action: ${action}` });
    },
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
