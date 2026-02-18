/**
 * OpenClaw Workspace Sync Plugin
 *
 * Bidirectional workspace cloud sync via rclone.
 * Supports Dropbox, Google Drive, S3, OneDrive, and 70+ providers.
 *
 * Features:
 * - CLI commands: openclaw workspace sync/status/setup/authorize/list
 * - Background periodic sync (pure rclone, zero LLM cost)
 * - Session start/end hooks for automatic sync
 * - Config-driven rclone setup (no manual rclone config needed)
 */

import * as clack from "@clack/prompts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  setLogger,
  isRcloneInstalled,
  ensureRcloneInstalled,
  isRcloneConfigured,
  ensureRcloneConfigFromConfig,
  resolveSyncConfig,
  runBisync,
  runSync,
  checkRemote,
  listRemote,
  authorizeRclone,
  writeRcloneConfig,
  generateRcloneConfig,
  type RcloneSyncResult,
} from "./rclone.js";
import type { WorkspaceSyncConfig, WorkspaceSyncProvider } from "./types.js";
import { startSyncManager, stopSyncManager, getSyncManagerStatus } from "./sync-manager.js";

function parsePluginConfig(raw: Record<string, unknown> | undefined): WorkspaceSyncConfig {
  if (!raw) return {};
  return raw as WorkspaceSyncConfig;
}

const workspaceSyncPlugin = {
  id: "workspace-sync",
  name: "Workspace Cloud Sync",
  description:
    "Bidirectional workspace sync with cloud storage (Dropbox, Google Drive, S3, OneDrive, 70+ providers) via rclone",

  register(api: OpenClawPluginApi) {
    const syncConfig = parsePluginConfig(api.pluginConfig);
    setLogger(api.logger);

    api.logger.info(
      `workspace-sync: registered (provider: ${syncConfig.provider ?? "not configured"})`,
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program, workspaceDir }) => {
        const workspace = program
          .command("workspace")
          .description("Workspace management and cloud sync");

        // openclaw workspace sync
        workspace
          .command("sync")
          .description("Sync workspace with cloud storage")
          .option("--agent <id>", "Agent ID (default: main)")
          .option("--resync", "Force resync (required for first sync)")
          .option("--dry-run", "Preview changes without syncing")
          .option("--direction <dir>", "One-way sync: pull or push")
          .option("-v, --verbose", "Verbose output")
          .action(
            async (opts: {
              agent?: string;
              resync?: boolean;
              dryRun?: boolean;
              verbose?: boolean;
              direction?: "pull" | "push";
            }) => {
              const cfgSync = syncConfig;
              const wsDir = workspaceDir ?? process.cwd();

              if (!cfgSync.provider || cfgSync.provider === "off") {
                console.error("Workspace sync not configured.");
                console.error("Run: openclaw workspace setup");
                process.exit(1);
              }

              const installed = await isRcloneInstalled();
              if (!installed) {
                console.error("rclone not installed.");
                console.error("Run: openclaw workspace setup");
                process.exit(1);
              }

              const resolved = resolveSyncConfig(cfgSync, wsDir);

              ensureRcloneConfigFromConfig(cfgSync, resolved.configPath, resolved.remoteName);

              if (!isRcloneConfigured(resolved.configPath, resolved.remoteName)) {
                console.error(`rclone not configured for remote "${resolved.remoteName}".`);
                console.error("Run: openclaw workspace authorize");
                process.exit(1);
              }

              console.log(`Syncing ${resolved.remoteName}:${resolved.remotePath}`);
              console.log(`Local: ${resolved.localPath}`);

              let result: RcloneSyncResult;

              if (opts.direction) {
                result = await runSync({
                  configPath: resolved.configPath,
                  remoteName: resolved.remoteName,
                  remotePath: resolved.remotePath,
                  localPath: resolved.localPath,
                  direction: opts.direction,
                  exclude: resolved.exclude,
                  dryRun: opts.dryRun,
                  verbose: opts.verbose,
                });
              } else {
                result = await runBisync({
                  configPath: resolved.configPath,
                  remoteName: resolved.remoteName,
                  remotePath: resolved.remotePath,
                  localPath: resolved.localPath,
                  conflictResolve: resolved.conflictResolve,
                  exclude: resolved.exclude,
                  copySymlinks: resolved.copySymlinks,
                  resync: opts.resync,
                  dryRun: opts.dryRun,
                  verbose: opts.verbose,
                });
              }

              if (result.ok) {
                console.log("Sync completed");
                if ((result as any).filesTransferred) {
                  console.log(`Files transferred: ${(result as any).filesTransferred}`);
                }
              } else {
                console.error(`Sync failed: ${(result as any).error}`);
                if ((result as any).error?.includes("--resync")) {
                  console.error("First sync requires --resync: openclaw workspace sync --resync");
                }
                process.exit(1);
              }
            },
          );

        // openclaw workspace status
        workspace
          .command("status")
          .description("Show workspace sync status")
          .option("--agent <id>", "Agent ID (default: main)")
          .option("-v, --verbose", "Verbose output")
          .action(async (opts: { agent?: string; verbose?: boolean }) => {
            const cfgSync = syncConfig;
            const wsDir = workspaceDir ?? process.cwd();

            console.log("Workspace Sync Status");
            console.log("");

            if (!cfgSync.provider || cfgSync.provider === "off") {
              console.log("Provider: not configured");
              console.log("Configure in openclaw.json plugins.entries.workspace-sync.config");
              return;
            }

            const resolved = resolveSyncConfig(cfgSync, wsDir);

            console.log(`Provider: ${cfgSync.provider}`);
            console.log(`Remote: ${resolved.remoteName}:${resolved.remotePath}`);
            console.log(`Local: ${resolved.localPath}`);
            console.log(`Config: ${resolved.configPath}`);
            console.log("");

            const installed = await isRcloneInstalled();
            if (!installed) {
              console.log("rclone: NOT installed");
              return;
            }
            console.log("rclone: installed");

            ensureRcloneConfigFromConfig(cfgSync, resolved.configPath, resolved.remoteName);

            const configured = isRcloneConfigured(resolved.configPath, resolved.remoteName);
            if (!configured) {
              console.log("rclone config: NOT configured");
              console.log("Run: openclaw workspace authorize");
              return;
            }
            console.log("rclone config: OK");

            const check = await checkRemote({
              configPath: resolved.configPath,
              remoteName: resolved.remoteName,
            });
            if (!check.ok) {
              console.log(`Connection: FAILED (${(check as any).error})`);
              return;
            }
            console.log("Connection: OK");

            const list = await listRemote({
              configPath: resolved.configPath,
              remoteName: resolved.remoteName,
              remotePath: resolved.remotePath,
            });
            if (list.ok) {
              console.log("");
              console.log(`Remote files: ${list.files.length}`);
              if (opts.verbose && list.files.length > 0) {
                for (const file of list.files.slice(0, 10)) {
                  console.log(`  ${file}`);
                }
                if (list.files.length > 10) {
                  console.log(`  ... and ${list.files.length - 10} more`);
                }
              }
            }

            // Background sync manager status
            const mgrStatus = getSyncManagerStatus();
            console.log("");
            console.log("Background sync:");
            console.log(`  Running: ${mgrStatus.running ? "yes" : "no"}`);
            console.log(`  On session start: ${resolved.onSessionStart ? "yes" : "no"}`);
            console.log(`  On session end: ${resolved.onSessionEnd ? "yes" : "no"}`);
            if (resolved.interval > 0) {
              console.log(
                `  Interval: ${resolved.interval}s (pure rclone, zero LLM cost)`,
              );
            } else {
              console.log("  Interval: disabled");
            }
            if (mgrStatus.lastSyncAt) {
              console.log(`  Last sync: ${mgrStatus.lastSyncAt.toISOString()}`);
              console.log(`  Last sync OK: ${mgrStatus.lastSyncOk}`);
              console.log(`  Total syncs: ${mgrStatus.syncCount}`);
              console.log(`  Errors: ${mgrStatus.errorCount}`);
            }
          });

        // openclaw workspace setup — interactive wizard
        workspace
          .command("setup")
          .description("Interactive setup wizard for cloud sync")
          .action(async () => {
            clack.intro("Workspace Cloud Sync Setup");

            const rcloneInstalled = await isRcloneInstalled();
            if (!rcloneInstalled) {
              const installed = await ensureRcloneInstalled(async (message, defaultValue) => {
                const result = await clack.confirm({ message, initialValue: defaultValue });
                return !clack.isCancel(result) && result;
              });
              if (!installed) {
                clack.note(
                  "Install rclone manually:\n\n" +
                    "  macOS:   brew install rclone\n" +
                    "  Linux:   curl -s https://rclone.org/install.sh | sudo bash\n" +
                    "  Docker:  Add to Dockerfile: RUN curl -s https://rclone.org/install.sh | bash",
                  "Installation required",
                );
                clack.outro("Install rclone and run this command again.");
                process.exit(1);
                return;
              }
            }
            clack.log.success("rclone is installed");

            const provider = (await clack.select({
              message: "Select cloud provider",
              options: [
                { value: "dropbox", label: "Dropbox", hint: "Recommended - easy setup" },
                { value: "gdrive", label: "Google Drive", hint: "Requires service account" },
                { value: "onedrive", label: "OneDrive", hint: "Microsoft 365" },
                { value: "s3", label: "S3 / R2 / Minio", hint: "Access key authentication" },
              ],
            })) as WorkspaceSyncProvider;

            if (clack.isCancel(provider)) {
              clack.cancel("Setup cancelled.");
              return;
            }

            const remotePath = (await clack.text({
              message: "Remote folder name",
              placeholder: "openclaw-share",
              initialValue: "openclaw-share",
              validate: (value = "") => {
                if (!value.trim()) return "Folder name is required";
                if (value.includes("/")) return "Use a simple folder name, not a path";
                return undefined;
              },
            })) as string;

            if (clack.isCancel(remotePath)) {
              clack.cancel("Setup cancelled.");
              return;
            }

            let appKey: string | undefined;
            let appSecret: string | undefined;

            if (provider === "dropbox") {
              const accessType = (await clack.select({
                message: "Dropbox access type",
                options: [
                  { value: "full", label: "Full Dropbox", hint: "Simpler setup" },
                  { value: "app", label: "App Folder only", hint: "More secure" },
                ],
              })) as "full" | "app";

              if (clack.isCancel(accessType)) {
                clack.cancel("Setup cancelled.");
                return;
              }

              if (accessType === "app") {
                clack.note(
                  "1. Go to https://www.dropbox.com/developers/apps\n" +
                    "2. Create app: Scoped access > App folder\n" +
                    "3. Enable: files.metadata.read/write, files.content.read/write\n" +
                    "4. Copy App key and App secret",
                  "Create Dropbox App",
                );

                appKey = (await clack.text({
                  message: "Dropbox App key",
                  placeholder: "your-app-key",
                })) as string;
                if (clack.isCancel(appKey)) { clack.cancel("Setup cancelled."); return; }

                appSecret = (await clack.text({
                  message: "Dropbox App secret",
                  placeholder: "your-app-secret",
                })) as string;
                if (clack.isCancel(appSecret)) { clack.cancel("Setup cancelled."); return; }
              }
            }

            const intervalChoice = (await clack.select({
              message: "Background sync interval",
              options: [
                { value: "0", label: "Manual only", hint: "Run 'openclaw workspace sync' when needed" },
                { value: "300", label: "Every 5 minutes", hint: "Recommended" },
                { value: "600", label: "Every 10 minutes" },
                { value: "1800", label: "Every 30 minutes" },
                { value: "3600", label: "Every hour" },
              ],
            })) as string;

            if (clack.isCancel(intervalChoice)) { clack.cancel("Setup cancelled."); return; }

            const interval = parseInt(intervalChoice, 10);

            const onSessionStart = (await clack.confirm({
              message: "Sync when session starts?",
              initialValue: true,
            })) as boolean;

            if (clack.isCancel(onSessionStart)) { clack.cancel("Setup cancelled."); return; }

            // OAuth authorization
            clack.log.info("Starting OAuth authorization...");
            clack.note(
              "A browser window will open.\nLog in and authorize access, then return here.",
              "Authorization",
            );

            const authResult = await authorizeRclone(provider, appKey, appSecret);

            if (!authResult.ok) {
              clack.log.error(`Authorization failed: ${(authResult as any).error}`);
              clack.outro("Fix the error and run 'openclaw workspace setup' again.");
              process.exit(1);
              return;
            }

            clack.log.success("Authorization successful");

            // Save rclone config
            const stateDir = process.env.OPENCLAW_STATE_DIR ?? `${process.env.HOME}/.openclaw`;
            const configPath = `${stateDir}/.config/rclone/rclone.conf`;
            const remoteName = "cloud";

            const configContent = generateRcloneConfig(provider, remoteName, authResult.token, {
              dropbox: appKey ? { appKey, appSecret } : undefined,
            });

            writeRcloneConfig(configPath, configContent);
            clack.log.success(`rclone config saved to ${configPath}`);

            // Print config snippet for user to add to openclaw.json
            clack.note(
              `Add to your openclaw.json:\n\n` +
                `"plugins": {\n` +
                `  "entries": {\n` +
                `    "workspace-sync": {\n` +
                `      "enabled": true,\n` +
                `      "config": {\n` +
                `        "provider": "${provider}",\n` +
                `        "remotePath": "${remotePath.trim()}",\n` +
                `        "interval": ${interval},\n` +
                `        "onSessionStart": ${onSessionStart}\n` +
                `      }\n` +
                `    }\n` +
                `  }\n` +
                `}`,
              "Plugin Configuration",
            );

            clack.outro("Workspace sync configured! Run: openclaw workspace sync --resync");
          });

        // openclaw workspace authorize
        workspace
          .command("authorize")
          .description("Authorize rclone with cloud provider")
          .option("--provider <name>", "Provider: dropbox, gdrive, onedrive, s3")
          .option("--app-key <key>", "Dropbox app key")
          .option("--app-secret <secret>", "Dropbox app secret")
          .action(
            async (opts: { provider?: string; appKey?: string; appSecret?: string }) => {
              const provider = (opts.provider as WorkspaceSyncProvider) ||
                syncConfig.provider ||
                "dropbox";

              if (provider === "off" || provider === "custom") {
                console.error("Please specify a provider: --provider dropbox");
                process.exit(1);
              }

              const installed = await isRcloneInstalled();
              if (!installed) {
                console.error("rclone not installed.");
                console.error("Install: curl -s https://rclone.org/install.sh | bash");
                process.exit(1);
              }

              console.log(`Authorizing with ${provider}...`);
              console.log("A browser window will open for authentication.");
              console.log("");

              const result = await authorizeRclone(
                provider,
                opts.appKey || syncConfig.dropbox?.appKey,
                opts.appSecret || syncConfig.dropbox?.appSecret,
              );

              if (!result.ok) {
                console.error(`Authorization failed: ${(result as any).error}`);
                process.exit(1);
              }

              console.log("Authorization successful");

              const stateDir = process.env.OPENCLAW_STATE_DIR ?? `${process.env.HOME}/.openclaw`;
              const remoteName = syncConfig.remoteName || "cloud";
              const configPath =
                syncConfig.configPath || `${stateDir}/.config/rclone/rclone.conf`;

              const configContent = generateRcloneConfig(provider, remoteName, (result as any).token, {
                dropbox: syncConfig.dropbox,
                s3: syncConfig.s3,
              });

              writeRcloneConfig(configPath, configContent);
              console.log(`Config saved to: ${configPath}`);
              console.log("");
              console.log("Next: openclaw workspace sync --resync");
            },
          );

        // openclaw workspace list
        workspace
          .command("list")
          .description("List files in remote storage")
          .option("--agent <id>", "Agent ID (default: main)")
          .action(async (opts: { agent?: string }) => {
            const cfgSync = syncConfig;
            const wsDir = workspaceDir ?? process.cwd();

            if (!cfgSync.provider || cfgSync.provider === "off") {
              console.error("Workspace sync not configured.");
              process.exit(1);
            }

            const resolved = resolveSyncConfig(cfgSync, wsDir);

            ensureRcloneConfigFromConfig(cfgSync, resolved.configPath, resolved.remoteName);

            if (!isRcloneConfigured(resolved.configPath, resolved.remoteName)) {
              console.error("rclone not configured.");
              console.error("Run: openclaw workspace authorize");
              process.exit(1);
            }

            const result = await listRemote({
              configPath: resolved.configPath,
              remoteName: resolved.remoteName,
              remotePath: resolved.remotePath,
            });

            if (!result.ok) {
              console.error(`Failed to list: ${(result as any).error}`);
              process.exit(1);
            }

            if ((result as any).files.length === 0) {
              console.log("No files in remote.");
              return;
            }

            console.log(`${resolved.remoteName}:${resolved.remotePath}/`);
            for (const file of (result as any).files) {
              console.log(`  ${file}`);
            }
            console.log(`\n${(result as any).files.length} files`);
          });
      },
      { commands: ["workspace"] },
    );

    // ========================================================================
    // Session Hooks
    // ========================================================================

    if (syncConfig.onSessionStart) {
      api.on("session_start", async (_event, ctx) => {
        if (!syncConfig.provider || syncConfig.provider === "off") return;

        api.logger.info("[workspace-sync] triggered on session start");

        try {
          const installed = await isRcloneInstalled();
          if (!installed) {
            api.logger.warn("[workspace-sync] rclone not installed, skipping sync");
            return;
          }

          const wsDir = ctx.agentId
            ? api.resolvePath(`agents/${ctx.agentId}/workspace`)
            : api.resolvePath("workspace");

          const resolved = resolveSyncConfig(syncConfig, wsDir);

          ensureRcloneConfigFromConfig(syncConfig, resolved.configPath, resolved.remoteName);

          if (!isRcloneConfigured(resolved.configPath, resolved.remoteName)) {
            api.logger.warn(
              `[workspace-sync] rclone not configured for "${resolved.remoteName}", skipping`,
            );
            return;
          }

          api.logger.info(
            `[workspace-sync] syncing ${resolved.remoteName}:${resolved.remotePath} <-> ${resolved.localPath}`,
          );

          const result = await runBisync({
            configPath: resolved.configPath,
            remoteName: resolved.remoteName,
            remotePath: resolved.remotePath,
            localPath: resolved.localPath,
            conflictResolve: resolved.conflictResolve,
            exclude: resolved.exclude,
            copySymlinks: resolved.copySymlinks,
          });

          if (result.ok) {
            api.logger.info("[workspace-sync] session start sync completed");
          } else if ((result as any).error?.includes("--resync")) {
            api.logger.warn(
              "[workspace-sync] first sync requires manual --resync. Run: openclaw workspace sync --resync",
            );
          } else {
            api.logger.error(`[workspace-sync] sync failed: ${(result as any).error}`);
          }
        } catch (err) {
          api.logger.error(
            `[workspace-sync] error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    }

    if (syncConfig.onSessionEnd) {
      api.on("session_end", async (_event, ctx) => {
        if (!syncConfig.provider || syncConfig.provider === "off") return;

        api.logger.info("[workspace-sync] triggered on session end");

        try {
          const installed = await isRcloneInstalled();
          if (!installed) return;

          const wsDir = ctx.agentId
            ? api.resolvePath(`agents/${ctx.agentId}/workspace`)
            : api.resolvePath("workspace");

          const resolved = resolveSyncConfig(syncConfig, wsDir);

          ensureRcloneConfigFromConfig(syncConfig, resolved.configPath, resolved.remoteName);

          if (!isRcloneConfigured(resolved.configPath, resolved.remoteName)) return;

          const result = await runBisync({
            configPath: resolved.configPath,
            remoteName: resolved.remoteName,
            remotePath: resolved.remotePath,
            localPath: resolved.localPath,
            conflictResolve: resolved.conflictResolve,
            exclude: resolved.exclude,
            copySymlinks: resolved.copySymlinks,
          });

          if (result.ok) {
            api.logger.info("[workspace-sync] session end sync completed");
          } else {
            api.logger.error(`[workspace-sync] sync failed: ${(result as any).error}`);
          }
        } catch (err) {
          api.logger.error(
            `[workspace-sync] error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    }

    // ========================================================================
    // Background Sync Service
    // ========================================================================

    api.registerService({
      id: "workspace-sync",
      start: (ctx) => {
        if (!syncConfig.provider || syncConfig.provider === "off") {
          api.logger.info("[workspace-sync] service: sync not configured, idle");
          return;
        }

        const wsDir = ctx.workspaceDir ?? api.resolvePath("workspace");

        startSyncManager(syncConfig, wsDir, ctx.stateDir, ctx.logger);
      },
      stop: () => {
        stopSyncManager();
        api.logger.info("[workspace-sync] service stopped");
      },
    });
  },
};

export default workspaceSyncPlugin;
