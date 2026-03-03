import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { Honcho } from "@honcho-ai/sdk";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { OWNER_ID } from "../state.js";
import { buildSessionKey, extractParentAgentKey, isSubagentSession } from "../helpers.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  if (candidate.name === "RateLimitError") return true;
  if (candidate.status === 429 || candidate.statusCode === 429) return true;
  return typeof candidate.message === "string" && /rate limit/i.test(candidate.message);
}

export function registerCli(api: OpenClawPluginApi, state: PluginState): void {
  api.registerCli(
    ({ program, workspaceDir }) => {
      const cmd = program.command("honcho").description("Honcho memory commands");

      cmd
        .command("setup")
        .description("Configure Honcho API key and upload memory files to Honcho")
        .action(async () => {
          const configDir = path.join(os.homedir(), ".openclaw");
          const configPath = path.join(configDir, "openclaw.json");

          console.log("\nHoncho Setup\n");
          console.log("Get your API key from: https://app.honcho.dev\n");
          console.log('Press Enter to use the default shown in [brackets].\n');

          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

          try {
            const apiKeyInput = await ask("Honcho API key (press Enter for self-hosted mode): ");
            const baseUrlInput = await ask("Base URL [https://api.honcho.dev]: ");
            const workspaceIdInput = await ask("Workspace ID [openclaw]: ");

            const resolvedBaseUrl = baseUrlInput.trim() || "https://api.honcho.dev";
            const resolvedWorkspaceId = workspaceIdInput.trim() || "openclaw";

            // Write config
            let config: Record<string, unknown> = {};
            if (fs.existsSync(configPath)) {
              try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { /* use empty */ }
            }
            if (!config.plugins) config.plugins = {};
            const pluginsSection = config.plugins as Record<string, unknown>;
            if (!pluginsSection.entries) pluginsSection.entries = {};
            const entriesSection = pluginsSection.entries as Record<string, unknown>;
            const existingEntry = (entriesSection["openclaw-honcho"] as Record<string, unknown>) ?? {};
            const pluginCfg: Record<string, unknown> = {
              ...(existingEntry.config as Record<string, unknown> ?? {}),
            };
            const trimmedApiKey = apiKeyInput.trim();
            if (trimmedApiKey) pluginCfg.apiKey = trimmedApiKey;
            else delete pluginCfg.apiKey;
            const trimmedBaseUrl = baseUrlInput.trim();
            if (trimmedBaseUrl) pluginCfg.baseUrl = trimmedBaseUrl;
            else delete pluginCfg.baseUrl;
            const trimmedWorkspaceId = workspaceIdInput.trim();
            if (trimmedWorkspaceId) pluginCfg.workspaceId = trimmedWorkspaceId;
            else delete pluginCfg.workspaceId;
            entriesSection["openclaw-honcho"] = { ...existingEntry, config: pluginCfg };

            if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            console.log("\n✓ Configuration saved to ~/.openclaw/openclaw.json");

            // Resolve default agent and its workspace from config
            let savedConfig: Record<string, unknown> = {};
            try { savedConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { /* use empty */ }

            const agentsList = Array.isArray((savedConfig?.agents as Record<string, unknown>)?.list)
              ? ((savedConfig.agents as Record<string, unknown>).list as Array<Record<string, unknown>>)
              : [];
            const defaultAgent = agentsList.find((a) => a?.default) ?? agentsList[0] ?? null;
            const defaultAgentId = ((defaultAgent?.id as string) ?? "main").toLowerCase().trim() || "main";
            const defaultAgentPeerId = `agent-${defaultAgentId}`;

            const OWNER_FILES = ["USER.md", "MEMORY.md"];
            const AGENT_FILES = ["SOUL.md", "IDENTITY.md", "AGENTS.md", "TOOLS.md", "BOOTSTRAP.md"];
            const OWNER_DIRS = ["memory", "canvas"];

            type FileEntry = { filePath: string; peer: "owner" | "agent" };
            const detected: FileEntry[] = [];

            function collectDir(dirPath: string, peerType: "owner" | "agent"): void {
              if (!fs.existsSync(dirPath)) return;
              const dirEntries = fs.readdirSync(dirPath, { withFileTypes: true });
              for (const e of dirEntries) {
                const full = path.join(dirPath, e.name);
                if (e.isDirectory()) collectDir(full, peerType);
                else detected.push({ filePath: full, peer: peerType });
              }
            }

            function scanWorkspace(wsDir: string): void {
              for (const file of OWNER_FILES) {
                const p = path.join(wsDir, file);
                if (fs.existsSync(p) && !detected.find((d) => d.filePath === p))
                  detected.push({ filePath: p, peer: "owner" });
              }
              for (const file of AGENT_FILES) {
                const p = path.join(wsDir, file);
                if (fs.existsSync(p) && !detected.find((d) => d.filePath === p))
                  detected.push({ filePath: p, peer: "agent" });
              }
              for (const dir of OWNER_DIRS) {
                collectDir(path.join(wsDir, dir), "owner");
              }
            }

            // Build ordered candidate workspace paths, deduplicated by real path.
            const ocHome = path.join(os.homedir(), ".openclaw");

            const candidateWsPaths: string[] = [
              workspaceDir as string,
              defaultAgent?.workspace as string,
              defaultAgent?.workspaceDir as string,
              ((savedConfig?.agents as Record<string, unknown>)?.defaults as Record<string, unknown>)?.workspace as string,
              path.join(ocHome, "agents", defaultAgentId, "workspace"),
              path.join(ocHome, "workspace"),
              path.join(os.homedir(), ".clawdbot", "workspace"),
            ].filter(Boolean);

            // Deduplicate by resolved real path so symlinks / duplicate entries don't double-scan
            const seen = new Set<string>();
            const uniqueCandidates = candidateWsPaths.filter((p) => {
              const real = fs.existsSync(p) ? fs.realpathSync(p) : p;
              if (seen.has(real)) return false;
              seen.add(real);
              return true;
            });

            for (const candidate of uniqueCandidates) {
              scanWorkspace(candidate);
              if (detected.length > 0) break;
            }

            // Still nothing — prompt user to enter additional paths manually
            if (detected.length === 0) {
              console.log("\nNo memory files found. Searched:");
              for (const c of uniqueCandidates) console.log(`  ${c}`);
              console.log('\nEnter file or directory paths to upload (one per line, empty line to finish):');
              console.log('Format: /path/to/file-or-dir [owner|agent]  (peer defaults to "owner" if omitted)\n');
              while (true) {
                const entry = await ask("> ");
                if (!entry.trim()) break;
                const parts = entry.trim().split(/\s+/);
                const lastToken = parts[parts.length - 1];
                const peerType = (lastToken === "agent" || lastToken === "owner") && parts.length > 1
                  ? (lastToken as "owner" | "agent")
                  : "owner";
                const inputPath = (lastToken === "agent" || lastToken === "owner") && parts.length > 1
                  ? entry.trim().slice(0, entry.trim().lastIndexOf(lastToken)).trimEnd()
                  : entry.trim();
                if (!fs.existsSync(inputPath)) {
                  console.log(`  ! Not found: ${inputPath}`);
                  continue;
                }
                if (fs.statSync(inputPath).isDirectory()) {
                  collectDir(inputPath, peerType);
                  console.log(`  + ${inputPath}/ (directory) → ${peerType === "owner" ? OWNER_ID : defaultAgentPeerId}`);
                } else {
                  detected.push({ filePath: inputPath, peer: peerType });
                  console.log(`  + ${inputPath} → ${peerType === "owner" ? OWNER_ID : defaultAgentPeerId}`);
                }
              }
            }

            if (detected.length === 0) {
              console.log("\nNo files to upload.");
              console.log("\n✓ Setup complete. Run `openclaw gateway --force` to activate.\n");
              return;
            }

            console.log(`\nFound ${detected.length} memory file(s):`);
            console.log(`Default agent: ${defaultAgentId} (peer: ${defaultAgentPeerId})`);
            for (const { filePath, peer } of detected) {
              const size = fs.statSync(filePath).size;
              const peerLabel = peer === "owner" ? OWNER_ID : defaultAgentPeerId;
              console.log(`  ${filePath} (${(size / 1024).toFixed(1)} KB) → ${peerLabel}`);
            }
            console.log(`\nData destination: ${resolvedBaseUrl}`);

            const uploadConfirm = await ask("\nUpload these files to Honcho? [y/N]: ");
            if (!["y", "yes"].includes(uploadConfirm.trim().toLowerCase())) {
              console.log("\nSkipping upload.");
              console.log("\n✓ Setup complete. Run `openclaw gateway --force` to activate.\n");
              return;
            }

            // Upload files to Honcho
            const setupHoncho = new Honcho({
              apiKey: apiKeyInput.trim() || undefined,
              baseURL: resolvedBaseUrl,
              workspaceId: resolvedWorkspaceId,
            });

            const existingMeta = await setupHoncho.getMetadata();
            await setupHoncho.setMetadata({ ...existingMeta });
            const ownerPeerSetup = await setupHoncho.peer(OWNER_ID, { metadata: {} });
            const agentPeerSetup = await setupHoncho.peer(defaultAgentPeerId, { metadata: { agentId: defaultAgentId } });
            const migrationSession = await setupHoncho.session("migration-setup", { metadata: {} });
            await migrationSession.addPeers([
              [ownerPeerSetup, { observeMe: true, observeOthers: false }],
              [agentPeerSetup, { observeMe: true, observeOthers: true }],
            ]);

            const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB safety cap
            const UPLOAD_MIN_INTERVAL_MS = 250; // Keep below Honcho's 5 requests/second limit
            const UPLOAD_MAX_ATTEMPTS = 5;
            const UPLOAD_RETRY_BASE_MS = 400;
            let lastUploadAt = 0;

            let uploadCount = 0;
            for (const { filePath, peer } of detected) {
              const stat = await fs.promises.stat(filePath).catch(() => null);
              if (!stat?.isFile()) continue;
              if (stat.size > MAX_UPLOAD_BYTES) {
                console.log(`  ! Skipping (too large): ${filePath}`);
                continue;
              }
              const filename = path.basename(filePath);
              const ext = path.extname(filename).toLowerCase();
              const content_type = ext === ".json" ? "application/json" : ext === ".md" ? "text/markdown" : null;
              if (!content_type) {
                console.log(`  ! Skipping unsupported file type: ${filePath}`);
                continue;
              }
              const content = await fs.promises.readFile(filePath);
              const targetPeer = peer === "owner" ? ownerPeerSetup : agentPeerSetup;
              let attempt = 0;
              while (true) {
                const elapsedSinceLastUpload = Date.now() - lastUploadAt;
                const waitMs = Math.max(0, UPLOAD_MIN_INTERVAL_MS - elapsedSinceLastUpload);
                if (waitMs > 0) await sleep(waitMs);

                try {
                  await migrationSession.uploadFile({ filename, content, content_type }, targetPeer, {});
                  lastUploadAt = Date.now();
                  break;
                } catch (error) {
                  if (!isRateLimitError(error) || attempt >= UPLOAD_MAX_ATTEMPTS - 1) {
                    throw error;
                  }
                  const retryMs = UPLOAD_RETRY_BASE_MS * (2 ** attempt);
                  console.log(`  ! Rate limited, retrying in ${retryMs}ms: ${filePath}`);
                  attempt++;
                  await sleep(retryMs);
                }
              }
              console.log(`  ✓ Uploaded: ${filePath}`);
              uploadCount++;
            }
            console.log(`\n✓ Uploaded ${uploadCount} file(s) to Honcho`);

            console.log("\n✓ Setup complete. Run `openclaw gateway --force` to activate.\n");
          } finally {
            rl.close();
          }
        });

      cmd
        .command("status")
        .description("Show Honcho connection status")
        .action(async () => {
          try {
            await state.ensureInitialized();
            const defaultPeer = await state.getAgentPeer(state.resolveDefaultAgentId());

            console.log("Connected to Honcho");
            console.log(`  Workspace: ${state.cfg.workspaceId}`);
            console.log(`  Default agent: ${state.resolveDefaultAgentId()} → peer "${defaultPeer.id}"`);
            console.log(`  Agent peers mapped: ${Object.keys(state.agentPeerMap).join(", ") || "(none)"}`);
          } catch (error) {
            console.error(`Failed to connect: ${error}`);
          }
        });

      cmd
        .command("doctor")
        .description("Check agent-scoped peer/session health")
        .option("--session-key <key>", "Optional OpenClaw session key to validate")
        .option("--provider <provider>", "Message provider used for session key reconstruction", "unknown")
        .action(async (options: { sessionKey?: string; provider: string }) => {
          try {
            await state.ensureInitialized();
            const configuredAgentIds = Array.isArray(api.config?.agents?.list)
              ? api.config.agents.list
                  .map((a: { id?: string }) => (a?.id ?? "").toLowerCase().trim())
                  .filter(Boolean)
              : [];

            const candidateIds = new Set<string>([
              state.resolveDefaultAgentId(),
              ...configuredAgentIds,
              ...Object.keys(state.agentPeerMap),
            ]);

            if (candidateIds.size === 0) {
              console.log("No agent IDs found in config or metadata.");
              return;
            }

            console.log("Honcho agent/session health");
            console.log(`  Workspace: ${state.cfg.workspaceId}`);
            console.log(`  Base URL: ${state.cfg.baseUrl}`);
            console.log(`  Owner peer: ${OWNER_ID}`);
            console.log("  Model: one session = one owning agent (plus optional subagent child sessions)");
            console.log("  Expectation: no cross-agent observations between peer agents");
            console.log(`  Agent IDs checked: ${Array.from(candidateIds).join(", ")}`);

            let issues = 0;
            for (const id of candidateIds) {
              const peer = await state.getAgentPeer(id);
              const peerMeta = await peer.getMetadata();
              const mappedPeerId = state.agentPeerMap[id];
              const metaAgentId = typeof peerMeta?.agentId === "string" ? peerMeta.agentId : undefined;
              const mappingOk = mappedPeerId === peer.id;
              const metadataOk = metaAgentId === id;

              if (!mappingOk || !metadataOk) issues++;

              console.log(
                `  - ${id}: peer="${peer.id}" map=${mappingOk ? "ok" : "mismatch"} metadata.agentId=${metaAgentId ?? "(missing)"}`
              );
            }

            if (options.sessionKey) {
              console.log("\nSession metadata validation");
              console.log(`  OpenClaw session key: ${options.sessionKey}`);

              const honchoSessionKey = buildSessionKey({
                sessionKey: options.sessionKey,
                messageProvider: options.provider,
              });
              console.log(`  Honcho session key: ${honchoSessionKey}`);

              const ownerMatch = options.sessionKey.match(/^agent:([^:]+):/);
              const ownerAgentFromKey = ownerMatch?.[1]?.toLowerCase().trim();
              const keyIsSubagent = isSubagentSession({ sessionKey: options.sessionKey });
              const parentAgentKey = extractParentAgentKey(options.sessionKey);

              try {
                const session = await state.honcho.session(honchoSessionKey);
                const sessionMeta = await session.getMetadata();
                const sessionAgentId =
                  typeof sessionMeta.agentId === "string"
                    ? sessionMeta.agentId.toLowerCase().trim()
                    : undefined;
                const metaIsSubagent = Boolean(sessionMeta.isSubagent);
                const metaParentKey =
                  typeof sessionMeta.parentAgentKey === "string" ? sessionMeta.parentAgentKey : undefined;

                if (!sessionAgentId) {
                  issues++;
                  console.log("  - session metadata.agentId: missing");
                } else if (ownerAgentFromKey && sessionAgentId !== ownerAgentFromKey) {
                  issues++;
                  console.log(
                    `  - session metadata.agentId: mismatch (key=${ownerAgentFromKey}, metadata=${sessionAgentId})`
                  );
                } else {
                  console.log(`  - session metadata.agentId: ok (${sessionAgentId})`);
                }

                if (keyIsSubagent) {
                  if (!metaIsSubagent) {
                    issues++;
                    console.log("  - session metadata.isSubagent: expected true, got false");
                  } else {
                    console.log("  - session metadata.isSubagent: ok");
                  }

                  if (!metaParentKey) {
                    issues++;
                    console.log("  - session metadata.parentAgentKey: missing");
                  } else if (parentAgentKey && metaParentKey !== parentAgentKey) {
                    issues++;
                    console.log(
                      `  - session metadata.parentAgentKey: mismatch (key=${parentAgentKey}, metadata=${metaParentKey})`
                    );
                  } else {
                    console.log(`  - session metadata.parentAgentKey: ok (${metaParentKey})`);
                  }
                } else if (metaIsSubagent) {
                  issues++;
                  console.log("  - session metadata.isSubagent: unexpected true for non-subagent key");
                } else {
                  console.log("  - session metadata.isSubagent: ok (false)");
                }
              } catch (error) {
                issues++;
                console.log(`  - session lookup failed: ${error}`);
              }
            }

            if (issues > 0) {
              console.log(`\nDetected ${issues} issue(s).`);
              process.exitCode = 1;
            } else {
              console.log("\nNo agent/session health issues detected.");
            }
          } catch (error) {
            console.error(`Doctor check failed: ${error}`);
            process.exitCode = 1;
          }
        });

      cmd
        .command("ask <question>")
        .description("Ask Honcho about the user")
        .option("-a, --agent <id>", "Agent ID to query as (default: primary agent)")
        .action(async (question: string, options: { agent?: string }) => {
          try {
            await state.ensureInitialized();
            const agentPeer = await state.getAgentPeer(options.agent ?? state.resolveDefaultAgentId());
            const answer = await agentPeer.chat(question, { target: state.ownerPeer! });
            console.log(answer ?? "No information available.");
          } catch (error) {
            console.error(`Failed to query: ${error}`);
          }
        });

      cmd
        .command("search <query>")
        .description("Semantic search over Honcho memory")
        .option("-k, --top-k <number>", "Number of results to return", "10")
        .option("-d, --max-distance <number>", "Maximum semantic distance (0-1)", "0.5")
        .action(async (query: string, options: { topK: string; maxDistance: string }) => {
          try {
            await state.ensureInitialized();
            const representation = await state.ownerPeer!.representation({
              searchQuery: query,
              searchTopK: parseInt(options.topK, 10),
              searchMaxDistance: parseFloat(options.maxDistance),
            });

            if (!representation) {
              console.log(`No relevant memories found for: "${query}"`);
              return;
            }

            console.log(representation);
          } catch (error) {
            console.error(`Search failed: ${error}`);
          }
        });
    },
    { commands: ["honcho"] }
  );
}
