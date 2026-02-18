/**
 * Tests for session start/end hook registration and behavior.
 *
 * Verifies that the plugin registers hooks correctly and that the hook
 * handlers call rclone with the right parameters based on config.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock rclone before importing the plugin
vi.mock("./rclone.js", () => ({
  setLogger: vi.fn(),
  isRcloneInstalled: vi.fn(),
  isRcloneConfigured: vi.fn(),
  ensureRcloneConfigFromConfig: vi.fn(),
  ensureRcloneInstalled: vi.fn(),
  resolveSyncConfig: vi.fn(),
  runBisync: vi.fn(),
  runSync: vi.fn(),
  checkRemote: vi.fn(),
  listRemote: vi.fn(),
  authorizeRclone: vi.fn(),
  writeRcloneConfig: vi.fn(),
  generateRcloneConfig: vi.fn(),
}));

vi.mock("./sync-manager.js", () => ({
  startSyncManager: vi.fn(),
  stopSyncManager: vi.fn(),
  getSyncManagerStatus: vi.fn(() => ({ running: false })),
}));

import * as rclone from "./rclone.js";
import workspaceSyncPlugin from "./index.js";

type HookHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<void>;

function createMockApi(pluginConfig: Record<string, unknown> = {}) {
  const hooks: Record<string, HookHandler> = {};

  const api = {
    id: "openclaw-workspace-sync",
    name: "Workspace Cloud Sync",
    source: "test",
    config: {},
    pluginConfig,
    runtime: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: vi.fn((p: string) => `/resolved/${p}`),
    on: vi.fn((hookName: string, handler: HookHandler) => {
      hooks[hookName] = handler;
    }),
  };

  return { api, hooks };
}

describe("workspace-sync session hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not register hooks when onSessionStart/End are false", () => {
    const { api, hooks } = createMockApi({
      provider: "dropbox",
      remotePath: "openclaw-share",
      onSessionStart: false,
      onSessionEnd: false,
    });

    workspaceSyncPlugin.register(api as any);

    expect(hooks.session_start).toBeUndefined();
    expect(hooks.session_end).toBeUndefined();
  });

  it("registers session_start hook when onSessionStart is true", () => {
    const { api, hooks } = createMockApi({
      provider: "dropbox",
      remotePath: "openclaw-share",
      onSessionStart: true,
    });

    workspaceSyncPlugin.register(api as any);

    expect(hooks.session_start).toBeDefined();
    expect(hooks.session_end).toBeUndefined();
  });

  it("registers session_end hook when onSessionEnd is true", () => {
    const { api, hooks } = createMockApi({
      provider: "dropbox",
      remotePath: "openclaw-share",
      onSessionEnd: true,
    });

    workspaceSyncPlugin.register(api as any);

    expect(hooks.session_start).toBeUndefined();
    expect(hooks.session_end).toBeDefined();
  });

  it("registers both hooks when both are enabled", () => {
    const { api, hooks } = createMockApi({
      provider: "dropbox",
      remotePath: "openclaw-share",
      onSessionStart: true,
      onSessionEnd: true,
    });

    workspaceSyncPlugin.register(api as any);

    expect(hooks.session_start).toBeDefined();
    expect(hooks.session_end).toBeDefined();
  });

  describe("session_start handler", () => {
    it("skips when provider is off", async () => {
      const { api, hooks } = createMockApi({
        provider: "off",
        onSessionStart: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_start!({}, { agentId: "main", sessionId: "s1" });

      expect(rclone.isRcloneInstalled).not.toHaveBeenCalled();
    });

    it("warns when rclone is not installed", async () => {
      vi.mocked(rclone.isRcloneInstalled).mockResolvedValue(false);

      const { api, hooks } = createMockApi({
        provider: "dropbox",
        remotePath: "openclaw-share",
        onSessionStart: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_start!({}, { agentId: "main", sessionId: "s1" });

      expect(rclone.isRcloneInstalled).toHaveBeenCalled();
      expect(api.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("rclone not installed"),
      );
    });

    it("warns when rclone is not configured", async () => {
      vi.mocked(rclone.isRcloneInstalled).mockResolvedValue(true);
      vi.mocked(rclone.isRcloneConfigured).mockReturnValue(false);
      vi.mocked(rclone.resolveSyncConfig).mockReturnValue({
        provider: "dropbox",
        remoteName: "cloud",
        remotePath: "openclaw-share",
        localPath: "/resolved/agents/main/workspace/shared",
        configPath: "/home/.config/rclone/rclone.conf",
        conflictResolve: "newer",
        exclude: [],
        copySymlinks: false,
        interval: 0,
        onSessionStart: true,
        onSessionEnd: false,
      });

      const { api, hooks } = createMockApi({
        provider: "dropbox",
        remotePath: "openclaw-share",
        onSessionStart: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_start!({}, { agentId: "main", sessionId: "s1" });

      expect(api.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('rclone not configured for "cloud"'),
      );
    });

    it("runs bisync on session start", async () => {
      vi.mocked(rclone.isRcloneInstalled).mockResolvedValue(true);
      vi.mocked(rclone.isRcloneConfigured).mockReturnValue(true);
      vi.mocked(rclone.resolveSyncConfig).mockReturnValue({
        provider: "dropbox",
        remoteName: "cloud",
        remotePath: "openclaw-share",
        localPath: "/workspace/shared",
        configPath: "/home/.config/rclone/rclone.conf",
        conflictResolve: "newer",
        exclude: [".git/**"],
        copySymlinks: false,
        interval: 0,
        onSessionStart: true,
        onSessionEnd: false,
      });
      vi.mocked(rclone.runBisync).mockResolvedValue({ ok: true });

      const { api, hooks } = createMockApi({
        provider: "dropbox",
        remotePath: "openclaw-share",
        onSessionStart: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_start!({}, { agentId: "main", sessionId: "s1" });

      expect(rclone.runBisync).toHaveBeenCalledWith(
        expect.objectContaining({
          remoteName: "cloud",
          remotePath: "openclaw-share",
          localPath: "/workspace/shared",
          conflictResolve: "newer",
        }),
      );
      expect(api.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("session start sync completed"),
      );
    });

    it("warns about --resync on first run error", async () => {
      vi.mocked(rclone.isRcloneInstalled).mockResolvedValue(true);
      vi.mocked(rclone.isRcloneConfigured).mockReturnValue(true);
      vi.mocked(rclone.resolveSyncConfig).mockReturnValue({
        provider: "dropbox",
        remoteName: "cloud",
        remotePath: "openclaw-share",
        localPath: "/workspace/shared",
        configPath: "/home/.config/rclone/rclone.conf",
        conflictResolve: "newer",
        exclude: [],
        copySymlinks: false,
        interval: 0,
        onSessionStart: true,
        onSessionEnd: false,
      });
      vi.mocked(rclone.runBisync).mockResolvedValue({
        ok: false,
        error: "bisync requires --resync on first run",
      });

      const { api, hooks } = createMockApi({
        provider: "dropbox",
        remotePath: "openclaw-share",
        onSessionStart: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_start!({}, { agentId: "main", sessionId: "s1" });

      expect(api.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("first sync requires manual --resync"),
      );
    });

    it("logs error on sync failure", async () => {
      vi.mocked(rclone.isRcloneInstalled).mockResolvedValue(true);
      vi.mocked(rclone.isRcloneConfigured).mockReturnValue(true);
      vi.mocked(rclone.resolveSyncConfig).mockReturnValue({
        provider: "dropbox",
        remoteName: "cloud",
        remotePath: "openclaw-share",
        localPath: "/workspace/shared",
        configPath: "/home/.config/rclone/rclone.conf",
        conflictResolve: "newer",
        exclude: [],
        copySymlinks: false,
        interval: 0,
        onSessionStart: true,
        onSessionEnd: false,
      });
      vi.mocked(rclone.runBisync).mockResolvedValue({
        ok: false,
        error: "connection timeout",
      });

      const { api, hooks } = createMockApi({
        provider: "dropbox",
        remotePath: "openclaw-share",
        onSessionStart: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_start!({}, { agentId: "main", sessionId: "s1" });

      expect(api.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("sync failed: connection timeout"),
      );
    });

    it("catches and logs unexpected errors", async () => {
      vi.mocked(rclone.isRcloneInstalled).mockRejectedValue(new Error("unexpected boom"));

      const { api, hooks } = createMockApi({
        provider: "dropbox",
        remotePath: "openclaw-share",
        onSessionStart: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_start!({}, { agentId: "main", sessionId: "s1" });

      expect(api.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("unexpected boom"),
      );
    });
  });

  describe("session_end handler", () => {
    it("runs bisync on session end", async () => {
      vi.mocked(rclone.isRcloneInstalled).mockResolvedValue(true);
      vi.mocked(rclone.isRcloneConfigured).mockReturnValue(true);
      vi.mocked(rclone.resolveSyncConfig).mockReturnValue({
        provider: "dropbox",
        remoteName: "cloud",
        remotePath: "openclaw-share",
        localPath: "/workspace/shared",
        configPath: "/home/.config/rclone/rclone.conf",
        conflictResolve: "newer",
        exclude: [],
        copySymlinks: false,
        interval: 0,
        onSessionStart: false,
        onSessionEnd: true,
      });
      vi.mocked(rclone.runBisync).mockResolvedValue({ ok: true, filesTransferred: 3 });

      const { api, hooks } = createMockApi({
        provider: "dropbox",
        remotePath: "openclaw-share",
        onSessionEnd: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_end!({}, { agentId: "main", sessionId: "s1" });

      expect(rclone.runBisync).toHaveBeenCalled();
      expect(api.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("session end sync completed"),
      );
    });

    it("skips silently when rclone not configured", async () => {
      vi.mocked(rclone.isRcloneInstalled).mockResolvedValue(true);
      vi.mocked(rclone.isRcloneConfigured).mockReturnValue(false);
      vi.mocked(rclone.resolveSyncConfig).mockReturnValue({
        provider: "dropbox",
        remoteName: "cloud",
        remotePath: "openclaw-share",
        localPath: "/workspace/shared",
        configPath: "/home/.config/rclone/rclone.conf",
        conflictResolve: "newer",
        exclude: [],
        copySymlinks: false,
        interval: 0,
        onSessionStart: false,
        onSessionEnd: true,
      });

      const { api, hooks } = createMockApi({
        provider: "dropbox",
        remotePath: "openclaw-share",
        onSessionEnd: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_end!({}, { agentId: "main", sessionId: "s1" });

      expect(rclone.runBisync).not.toHaveBeenCalled();
    });
  });
});
