import { describe, expect, it, vi, beforeEach } from "vitest";
import { getHonchoMemorySearchManager } from "../runtime.js";
import type { PluginState } from "../state.js";
import { execSync } from "child_process";

// Mock child_process.execSync
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

type TestState = PluginState & {
  participantPeer: {
    id: string;
    search: ReturnType<typeof vi.fn>;
    sessions: ReturnType<typeof vi.fn>;
  } | null;
};

function createMemoryConfig(overrides: Record<string, unknown> = {}) {
  return {
    backend: "qmd",
    qmd: {
      searchMode: "query",
      command: "/usr/local/bin/qmd",
      includeDefaultMemory: true,
      ...overrides,
    },
  };
}

function createSession(sessionId: string) {
  return {
    id: sessionId,
    context: vi.fn(async () => ({
      summary: { content: `Summary for ${sessionId}` },
      messages: [
        { peerId: "owner", content: `Message from ${sessionId}` },
      ],
    })),
    search: vi.fn(async () => [
      { id: `msg-${sessionId}`, sessionId, content: `Hit from ${sessionId}` },
    ]),
  };
}

function createState(config: { memory?: Record<string, unknown> } = {}): TestState {
  const participantPeer = {
    id: "owner",
    search: vi.fn(async () => [
      { sessionId: "session-1", content: "Need to remember this" },
    ]),
    sessions: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {},
    })),
  };

  const state = {
    cfg: {
      workspaceId: "openclaw",
      baseUrl: "http://10.0.0.4:8077",
      noisePatterns: [],
      disableDefaultNoisePatterns: false,
      ownerObserveOthers: false,
      crossSessionSearch: true,
    },
    honcho: {
      session: vi.fn(async (sessionId: string) => createSession(sessionId)),
    } as never,
    participantPeer,
    participantPeers: new Map(),
    agentPeers: new Map(),
    agentPeerMap: {},
    turnStartIndex: new Map(),
    initialized: true,
    api: {
      config: config.memory ? { memory: config.memory } : {},
    } as never,
    ensureInitialized: vi.fn(async () => {}),
    getAgentPeer: vi.fn(async (agentId = "main") => ({ id: `agent-${agentId}` })),
    getParticipantPeer: vi.fn(async () => {
      if (!state.participantPeer) throw new Error("Honcho owner peer not initialized");
      return state.participantPeer;
    }),
    resolveSessionParticipantPeer: vi.fn(async () => {
      if (!state.participantPeer) throw new Error("Honcho owner peer not initialized");
      return state.participantPeer;
    }),
    isParticipantPeerId: vi.fn((peerId: string) => peerId === "owner"),
    resolveDefaultAgentId: vi.fn(() => "main"),
  } as unknown as TestState;
  return state;
}

const QMD_RESPONSE = JSON.stringify([
  {
    docid: "#abc1",
    score: 0.78,
    file: "qmd://wiki-memory/assessments/basc3-report.md",
    line: 3,
    title: "BASC-3 Report",
    context: "School psych assessments",
    snippet: "BASC-3 assessment criteria",
  },
]);

// ---------------------------------------------------------------------------
// isQmdConfigured / status()
// ---------------------------------------------------------------------------
describe("QMD bridge — config detection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns honcho+qmd when fully configured", async () => {
    const state = createState({ memory: createMemoryConfig() });
    const { manager } = await getHonchoMemorySearchManager(state, { agentId: "main" });
    const s = manager.status();
    expect(s.provider).toBe("honcho+qmd");
    expect(s.sources).toContain("qmd");
    expect((s.custom as Record<string, unknown>).qmd).toBe(true);
  });

  it("returns honcho when no memory config", async () => {
    const state = createState();
    const { manager } = await getHonchoMemorySearchManager(state, { agentId: "main" });
    const s = manager.status();
    expect(s.provider).toBe("honcho");
    expect(s.sources).toEqual(["sessions"]);
  });

  it("returns honcho when backend is not qmd", async () => {
    const state = createState({ memory: { backend: "builtin" } });
    const { manager } = await getHonchoMemorySearchManager(state, { agentId: "main" });
    const s = manager.status();
    expect(s.provider).toBe("honcho");
  });

  it("returns honcho+qmd when qmd block exists (even empty)", async () => {
    const state = createState({ memory: createMemoryConfig({ command: undefined, searchMode: undefined }) });
    // Empty qmd block — isQmdConfigured checks mem?.qmd truthiness
    // But qmd is { includeDefaultMemory: true } which is truthy
    // So for this test, set qmd to {}
    const memState = createState({ memory: { backend: "qmd", qmd: {} } });
    const { manager } = await getHonchoMemorySearchManager(memState, { agentId: "main" });
    const s = manager.status();
    expect(s.provider).toBe("honcho+qmd");
  });
});

// ---------------------------------------------------------------------------
// qmdSearch field mapping and command construction
// ---------------------------------------------------------------------------
describe("QMD bridge — search", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps qmd JSON fields to memory-search shape", async () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue(QMD_RESPONSE);

    const state = createState({ memory: createMemoryConfig() });
    const { manager } = await getHonchoMemorySearchManager(state, { agentId: "main" });

    const results = await manager.search("basc3", { maxResults: 5 });

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining("qmd query"),
      expect.objectContaining({ timeout: 30000 }),
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].path).toBe("qmd://wiki-memory/assessments/basc3-report.md");
    expect(results[0].startLine).toBe(3);
    expect(results[0].endLine).toBe(3);
    expect(results[0].score).toBe(0.78);
    expect(results[0].source).toBe("qmd");
    expect(results[0].snippet).toContain("BASC-3");
  });

  it("uses configured searchMode for the subprocess command", async () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue(QMD_RESPONSE);

    const state = createState({ memory: createMemoryConfig({ searchMode: "vsearch" }) });
    const { manager } = await getHonchoMemorySearchManager(state, { agentId: "main" });

    await manager.search("basc3", { maxResults: 1 });

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining("vsearch"),
      expect.any(Object),
    );
  });

  it("uses qmd binary path from config", async () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue(QMD_RESPONSE);

    const state = createState({ memory: createMemoryConfig({ command: "/custom/qmd" }) });
    const { manager } = await getHonchoMemorySearchManager(state, { agentId: "main" });

    await manager.search("basc3", { maxResults: 1 });

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining("/custom/qmd"),
      expect.any(Object),
    );
  });

  it("defaults to qmd on PATH when command is not configured", async () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue(QMD_RESPONSE);

    const state = createState({ memory: createMemoryConfig({ command: undefined }) });
    const { manager } = await getHonchoMemorySearchManager(state, { agentId: "main" });

    await manager.search("basc3", { maxResults: 1 });

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining("qmd query"),
      expect.any(Object),
    );
  });

  it("falls through when qmd search throws", async () => {
    (execSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("QMD not found");
    });

    const state = createState({ memory: createMemoryConfig() });
    const { manager } = await getHonchoMemorySearchManager(state, {
      agentId: "main",
      sessionKey: "session-1",
    });

    const results = await manager.search("basc3", { maxResults: 5 });
    // Should return Honcho session results when QMD fails
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r: Record<string, unknown>) => r.source === "sessions")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readFile with qmd:// URIs
// ---------------------------------------------------------------------------
describe("QMD bridge — readFile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads qmd:// paths via qmd get", async () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue("# BASC-3 Report\nContent\n");

    const state = createState({ memory: createMemoryConfig() });
    const { manager } = await getHonchoMemorySearchManager(state, { agentId: "main" });

    const file = await manager.readFile({
      relPath: "qmd://wiki-memory/assessments/basc3.md",
    });

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining("qmd get"),
      expect.any(Object),
    );
    expect(file.path).toBe("qmd://wiki-memory/assessments/basc3.md");
    expect(file.text).toContain("BASC-3 Report");
    expect((file as Record<string, unknown>).source).toBe("qmd");
  });

  it("throws on qmd:// path when qmd get fails", async () => {
    (execSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("qmd get failed");
    });

    const state = createState({ memory: createMemoryConfig() });
    const { manager } = await getHonchoMemorySearchManager(state, { agentId: "main" });

    await expect(
      manager.readFile({ relPath: "qmd://wiki-memory/missing.md" }),
    ).rejects.toThrow(/Unsupported Honcho memory path/);
  });
});

// ---------------------------------------------------------------------------
// Score clamping
// ---------------------------------------------------------------------------
describe("QMD bridge — score clamping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clamps session scores to 0.5 in merged results", async () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue(QMD_RESPONSE);

    const state = createState({ memory: createMemoryConfig() });
    const { manager } = await getHonchoMemorySearchManager(state, {
      agentId: "main",
      sessionKey: "session-1",
    });

    const results = await manager.search("basc3", { maxResults: 10 });

    // QMD results keep real scores
    const qmd = results.filter((r: Record<string, unknown>) => r.source === "qmd");
    expect(qmd.length).toBeGreaterThan(0);
    for (const r of qmd) {
      expect(r.score).toBeGreaterThan(0.5);
    }

    // Session results clamped
    const ses = results.filter((r: Record<string, unknown>) => r.source === "sessions");
    for (const r of ses) {
      expect(r.score).toBeLessThanOrEqual(0.5);
    }
  });

  it("returns only session results when QMD is not configured", async () => {
    const state = createState(); // no memory config
    const { manager } = await getHonchoMemorySearchManager(state, {
      agentId: "main",
      sessionKey: "session-1",
    });

    const results = await manager.search("anything", { maxResults: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r: Record<string, unknown>) => r.source === "sessions")).toBe(true);
  });
});
