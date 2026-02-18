import { describe, expect, it, vi } from "vitest";
import workspaceSyncPlugin from "./index.js";

describe("workspace-sync plugin", () => {
  it("exports correct plugin metadata", () => {
    expect(workspaceSyncPlugin.id).toBe("openclaw-workspace-sync");
    expect(workspaceSyncPlugin.name).toBe("Workspace Cloud Sync");
    expect(workspaceSyncPlugin.description).toContain("rclone");
  });

  it("has a register function", () => {
    expect(typeof workspaceSyncPlugin.register).toBe("function");
  });

  it("registers CLI, service, and hooks", () => {
    const registerCli = vi.fn();
    const registerService = vi.fn();
    const on = vi.fn();

    const api = {
      id: "openclaw-workspace-sync",
      name: "Workspace Cloud Sync",
      source: "test",
      config: {},
      pluginConfig: {
        provider: "dropbox",
        onSessionStart: true,
        onSessionEnd: true,
      },
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
      registerCli,
      registerService,
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      resolvePath: vi.fn((p: string) => `/resolved/${p}`),
      on,
    };

    workspaceSyncPlugin.register(api as any);

    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(registerCli).toHaveBeenCalledWith(expect.any(Function), { commands: ["workspace"] });

    expect(registerService).toHaveBeenCalledTimes(1);
    expect(registerService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "openclaw-workspace-sync" }),
    );

    // session_start + session_end hooks
    expect(on).toHaveBeenCalledTimes(2);
    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(on).toHaveBeenCalledWith("session_end", expect.any(Function));
  });

  it("skips session hooks when not configured", () => {
    const on = vi.fn();

    const api = {
      id: "openclaw-workspace-sync",
      name: "Workspace Cloud Sync",
      source: "test",
      config: {},
      pluginConfig: { provider: "dropbox" },
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
      on,
    };

    workspaceSyncPlugin.register(api as any);

    // No session hooks registered when onSessionStart/onSessionEnd are falsy
    expect(on).not.toHaveBeenCalled();
  });

  it("registers only session_start hook when onSessionEnd is false", () => {
    const on = vi.fn();

    const api = {
      id: "openclaw-workspace-sync",
      name: "Workspace Cloud Sync",
      source: "test",
      config: {},
      pluginConfig: { provider: "dropbox", onSessionStart: true, onSessionEnd: false },
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
      on,
    };

    workspaceSyncPlugin.register(api as any);

    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
  });
});
