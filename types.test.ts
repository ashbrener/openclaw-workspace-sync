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
});
