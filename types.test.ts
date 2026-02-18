import { describe, expect, it } from "vitest";
import type { WorkspaceSyncConfig, WorkspaceSyncProvider } from "./types.js";

describe("workspace-sync types", () => {
  it("WorkspaceSyncProvider accepts valid values", () => {
    const providers: WorkspaceSyncProvider[] = [
      "off",
      "dropbox",
      "gdrive",
      "onedrive",
      "s3",
      "custom",
    ];
    expect(providers).toHaveLength(6);
  });

  it("WorkspaceSyncConfig accepts minimal config", () => {
    const config: WorkspaceSyncConfig = {};
    expect(config.provider).toBeUndefined();
  });

  it("WorkspaceSyncConfig accepts full dropbox config", () => {
    const config: WorkspaceSyncConfig = {
      provider: "dropbox",
      remotePath: "openclaw-share",
      localPath: "shared",
      interval: 300,
      onSessionStart: true,
      onSessionEnd: true,
      remoteName: "cloud",
      conflictResolve: "newer",
      exclude: [".git/**"],
      copySymlinks: false,
      dropbox: {
        appFolder: true,
        appKey: "key",
        appSecret: "secret",
        token: '{"access_token":"abc"}',
      },
    };
    expect(config.provider).toBe("dropbox");
    expect(config.dropbox?.appFolder).toBe(true);
  });

  it("WorkspaceSyncConfig accepts full s3 config", () => {
    const config: WorkspaceSyncConfig = {
      provider: "s3",
      s3: {
        endpoint: "https://r2.example.com",
        bucket: "my-bucket",
        region: "auto",
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
      },
    };
    expect(config.provider).toBe("s3");
    expect(config.s3?.endpoint).toBe("https://r2.example.com");
  });

  it("WorkspaceSyncConfig accepts gdrive config", () => {
    const config: WorkspaceSyncConfig = {
      provider: "gdrive",
      gdrive: {
        token: '{"access_token":"gd123"}',
        teamDrive: "0ABcDeFg",
        rootFolderId: "folder123",
      },
    };
    expect(config.provider).toBe("gdrive");
    expect(config.gdrive?.teamDrive).toBe("0ABcDeFg");
  });

  it("WorkspaceSyncConfig accepts onedrive config", () => {
    const config: WorkspaceSyncConfig = {
      provider: "onedrive",
      onedrive: {
        token: '{"access_token":"od123"}',
        driveId: "drive-abc",
        driveType: "business",
      },
    };
    expect(config.provider).toBe("onedrive");
    expect(config.onedrive?.driveType).toBe("business");
  });

  it("WorkspaceSyncConfig accepts custom provider config", () => {
    const config: WorkspaceSyncConfig = {
      provider: "custom",
      custom: {
        rcloneType: "sftp",
        rcloneOptions: { host: "example.com", user: "deploy" },
      },
    };
    expect(config.provider).toBe("custom");
    expect(config.custom?.rcloneType).toBe("sftp");
    expect(config.custom?.rcloneOptions?.host).toBe("example.com");
  });
});
