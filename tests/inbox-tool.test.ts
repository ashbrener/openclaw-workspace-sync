import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInboxTool } from "../src/inbox-tool.js";

describe("inbox-tool", () => {
  let wsDir: string;
  let inboxDir: string;
  let tool: ReturnType<typeof createInboxTool>;

  beforeEach(() => {
    wsDir = join(tmpdir(), `inbox-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(wsDir, { recursive: true });
    inboxDir = join(wsDir, "_inbox");
    mkdirSync(inboxDir, { recursive: true });
    tool = createInboxTool(wsDir);
  });

  afterEach(() => {
    rmSync(wsDir, { recursive: true, force: true });
  });

  function getResult(res: { content: { text: string }[] }) {
    return JSON.parse(res.content[0].text);
  }

  describe("list", () => {
    it("shows empty inbox", async () => {
      rmSync(inboxDir, { recursive: true, force: true });
      mkdirSync(inboxDir, { recursive: true });
      const res = await tool.execute("test", { action: "list" });
      const data = getResult(res);
      expect(data.inbox).toEqual(["(empty)"]);
    });

    it("lists inbox files with sizes", async () => {
      writeFileSync(join(inboxDir, "hello.txt"), "hello world");
      const res = await tool.execute("test", { action: "list" });
      const data = getResult(res);
      expect(data.inbox).toHaveLength(1);
      expect(data.inbox[0]).toContain("hello.txt");
    });

    it("lists workspace directories", async () => {
      mkdirSync(join(wsDir, "CODE"), { recursive: true });
      mkdirSync(join(wsDir, "docs"), { recursive: true });
      const res = await tool.execute("test", { action: "list" });
      const data = getResult(res);
      expect(data.workspaceDirectories).toContain("CODE");
      expect(data.workspaceDirectories).toContain("docs");
    });

    it("lists nested directories up to depth 3", async () => {
      mkdirSync(join(wsDir, "CODE", "project", "src"), { recursive: true });
      const res = await tool.execute("test", { action: "list" });
      const data = getResult(res);
      expect(data.workspaceDirectories).toContain("CODE");
      expect(data.workspaceDirectories).toContain("CODE/project");
      expect(data.workspaceDirectories).toContain("CODE/project/src");
    });

    it("excludes hidden dirs, node_modules, _inbox, _outbox", async () => {
      mkdirSync(join(wsDir, ".git"), { recursive: true });
      mkdirSync(join(wsDir, "node_modules"), { recursive: true });
      mkdirSync(join(wsDir, "_outbox"), { recursive: true });
      mkdirSync(join(wsDir, "real"), { recursive: true });
      const res = await tool.execute("test", { action: "list" });
      const data = getResult(res);
      expect(data.workspaceDirectories).toContain("real");
      expect(data.workspaceDirectories).not.toContain(".git");
      expect(data.workspaceDirectories).not.toContain("node_modules");
      expect(data.workspaceDirectories).not.toContain("_outbox");
      expect(data.workspaceDirectories).not.toContain("_inbox");
    });
  });

  describe("peek", () => {
    it("returns file info", async () => {
      writeFileSync(join(inboxDir, "doc.pdf"), Buffer.alloc(2048));
      const res = await tool.execute("test", { action: "peek", target: "doc.pdf" });
      const data = getResult(res);
      expect(data.type).toBe("file");
      expect(data.name).toBe("doc.pdf");
      expect(data.size).toBe("2.0KB");
    });

    it("returns directory entries", async () => {
      mkdirSync(join(inboxDir, "folder"));
      writeFileSync(join(inboxDir, "folder", "a.txt"), "a");
      writeFileSync(join(inboxDir, "folder", "b.txt"), "b");
      const res = await tool.execute("test", { action: "peek", target: "folder" });
      const data = getResult(res);
      expect(data.type).toBe("directory");
      expect(data.entries).toContain("a.txt");
      expect(data.entries).toContain("b.txt");
    });

    it("returns error for missing file", async () => {
      const res = await tool.execute("test", { action: "peek", target: "nope.txt" });
      const data = getResult(res);
      expect(data.error).toContain("not found");
    });

    it("requires target", async () => {
      const res = await tool.execute("test", { action: "peek" });
      const data = getResult(res);
      expect(data.error).toContain("required");
    });
  });

  describe("move", () => {
    it("moves all inbox files to target dir", async () => {
      writeFileSync(join(inboxDir, "a.txt"), "aaa");
      writeFileSync(join(inboxDir, "b.txt"), "bbb");
      const res = await tool.execute("test", { action: "move", target: "CODE/project" });
      const data = getResult(res);
      expect(data.moved).toHaveLength(2);
      expect(existsSync(join(wsDir, "CODE", "project", "a.txt"))).toBe(true);
      expect(existsSync(join(wsDir, "CODE", "project", "b.txt"))).toBe(true);
      expect(data.remaining).toBe(0);
    });

    it("moves specific files only", async () => {
      writeFileSync(join(inboxDir, "a.txt"), "aaa");
      writeFileSync(join(inboxDir, "b.txt"), "bbb");
      const res = await tool.execute("test", { action: "move", target: "docs", files: ["a.txt"] });
      const data = getResult(res);
      expect(data.moved).toHaveLength(1);
      expect(existsSync(join(wsDir, "docs", "a.txt"))).toBe(true);
      expect(existsSync(join(inboxDir, "b.txt"))).toBe(true);
      expect(data.remaining).toBe(1);
    });

    it("creates target directory if missing", async () => {
      writeFileSync(join(inboxDir, "f.txt"), "data");
      expect(existsSync(join(wsDir, "new-dir"))).toBe(false);
      await tool.execute("test", { action: "move", target: "new-dir" });
      expect(existsSync(join(wsDir, "new-dir", "f.txt"))).toBe(true);
    });

    it("rejects absolute target paths", async () => {
      writeFileSync(join(inboxDir, "f.txt"), "data");
      const res = await tool.execute("test", { action: "move", target: "/tmp/evil" });
      const data = getResult(res);
      expect(data.error).toContain("relative path");
    });

    it("rejects path traversal", async () => {
      writeFileSync(join(inboxDir, "f.txt"), "data");
      const res = await tool.execute("test", { action: "move", target: "../../etc" });
      const data = getResult(res);
      expect(data.error).toContain("within the workspace");
    });

    it("requires target", async () => {
      const res = await tool.execute("test", { action: "move" });
      const data = getResult(res);
      expect(data.error).toContain("required");
    });

    it("handles directory items in inbox", async () => {
      mkdirSync(join(inboxDir, "subdir"));
      writeFileSync(join(inboxDir, "subdir", "inner.txt"), "inner");
      const res = await tool.execute("test", { action: "move", target: "dest" });
      const data = getResult(res);
      expect(data.moved).toHaveLength(1);
      expect(existsSync(join(wsDir, "dest", "subdir", "inner.txt"))).toBe(true);
      expect(existsSync(join(inboxDir, "subdir"))).toBe(false);
    });
  });
});
