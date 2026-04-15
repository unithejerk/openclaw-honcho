/**
 * Shared mutable state for the Honcho memory plugin.
 * Follows the dependency-injection pattern: createPluginState() returns a
 * PluginState object that gets passed to every module.
 */

import { Honcho, type Peer } from "@honcho-ai/sdk";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { honchoConfigSchema, type HonchoConfig } from "./config.js";

export const OWNER_ID = "owner";
export const LEGACY_PEER_ID = "openclaw";

export function isLocalHonchoBaseUrl(baseUrl?: string): boolean {
  const base = String(baseUrl ?? "").trim();
  if (!base) return false;

  try {
    const { hostname, protocol } = new URL(base);
    if (protocol !== "http:" && protocol !== "https:") return false;
    const normalizedHost = hostname.replace(/^\[(.*)\]$/, "$1");
    return normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "::1";
  } catch {
    return false;
  }
}

export type PluginState = {
  honcho: Honcho;
  cfg: HonchoConfig;
  /** Cache of resolved participant peers, keyed by channel peer ID (or OWNER_ID for default).
   * "Participant" intentionally generalizes over humans AND non-agent bots/agents in group
   * chats — anyone in the conversation who isn't the local OpenClaw agent peer. */
  participantPeers: Map<string, Peer>;
  /** Persistent mapping of channel peer ID → honcho peer ID, stored in workspace metadata. */
  participantPeerMap: Record<string, string>;
  agentPeers: Map<string, Peer>;
  agentPeerMap: Record<string, string>;
  /** Message count recorded at before_prompt_build time, keyed by Honcho session key.
   * Used by the capture hook to determine where the current turn starts in the
   * accumulated message array, so first-init skips pre-installation history. */
  turnStartIndex: Map<string, number>;
  initialized: boolean;
  api: OpenClawPluginApi;
  ensureInitialized: () => Promise<void>;
  getAgentPeer: (agentId?: string) => Promise<Peer>;
  /** Resolve a participant peer by channel peer ID. Returns default "owner" peer if no ID given. */
  getParticipantPeer: (channelPeerId?: string) => Promise<Peer>;
  /** Resolve the participant peer for a session by reading participantSenderId from session metadata.
   * Falls back to default "owner" peer if no metadata found. */
  resolveSessionParticipantPeer: (sessionKey: string) => Promise<Peer>;
  /** Returns true if the given honcho peer ID belongs to a known participant peer. */
  isParticipantPeerId: (peerId: string) => boolean;
  resolveDefaultAgentId: () => string;
};

export function createPluginState(api: OpenClawPluginApi): PluginState {
  const cfg = honchoConfigSchema.parse(api.pluginConfig);

  const selfHosted = isLocalHonchoBaseUrl(cfg.baseUrl);

  if (!cfg.apiKey && !selfHosted) {
    api.logger.warn(
      "openclaw-honcho: No API key configured. Set HONCHO_API_KEY or configure apiKey in plugin config."
    );
  }

  const honcho = new Honcho({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    workspaceId: cfg.workspaceId,
    timeout: cfg.timeoutMs,
  });

  // Promise-based init lock to prevent concurrent ensureInitialized() races.
  // Without this, two concurrent hooks entering init simultaneously can corrupt
  // workspace metadata. Errors propagate to all waiters.
  let initPromise: Promise<void> | null = null;

  // Serialize workspace metadata writes to prevent concurrent read-modify-write
  // races between getParticipantPeer() and getAgentPeer().
  let metadataWriteLock: Promise<void> = Promise.resolve();

  const state: PluginState = {
    honcho,
    cfg,
    participantPeers: new Map<string, Peer>(),
    participantPeerMap: {},
    agentPeers: new Map<string, Peer>(),
    agentPeerMap: {},
    turnStartIndex: new Map<string, number>(),
    initialized: false,
    api,
    ensureInitialized,
    getAgentPeer,
    getParticipantPeer,
    resolveSessionParticipantPeer,
    isParticipantPeerId,
    resolveDefaultAgentId,
  };

  function resolveDefaultAgentId(): string {
    const agents = api.config?.agents?.list;
    if (!Array.isArray(agents) || agents.length === 0) return "main";
    const defaultAgent = agents.find((a: { default?: boolean }) => a?.default) ?? agents[0];
    return (defaultAgent?.id ?? "main").toLowerCase().trim() || "main";
  }

  async function ensureInitialized(): Promise<void> {
    if (state.initialized) return;
    if (initPromise) return initPromise;
    initPromise = doInit();
    try {
      await initPromise;
    } catch (err) {
      // Reset so next caller retries instead of getting a stale rejection.
      initPromise = null;
      throw err;
    }
  }

  async function doInit(): Promise<void> {

    const wsMeta = await honcho.getMetadata();
    state.agentPeerMap = (wsMeta.agentPeerMap as Record<string, string>) ?? {};
    state.participantPeerMap = (wsMeta.participantPeerMap as Record<string, string>) ?? {};

    // Config mappings take precedence over workspace metadata
    for (const [channelId, honchoId] of Object.entries(cfg.peerMappings)) {
      state.participantPeerMap[channelId] = honchoId;
    }
    for (const [agentId, honchoId] of Object.entries(cfg.agentPeerMappings)) {
      state.agentPeerMap[agentId] = honchoId;
    }

    const defaultId = resolveDefaultAgentId();
    if (Object.keys(state.agentPeerMap).length === 0) {
      state.agentPeerMap[defaultId] = `agent-${defaultId}`;
      await honcho.setMetadata({ ...wsMeta, agentPeerMap: state.agentPeerMap, participantPeerMap: state.participantPeerMap });
    } else if (Object.values(state.agentPeerMap).includes(LEGACY_PEER_ID) && !state.agentPeerMap[defaultId]) {
      state.agentPeerMap[defaultId] = LEGACY_PEER_ID;
      await honcho.setMetadata({ ...wsMeta, agentPeerMap: state.agentPeerMap, participantPeerMap: state.participantPeerMap });
    }

    // Create default "owner" peer
    const defaultPeer = await honcho.peer(OWNER_ID, { metadata: {} });
    state.participantPeers.set(OWNER_ID, defaultPeer);

    state.initialized = true;
  }

  async function getParticipantPeer(channelPeerId?: string): Promise<Peer> {
    if (!channelPeerId) {
      // Return default owner peer
      let peer = state.participantPeers.get(OWNER_ID);
      if (!peer) {
        peer = await honcho.peer(OWNER_ID, { metadata: {} });
        state.participantPeers.set(OWNER_ID, peer);
      }
      return peer;
    }

    // Check cache
    let peer = state.participantPeers.get(channelPeerId);
    if (peer) return peer;

    // Resolve honcho peer ID from mapping or use channel peer ID directly
    let honchoId = state.participantPeerMap[channelPeerId];
    if (!honchoId) {
      honchoId = channelPeerId;
      // Persist auto-created mapping (serialized to prevent concurrent write races)
      state.participantPeerMap[channelPeerId] = honchoId;
      // Chain off `prev.catch(...)` so a failed prior write doesn't poison the
      // next one, but re-expose this write's own errors via the awaited lock.
      const prev = metadataWriteLock;
      const current = prev.catch(() => undefined).then(async () => {
        const wsMeta = await honcho.getMetadata();
        await honcho.setMetadata({ ...wsMeta, participantPeerMap: state.participantPeerMap });
      });
      metadataWriteLock = current;
      try {
        await current;
      } catch (err) {
        api.logger.error(
          `[honcho] Failed to persist participantPeerMap for "${channelPeerId}": ${err instanceof Error ? err.message : String(err)}`
        );
        throw err;
      }
      api.logger.info(`[honcho] Auto-created participant peer mapping: "${channelPeerId}" → "${honchoId}"`);
    }

    peer = await honcho.peer(honchoId, { metadata: { channelPeerId } });
    state.participantPeers.set(channelPeerId, peer);
    return peer;
  }

  async function resolveSessionParticipantPeer(sessionKey: string): Promise<Peer> {
    try {
      const session = await honcho.session(sessionKey);
      const meta = await session.getMetadata();
      if (meta && typeof meta === "object") {
        const senderId = (meta as Record<string, unknown>).participantSenderId;
        if (typeof senderId === "string" && senderId.length > 0) {
          return await getParticipantPeer(senderId);
        }
      }
    } catch {
      // Fall through to default
    }
    return await getParticipantPeer();
  }

  function isParticipantPeerId(peerId: string): boolean {
    if (peerId === OWNER_ID) return true;
    // Check if this peer ID is a known participant peer (either as a channel ID key or honcho ID value)
    for (const [, peer] of state.participantPeers) {
      if (peer.id === peerId) return true;
    }
    // Also check the mapping values
    return Object.values(state.participantPeerMap).includes(peerId);
  }

  async function getAgentPeer(agentId?: string): Promise<Peer> {
    const id = (agentId || resolveDefaultAgentId()).toLowerCase().trim() || "main";

    let peer = state.agentPeers.get(id);
    if (peer) return peer;

    let peerId = state.agentPeerMap[id];

    if (!peerId) {
      const allPeers = await honcho.peers();
      for await (const p of allPeers) {
        if (p.id === OWNER_ID) continue;
        const meta = await p.getMetadata();
        if (meta?.agentId === id) {
          peerId = p.id;
          api.logger.info(`[honcho] Recovered peer "${peerId}" for renamed agent "${id}"`);
          break;
        }
      }
    }

    if (!peerId) {
      peerId = `agent-${id}`;
    }

    if (state.agentPeerMap[id] !== peerId) {
      state.agentPeerMap[id] = peerId;
      // Chain off `prev.catch(...)` so a failed prior write doesn't poison the
      // next one, but re-expose this write's own errors via the awaited lock.
      const prev = metadataWriteLock;
      const current = prev.catch(() => undefined).then(async () => {
        const wsMeta = await honcho.getMetadata();
        await honcho.setMetadata({ ...wsMeta, agentPeerMap: state.agentPeerMap });
      });
      metadataWriteLock = current;
      try {
        await current;
      } catch (err) {
        api.logger.error(
          `[honcho] Failed to persist agentPeerMap for "${id}": ${err instanceof Error ? err.message : String(err)}`
        );
        throw err;
      }
    }

    peer = await honcho.peer(peerId);
    state.agentPeers.set(id, peer);

    const existingMeta = await peer.getMetadata();
    if (existingMeta.agentId !== id) {
      await peer.setMetadata({ ...existingMeta, agentId: id });
    }

    return peer;
  }

  return state;
}
