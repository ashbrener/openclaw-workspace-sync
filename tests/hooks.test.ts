/**
 * Tests for session start/end hook registration and behavior.
 *
 * Session hooks now delegate to triggerImmediateSync() from the sync manager,
 * checking isSyncing() first to avoid overlapping syncs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/rclone.js", () => ({
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

vi.mock("../src/sync-manager.js", () => ({
  startSyncManager: vi.fn(),
  stopSyncManager: vi.fn(),
  getSyncManagerStatus: vi.fn(() => ({ running: false })),
  isSyncing: vi.fn(() => false),
  triggerImmediateSync: vi.fn(),
}));

import * as syncManager from "../src/sync-manager.js";
import workspaceSyncPlugin from "../src/index.js";

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
      mode: "mailbox",
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
      mode: "mailbox",
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
      mode: "mailbox",
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
        mode: "mailbox",
        onSessionStart: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_start!({}, { agentId: "main", sessionId: "s1" });

      expect(syncManager.triggerImmediateSync).not.toHaveBeenCalled();
    });

    it("skips when mode is not set", async () => {
      const { api, hooks } = createMockApi({
        provider: "dropbox",
        remotePath: "openclaw-share",
        onSessionStart: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_start!({}, { agentId: "main", sessionId: "s1" });

      expect(api.logger.warn).toHaveBeenCalledWith(
        "[workspace-sync] mode not set, skipping session start sync",
      );
      expect(syncManager.triggerImmediateSync).not.toHaveBeenCalled();
    });

    it("skips when sync is already in progress", async () => {
      vi.mocked(syncManager.isSyncing).mockReturnValue(true);

      const { api, hooks } = createMockApi({
        provider: "dropbox",
        mode: "mailbox",
        remotePath: "openclaw-share",
        onSessionStart: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_start!({}, { agentId: "main", sessionId: "s1" });

      expect(api.logger.info).toHaveBeenCalledWith(
        "[workspace-sync] sync already in progress, skipping session start trigger",
      );
      expect(syncManager.triggerImmediateSync).not.toHaveBeenCalled();
    });

    it("calls triggerImmediateSync on session start", async () => {
      vi.mocked(syncManager.isSyncing).mockReturnValue(false);
      vi.mocked(syncManager.triggerImmediateSync).mockResolvedValue();

      const { api, hooks } = createMockApi({
        provider: "dropbox",
        mode: "mailbox",
        remotePath: "openclaw-share",
        onSessionStart: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_start!({}, { agentId: "main", sessionId: "s1" });

      expect(syncManager.triggerImmediateSync).toHaveBeenCalled();
    });

    it("catches and logs errors from triggerImmediateSync", async () => {
      vi.mocked(syncManager.isSyncing).mockReturnValue(false);
      vi.mocked(syncManager.triggerImmediateSync).mockRejectedValue(new Error("unexpected boom"));

      const { api, hooks } = createMockApi({
        provider: "dropbox",
        mode: "mailbox",
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
    it("skips when sync is already in progress", async () => {
      vi.mocked(syncManager.isSyncing).mockReturnValue(true);

      const { api, hooks } = createMockApi({
        provider: "dropbox",
        mode: "mailbox",
        remotePath: "openclaw-share",
        onSessionEnd: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_end!({}, { agentId: "main", sessionId: "s1" });

      expect(api.logger.info).toHaveBeenCalledWith(
        "[workspace-sync] sync already in progress, skipping session end trigger",
      );
      expect(syncManager.triggerImmediateSync).not.toHaveBeenCalled();
    });

    it("calls triggerImmediateSync on session end", async () => {
      vi.mocked(syncManager.isSyncing).mockReturnValue(false);
      vi.mocked(syncManager.triggerImmediateSync).mockResolvedValue();

      const { api, hooks } = createMockApi({
        provider: "dropbox",
        mode: "mailbox",
        remotePath: "openclaw-share",
        onSessionEnd: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_end!({}, { agentId: "main", sessionId: "s1" });

      expect(syncManager.triggerImmediateSync).toHaveBeenCalled();
    });

    it("skips silently when provider is off", async () => {
      const { api, hooks } = createMockApi({
        provider: "off",
        mode: "mailbox",
        remotePath: "openclaw-share",
        onSessionEnd: true,
      });

      workspaceSyncPlugin.register(api as any);
      await hooks.session_end!({}, { agentId: "main", sessionId: "s1" });

      expect(syncManager.triggerImmediateSync).not.toHaveBeenCalled();
    });
  });
});
