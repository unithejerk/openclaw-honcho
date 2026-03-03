// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { OWNER_ID } from "../state.js";
import {
  buildSessionKey,
  isSubagentSession,
  extractParentAgentKey,
  extractMessages,
} from "../helpers.js";

function summarizeRawMessages(messages: unknown[]): string {
  return messages
    .map((msg, index) => {
      if (!msg || typeof msg !== "object") return `${index}:unknown`;
      const m = msg as Record<string, unknown>;
      const role = typeof m.role === "string" ? m.role : "unknown";
      const content = m.content;

      if (typeof content === "string") return `${index}:${role}:string`;
      if (Array.isArray(content)) {
        const types = content
          .map((block) => {
            if (!block || typeof block !== "object") return "unknown";
            const type = (block as Record<string, unknown>).type;
            return typeof type === "string" ? type : "unknown";
          })
          .join("|");
        return `${index}:${role}:array[${types || "empty"}]`;
      }
      if (content === undefined) return `${index}:${role}:undefined`;
      return `${index}:${role}:${typeof content}`;
    })
    .join(", ");
}

export function getInitialLastSavedIndex(messages: unknown[]): number {
  const firstNonSystemIndex = messages.findIndex((message) => {
    if (!message || typeof message !== "object") return false;
    return (message as Record<string, unknown>).role !== "system";
  });
  return firstNonSystemIndex >= 0 ? firstNonSystemIndex : 0;
}

export function registerCaptureHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("agent_end", async (event, ctx) => {
    if (!event.success || !event.messages?.length) return;

    const sessionKey = buildSessionKey(ctx);
    const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
    const isSubagent = isSubagentSession(ctx);

    try {
      await state.ensureInitialized();
      const agentPeer = await state.getAgentPeer(agentId);

      const sessionMeta: Record<string, unknown> = {
        agentId,
        ...(isSubagent ? {
          isSubagent: true,
          parentAgentKey: extractParentAgentKey(ctx.sessionKey),
        } : {}),
      };

      const session = await state.honcho.session(sessionKey, { metadata: sessionMeta });
      let meta = await session.getMetadata();
      api.logger.debug?.(
        `[honcho] capture start session=${sessionKey} agent=${agentId} totalRaw=${event.messages.length} rawSummary=${summarizeRawMessages(event.messages)}`
      );

      if (meta.lastSavedIndex === undefined) {
        // On first save, start from the first non-system message so tool-call
        // transcripts don't skip the user's initial prompt.
        const startIndex = getInitialLastSavedIndex(event.messages);
        api.logger.debug?.(
          `[honcho] first save initialization startIndex=${startIndex} totalRaw=${event.messages.length}`
        );
        await session.setMetadata({ ...sessionMeta, lastSavedIndex: startIndex });
        meta = { ...sessionMeta, lastSavedIndex: startIndex };
      }

      const lastSavedIndex = (meta.lastSavedIndex as number) ?? 0;
      api.logger.debug?.(
        `[honcho] capture window lastSavedIndex=${lastSavedIndex} totalRaw=${event.messages.length}`
      );

      if (isSubagent) {
        const parentAgentKey = extractParentAgentKey(ctx.sessionKey);
        if (!parentAgentKey) {
          api.logger.warn?.(
            `[honcho] Subagent session missing parent agent key: ${ctx.sessionKey ?? "(missing)"}`
          );
        }
        api.logger.warn?.(
          `[honcho] Subagent session parent id: ${parentAgentKey}`
        );
      }

      await session.addPeers([
        [OWNER_ID, { observeMe: true, observeOthers: false }],
        [agentPeer.id, { observeMe: true, observeOthers: true }],
      ]);

      if (event.messages.length <= lastSavedIndex) {
        api.logger.debug?.("No new messages to save");
        return;
      }

      const newRawMessages = event.messages.slice(lastSavedIndex);
      api.logger.debug?.(
        `[honcho] new raw slice from=${lastSavedIndex} count=${newRawMessages.length} summary=${summarizeRawMessages(newRawMessages)}`
      );
      const messages = extractMessages(newRawMessages, state.ownerPeer!, agentPeer);
      api.logger.debug?.(
        `[honcho] extracted messages count=${messages.length} fromRaw=${newRawMessages.length}`
      );

      if (messages.length === 0) {
        api.logger.debug?.(
          `[honcho] no persistable messages extracted; advancing lastSavedIndex=${event.messages.length}`
        );
        await session.setMetadata({ ...meta, ...sessionMeta, lastSavedIndex: event.messages.length });
        return;
      }

      await session.addMessages(messages);
      api.logger.debug?.(
        `[honcho] persisted messages count=${messages.length}; updating lastSavedIndex=${event.messages.length}`
      );
      await session.setMetadata({ ...meta, ...sessionMeta, lastSavedIndex: event.messages.length });
    } catch (error) {
      api.logger.error(`[honcho] Failed to save messages to Honcho: ${error}`);
      if (error instanceof Error) {
        api.logger.error(`[honcho] Stack: ${error.stack}`);
        const anyError = error as unknown as Record<string, unknown>;
        if (anyError.status) api.logger.error(`[honcho] Status: ${anyError.status}`);
        if (anyError.body) api.logger.error(`[honcho] Body: ${JSON.stringify(anyError.body)}`);
      }
    }
  });
}
