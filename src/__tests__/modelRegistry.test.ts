import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:child_process so tests never call the real auggie binary
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Short names as the CLI returns them; the registry must expand these before
// serving them to clients.
const SAMPLE_CLI_OUTPUT = JSON.stringify({
  registryAvailable: true,
  models: [
    { shortName: "haiku4.5", displayName: "Haiku 4.5" },
    { shortName: "sonnet4.6", displayName: "Sonnet 4.6" },
    { shortName: "opus4.7", displayName: "Opus 4.7" },
    { shortName: "gpt5.1", displayName: "GPT-5.1" },
    { shortName: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview" },
    { shortName: "code-review", displayName: "Code Review" },
  ],
});

describe("modelRegistry", () => {
  let execFileMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Reset module cache so cachedModelIds is cleared between tests
    vi.resetModules();
    const cp = await import("node:child_process");
    execFileMock = cp.execFile as unknown as ReturnType<typeof vi.fn>;
    execFileMock.mockReset();
  });

  /** Makes execFile call its callback with stdout */
  function succeedWith(output: string) {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => cb(null, output)
    );
  }

  /** Makes execFile call its callback with an error */
  function failWith(err: Error) {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => cb(err, "")
    );
  }

  describe("listModels — CLI success", () => {
    it("should return expanded canonical IDs from CLI shortName fields", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { listModels } = await import("../services/modelRegistry");
      const result = await listModels();
      // Short names from CLI must be expanded to canonical backend names.
      expect(result.data.map((m) => m.id)).toEqual([
        "claude-haiku-4-5",
        "claude-sonnet-4-6",
        "claude-opus-4-7",
        "gpt-5-1",
        "gemini-3-1-pro-preview",
        "code-review",
      ]);
    });

    it("should return OpenAI list format with required fields", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { listModels } = await import("../services/modelRegistry");
      const result = await listModels();
      expect(result.object).toBe("list");
      for (const model of result.data) {
        expect(model.object).toBe("model");
        expect(typeof model.id).toBe("string");
        expect(typeof model.created).toBe("number");
        expect(model.owned_by).toBe("augment");
      }
    });

    it("should set created timestamp close to now", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { listModels } = await import("../services/modelRegistry");
      const before = Math.floor(Date.now() / 1000) - 1;
      const result = await listModels();
      const after = Math.floor(Date.now() / 1000) + 1;
      for (const model of result.data) {
        expect(model.created).toBeGreaterThanOrEqual(before);
        expect(model.created).toBeLessThanOrEqual(after);
      }
    });
  });

  describe("listModels — fallback", () => {
    it("should fall back to FALLBACK_MODEL_IDS when CLI fails", async () => {
      failWith(new Error("auggie: command not found"));
      const { listModels, FALLBACK_MODEL_IDS } = await import("../services/modelRegistry");
      const result = await listModels();
      expect(result.data.map((m) => m.id)).toEqual([...FALLBACK_MODEL_IDS]);
    });

    it("should fall back when CLI output is invalid JSON", async () => {
      succeedWith("not valid json at all");
      const { listModels, FALLBACK_MODEL_IDS } = await import("../services/modelRegistry");
      const result = await listModels();
      expect(result.data.map((m) => m.id)).toEqual([...FALLBACK_MODEL_IDS]);
    });

    it("should fall back when models array is empty", async () => {
      succeedWith(JSON.stringify({ registryAvailable: true, models: [] }));
      const { listModels, FALLBACK_MODEL_IDS } = await import("../services/modelRegistry");
      const result = await listModels();
      expect(result.data.map((m) => m.id)).toEqual([...FALLBACK_MODEL_IDS]);
    });

    it("should fall back when models field is missing", async () => {
      succeedWith(JSON.stringify({ registryAvailable: false }));
      const { listModels, FALLBACK_MODEL_IDS } = await import("../services/modelRegistry");
      const result = await listModels();
      expect(result.data.map((m) => m.id)).toEqual([...FALLBACK_MODEL_IDS]);
    });
  });

  describe("isModelAvailable", () => {
    it("should return true for expanded canonical names from CLI output", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { isModelAvailable } = await import("../services/modelRegistry");
      // These are the expanded names, not the raw short names
      expect(await isModelAvailable("claude-haiku-4-5")).toBe(true);
      expect(await isModelAvailable("claude-sonnet-4-6")).toBe(true);
      expect(await isModelAvailable("gpt-5-1")).toBe(true);
      expect(await isModelAvailable("gemini-3-1-pro-preview")).toBe(true);
      expect(await isModelAvailable("code-review")).toBe(true);
    });

    it("should return false for the raw CLI short names (they are not stored)", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { isModelAvailable } = await import("../services/modelRegistry");
      expect(await isModelAvailable("haiku4.5")).toBe(false);
      expect(await isModelAvailable("sonnet4.6")).toBe(false);
      expect(await isModelAvailable("gpt5.1")).toBe(false);
    });

    it("should return false for a model not in CLI output", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { isModelAvailable } = await import("../services/modelRegistry");
      expect(await isModelAvailable("gpt-4")).toBe(false);
      expect(await isModelAvailable("claude-sonnet-4-5")).toBe(false);
    });

    it("should return false for empty string", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { isModelAvailable } = await import("../services/modelRegistry");
      expect(await isModelAvailable("")).toBe(false);
    });

    it("should be case-sensitive", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { isModelAvailable } = await import("../services/modelRegistry");
      expect(await isModelAvailable("Claude-Haiku-4-5")).toBe(false);
      expect(await isModelAvailable("CLAUDE-HAIKU-4-5")).toBe(false);
    });

    it("should return true for canonical fallback model when CLI fails", async () => {
      failWith(new Error("not found"));
      const { isModelAvailable } = await import("../services/modelRegistry");
      expect(await isModelAvailable("claude-haiku-4-5")).toBe(true);
    });
  });

  describe("caching", () => {
    it("should call CLI only once and cache the result", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { getModelIds } = await import("../services/modelRegistry");
      await getModelIds();
      await getModelIds();
      await getModelIds();
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it("should not retry auggie within the cooldown window after a fallback", async () => {
      failWith(new Error("auggie: command not found"));
      const { getModelIds } = await import("../services/modelRegistry");
      await getModelIds();
      await getModelIds();
      await getModelIds();
      // Within the cooldown the fallback cache is served without calling auggie again.
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it("should retry auggie after the cooldown has elapsed", async () => {
      vi.useFakeTimers();
      failWith(new Error("auggie: command not found"));
      const { getModelIds, RETRY_COOLDOWN_MS } = await import("../services/modelRegistry");
      await getModelIds();
      expect(execFileMock).toHaveBeenCalledTimes(1);

      // Still within cooldown — no retry yet.
      await getModelIds();
      expect(execFileMock).toHaveBeenCalledTimes(1);

      // Advance past the cooldown — next call must retry auggie.
      vi.advanceTimersByTime(RETRY_COOLDOWN_MS + 1);
      await getModelIds();
      expect(execFileMock).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it("should lock in the real result once auggie eventually succeeds", async () => {
      vi.useFakeTimers();
      // First call fails → fallback
      failWith(new Error("not ready"));
      const { getModelIds, FALLBACK_MODEL_IDS, RETRY_COOLDOWN_MS } = await import("../services/modelRegistry");
      const first = await getModelIds();
      expect(first).toEqual([...FALLBACK_MODEL_IDS]);
      expect(execFileMock).toHaveBeenCalledTimes(1);

      // Advance past cooldown then succeed → real model list, now cached permanently
      vi.advanceTimersByTime(RETRY_COOLDOWN_MS + 1);
      succeedWith(SAMPLE_CLI_OUTPUT);
      const second = await getModelIds();
      expect(second).toContain("claude-haiku-4-5");
      expect(second).not.toEqual([...FALLBACK_MODEL_IDS]);
      expect(execFileMock).toHaveBeenCalledTimes(2);

      // Further calls never hit the CLI again — real result is locked in
      await getModelIds();
      await getModelIds();
      expect(execFileMock).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  describe("FALLBACK_MODEL_IDS", () => {
    it("should be a non-empty array", async () => {
      const { FALLBACK_MODEL_IDS } = await import("../services/modelRegistry");
      expect(Array.isArray(FALLBACK_MODEL_IDS)).toBe(true);
      expect(FALLBACK_MODEL_IDS.length).toBeGreaterThan(0);
    });

    it("should contain only canonical (expanded) model names — no dots, no bare short names", async () => {
      const { FALLBACK_MODEL_IDS } = await import("../services/modelRegistry");
      expect(FALLBACK_MODEL_IDS).toContain("claude-haiku-4-5");
      expect(FALLBACK_MODEL_IDS).toContain("claude-sonnet-4-6");
      expect(FALLBACK_MODEL_IDS).toContain("claude-opus-4-7");
      // Must not contain raw short names with dots
      for (const id of FALLBACK_MODEL_IDS) {
        expect(id).not.toMatch(/\./);
      }
    });
  });
});

// CLI output mirroring real `auggie models list --json` payloads, where some
// entries advertise effortLevels and others don't. The registry must expand
// each effort level into a suffixed canonical ID.
const EFFORT_CLI_OUTPUT = JSON.stringify({
  registryAvailable: true,
  models: [
    { shortName: "haiku4.5", displayName: "Haiku 4.5" },
    {
      shortName: "opus4.6",
      displayName: "Opus 4.6",
      effortLevels: ["Low", "Medium", "High", "Max"],
    },
    {
      shortName: "opus4.7",
      displayName: "Opus 4.7",
      effortLevels: ["Medium", "High", "xHigh"],
    },
  ],
});

describe("modelRegistry — effort variants", () => {
  let execFileMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    execFileMock = cp.execFile as unknown as ReturnType<typeof vi.fn>;
    execFileMock.mockReset();
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) =>
        cb(null, EFFORT_CLI_OUTPUT)
    );
  });

  it("expands each advertised effortLevel into a suffixed canonical ID", async () => {
    const { listModels } = await import("../services/modelRegistry");
    const ids = (await listModels()).data.map((m) => m.id);
    expect(ids).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-opus-4-6-low",
      "claude-opus-4-6-medium",
      "claude-opus-4-6-high",
      "claude-opus-4-6-max",
      "claude-opus-4-7",
      "claude-opus-4-7-medium",
      "claude-opus-4-7-high",
      "claude-opus-4-7-xhigh",
    ]);
  });

  it("treats suffixed variants as available models", async () => {
    const { isModelAvailable } = await import("../services/modelRegistry");
    expect(await isModelAvailable("claude-opus-4-7-high")).toBe(true);
    expect(await isModelAvailable("claude-opus-4-7-xhigh")).toBe(true);
    expect(await isModelAvailable("claude-opus-4-6-low")).toBe(true);
  });

  it("does not invent a suffix when the model omits effortLevels", async () => {
    const { isModelAvailable } = await import("../services/modelRegistry");
    expect(await isModelAvailable("claude-haiku-4-5")).toBe(true);
    expect(await isModelAvailable("claude-haiku-4-5-high")).toBe(false);
  });
});

describe("resolveEffortModelId", () => {
  let execFileMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    execFileMock = cp.execFile as unknown as ReturnType<typeof vi.fn>;
    execFileMock.mockReset();
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) =>
        cb(null, EFFORT_CLI_OUTPUT)
    );
  });

  it("returns the suffixed ID for an exact-match effort level", async () => {
    const { resolveEffortModelId } = await import("../services/modelRegistry");
    expect(await resolveEffortModelId("claude-opus-4-6", "high")).toBe("claude-opus-4-6-high");
    expect(await resolveEffortModelId("claude-opus-4-6", "low")).toBe("claude-opus-4-6-low");
    expect(await resolveEffortModelId("claude-opus-4-7", "medium")).toBe("claude-opus-4-7-medium");
  });

  it("snaps an unsupported level to the closest advertised level", async () => {
    const { resolveEffortModelId } = await import("../services/modelRegistry");
    // opus4.7 has no "low" — closest is "medium".
    expect(await resolveEffortModelId("claude-opus-4-7", "low")).toBe("claude-opus-4-7-medium");
  });

  it("maps OpenAI 'minimal' to the lowest advertised level", async () => {
    const { resolveEffortModelId } = await import("../services/modelRegistry");
    // opus4.6 advertises Low → exact match.
    expect(await resolveEffortModelId("claude-opus-4-6", "minimal")).toBe("claude-opus-4-6-low");
    // opus4.7 has no Low → snap to Medium (closest to "low").
    expect(await resolveEffortModelId("claude-opus-4-7", "minimal")).toBe("claude-opus-4-7-medium");
  });

  it("maps OpenAI 'xhigh' to the matching Augment tier when advertised", async () => {
    const { resolveEffortModelId } = await import("../services/modelRegistry");
    // opus4.7 advertises xHigh → exact match.
    expect(await resolveEffortModelId("claude-opus-4-7", "xhigh")).toBe("claude-opus-4-7-xhigh");
    // opus4.6 has no xHigh → snap to Max (closest to "xhigh").
    expect(await resolveEffortModelId("claude-opus-4-6", "xhigh")).toBe("claude-opus-4-6-max");
  });

  it("returns undefined for OpenAI 'none' so the base model is used", async () => {
    const { resolveEffortModelId } = await import("../services/modelRegistry");
    expect(await resolveEffortModelId("claude-opus-4-6", "none")).toBeUndefined();
    expect(await resolveEffortModelId("claude-opus-4-7", "none")).toBeUndefined();
  });

  it("returns undefined when the base model has no effortLevels", async () => {
    const { resolveEffortModelId } = await import("../services/modelRegistry");
    expect(await resolveEffortModelId("claude-haiku-4-5", "high")).toBeUndefined();
  });

  it("returns undefined for an unknown base model", async () => {
    const { resolveEffortModelId } = await import("../services/modelRegistry");
    expect(await resolveEffortModelId("claude-unknown-99", "high")).toBeUndefined();
  });

  it("returns undefined for an already-suffixed model ID (no double-suffix)", async () => {
    const { resolveEffortModelId } = await import("../services/modelRegistry");
    expect(await resolveEffortModelId("claude-opus-4-7-high", "low")).toBeUndefined();
  });
});

describe("AOP_DISABLE_EFFORT_MODELS env override", () => {
  let execFileMock: ReturnType<typeof vi.fn>;
  const ORIGINAL_ENV = process.env.AOP_DISABLE_EFFORT_MODELS;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    execFileMock = cp.execFile as unknown as ReturnType<typeof vi.fn>;
    execFileMock.mockReset();
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) =>
        cb(null, EFFORT_CLI_OUTPUT)
    );
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.AOP_DISABLE_EFFORT_MODELS;
    else process.env.AOP_DISABLE_EFFORT_MODELS = ORIGINAL_ENV;
  });

  it("strips suffixed variants from /v1/models for disabled base IDs", async () => {
    process.env.AOP_DISABLE_EFFORT_MODELS = "claude-opus-4-6";
    const { listModels } = await import("../services/modelRegistry");
    const ids = (await listModels()).data.map((m) => m.id);
    // opus-4-6 base is still listed, but its suffixed variants are gone.
    expect(ids).toContain("claude-opus-4-6");
    expect(ids).not.toContain("claude-opus-4-6-low");
    expect(ids).not.toContain("claude-opus-4-6-medium");
    expect(ids).not.toContain("claude-opus-4-6-high");
    expect(ids).not.toContain("claude-opus-4-6-max");
    // opus-4-7 variants are untouched.
    expect(ids).toContain("claude-opus-4-7-high");
    expect(ids).toContain("claude-opus-4-7-xhigh");
  });

  it("makes resolveEffortModelId return undefined for disabled base IDs", async () => {
    process.env.AOP_DISABLE_EFFORT_MODELS = "claude-opus-4-6";
    const { resolveEffortModelId } = await import("../services/modelRegistry");
    expect(await resolveEffortModelId("claude-opus-4-6", "high")).toBeUndefined();
    // opus-4-7 still resolves normally.
    expect(await resolveEffortModelId("claude-opus-4-7", "high")).toBe("claude-opus-4-7-high");
  });

  it("accepts CLI short names and normalises them through expandShortName", async () => {
    process.env.AOP_DISABLE_EFFORT_MODELS = "opus4.6";
    const { resolveEffortModelId } = await import("../services/modelRegistry");
    expect(await resolveEffortModelId("claude-opus-4-6", "high")).toBeUndefined();
  });

  it("supports multiple comma- or whitespace-separated entries", async () => {
    process.env.AOP_DISABLE_EFFORT_MODELS = "claude-opus-4-6, claude-opus-4-7";
    const { resolveEffortModelId, listModels } = await import("../services/modelRegistry");
    expect(await resolveEffortModelId("claude-opus-4-6", "high")).toBeUndefined();
    expect(await resolveEffortModelId("claude-opus-4-7", "high")).toBeUndefined();
    const ids = (await listModels()).data.map((m) => m.id);
    expect(ids.filter((i) => i.startsWith("claude-opus-4-6-"))).toEqual([]);
    expect(ids.filter((i) => i.startsWith("claude-opus-4-7-"))).toEqual([]);
  });

  it("disables only explicitly listed effort levels", async () => {
    process.env.AOP_DISABLE_EFFORT_MODELS =
      "claude-opus-4-7-low claude-opus-4-7-xhigh";
    const { resolveEffortModelId, listModels } = await import("../services/modelRegistry");

    expect(await resolveEffortModelId("claude-opus-4-7", "low")).toBeUndefined();
    expect(await resolveEffortModelId("claude-opus-4-7", "high")).toBe(
      "claude-opus-4-7-high"
    );
    expect(await resolveEffortModelId("claude-opus-4-7", "xhigh")).toBeUndefined();

    const ids = (await listModels()).data.map((m) => m.id);
    expect(ids).toContain("claude-opus-4-7");
    expect(ids).not.toContain("claude-opus-4-7-low");
    expect(ids).toContain("claude-opus-4-7-medium");
    expect(ids).toContain("claude-opus-4-7-high");
    expect(ids).not.toContain("claude-opus-4-7-xhigh");
  });

  it("supports short names for specific effort levels", async () => {
    process.env.AOP_DISABLE_EFFORT_MODELS = "opus4.7-low";
    const { resolveEffortModelId } = await import("../services/modelRegistry");
    expect(await resolveEffortModelId("claude-opus-4-7", "low")).toBeUndefined();
    expect(await resolveEffortModelId("claude-opus-4-7", "high")).toBe(
      "claude-opus-4-7-high"
    );
  });

  it("is a no-op when the env var is unset or empty", async () => {
    delete process.env.AOP_DISABLE_EFFORT_MODELS;
    const { resolveEffortModelId } = await import("../services/modelRegistry");
    expect(await resolveEffortModelId("claude-opus-4-6", "high")).toBe("claude-opus-4-6-high");
  });
});

describe("normalizeModelId", () => {
  let execFileMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    execFileMock = cp.execFile as unknown as ReturnType<typeof vi.fn>;
    execFileMock.mockReset();
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) =>
        cb(null, SAMPLE_CLI_OUTPUT)
    );
  });

  it("strips an Anthropic dated snapshot suffix when the stripped form is registered", async () => {
    const { normalizeModelId } = await import("../services/modelRegistry");
    // Claude Code sends dated IDs like this; the registry only knows the undated form.
    expect(await normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(await normalizeModelId("claude-sonnet-4-6-20250101")).toBe("claude-sonnet-4-6");
    expect(await normalizeModelId("claude-opus-4-7-20250930")).toBe("claude-opus-4-7");
  });

  it("returns registered IDs unchanged", async () => {
    const { normalizeModelId } = await import("../services/modelRegistry");
    expect(await normalizeModelId("claude-haiku-4-5")).toBe("claude-haiku-4-5");
    expect(await normalizeModelId("gpt-5-1")).toBe("gpt-5-1");
  });

  it("leaves an unknown ID alone when the stripped form is also unknown", async () => {
    const { normalizeModelId } = await import("../services/modelRegistry");
    expect(await normalizeModelId("claude-mystery-99-20251001")).toBe("claude-mystery-99-20251001");
  });

  it("does not strip a non-date numeric suffix (wrong digit count)", async () => {
    const { normalizeModelId } = await import("../services/modelRegistry");
    // 7 digits — not a valid date snapshot, must pass through unchanged.
    expect(await normalizeModelId("claude-haiku-4-5-2025100")).toBe("claude-haiku-4-5-2025100");
    // 9 digits — likewise.
    expect(await normalizeModelId("claude-haiku-4-5-202510010")).toBe("claude-haiku-4-5-202510010");
  });

  it("returns empty input unchanged", async () => {
    const { normalizeModelId } = await import("../services/modelRegistry");
    expect(await normalizeModelId("")).toBe("");
  });
});

// ── expandShortName unit tests (pure function, no mocking needed) ──────────
import { expandShortName } from "../services/modelRegistry";

describe("expandShortName", () => {
  it.each([
    // Claude models — base
    ["haiku4.5",  "claude-haiku-4-5"],
    ["sonnet4",   "claude-sonnet-4"],
    ["sonnet4.5", "claude-sonnet-4-5"],
    ["sonnet4.6", "claude-sonnet-4-6"],
    ["opus4.5",   "claude-opus-4-5"],
    ["opus4.6",   "claude-opus-4-6"],
    ["opus4.7",   "claude-opus-4-7"],
    // Claude models — 500k context variants
    ["opus4.6-500k",   "claude-opus-4-6-500k"],
    ["sonnet4.6-500k", "claude-sonnet-4-6-500k"],
    ["opus4.7-500k",   "claude-opus-4-7-500k"],
    // GPT models
    ["gpt5",      "gpt-5"],
    ["gpt5.1",    "gpt-5-1"],
    ["gpt5.2",    "gpt-5-2"],
    ["gpt5.4",    "gpt-5-4"],
    // GPT models — named suffix variants
    ["gpt5.4-mini",  "gpt-5-4-mini"],
    ["gpt5.6-luna",  "gpt-5-6-luna"],
    ["gpt5.6-sol",   "gpt-5-6-sol"],
    ["gpt5.6-terra", "gpt-5-6-terra"],
    // Grok models
    ["grok4.5", "grok-4-5"],
    // Gemini — dots become dashes, prefix unchanged
    ["gemini-3.1-pro-preview", "gemini-3-1-pro-preview"],
    // Pass-through (already canonical, no dots)
    ["code-review",           "code-review"],
    ["claude-haiku-4-5",      "claude-haiku-4-5"],
  ])("expandShortName(%s) === %s", (input, expected) => {
    expect(expandShortName(input)).toBe(expected);
  });
});
