import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { startSyncManager, stopSyncManager, getSyncManagerStatus } from "./sync-manager.js";

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("sync-manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopSyncManager();
  });

  afterEach(() => {
    stopSyncManager();
  });

  describe("getSyncManagerStatus", () => {
    it("returns idle state when not started", () => {
      const status = getSyncManagerStatus();
      expect(status.running).toBe(false);
      expect(status.lastSyncAt).toBeNull();
      expect(status.lastSyncOk).toBeNull();
      expect(status.syncCount).toBe(0);
      expect(status.errorCount).toBe(0);
    });
  });

  describe("startSyncManager", () => {
    it("logs and returns when provider is off", () => {
      startSyncManager({ provider: "off" }, "/workspace", "/state", mockLogger);

      expect(mockLogger.info).toHaveBeenCalledWith(
        "[workspace-sync] Workspace sync not configured",
      );
      expect(getSyncManagerStatus().running).toBe(false);
    });

    it("logs and returns when provider is undefined", () => {
      startSyncManager({}, "/workspace", "/state", mockLogger);

      expect(mockLogger.info).toHaveBeenCalledWith(
        "[workspace-sync] Workspace sync not configured",
      );
      expect(getSyncManagerStatus().running).toBe(false);
    });

    it("logs disabled when interval is 0", () => {
      startSyncManager(
        { provider: "dropbox", interval: 0 },
        "/workspace",
        "/state",
        mockLogger,
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        "[workspace-sync] Periodic sync disabled (interval=0)",
      );
      expect(getSyncManagerStatus().running).toBe(false);
    });

    it("enforces minimum 60s interval", () => {
      startSyncManager(
        { provider: "dropbox", interval: 10 },
        "/workspace",
        "/state",
        mockLogger,
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "[workspace-sync] Interval increased from 10s to 60s (minimum)",
      );
      expect(getSyncManagerStatus().running).toBe(true);
    });

    it("starts with valid interval", () => {
      startSyncManager(
        { provider: "dropbox", interval: 300 },
        "/workspace",
        "/state",
        mockLogger,
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        "[workspace-sync] Starting periodic sync every 300s (pure file sync, zero LLM cost)",
      );
      expect(getSyncManagerStatus().running).toBe(true);
    });
  });

  describe("stopSyncManager", () => {
    it("stops a running manager", () => {
      startSyncManager(
        { provider: "dropbox", interval: 300 },
        "/workspace",
        "/state",
        mockLogger,
      );
      expect(getSyncManagerStatus().running).toBe(true);

      stopSyncManager();
      expect(getSyncManagerStatus().running).toBe(false);
    });

    it("is safe to call when not running", () => {
      expect(() => stopSyncManager()).not.toThrow();
    });
  });
});
