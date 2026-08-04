import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the SDK at the module level ──────────────────────────
const mockResolveCredentials = vi.fn();

// Track constructor calls for AugmentLanguageModel
const constructorCalls: Array<[string, object]> = [];

// Use a class-based mock so it works with `new AugmentLanguageModel(...)`
class MockAugmentLanguageModel {
  modelId: string;
  constructor(modelId: string, options: object) {
    constructorCalls.push([modelId, options]);
    this.modelId = modelId;
  }
  doGenerate = vi.fn();
  doStream = vi.fn();
  // Minimal stand-in for the SDK's buildPayload, needed to exercise
  // getAugmentModel()'s forced-mode wrapping (router / Sonnet 5 overrides).
  buildPayload = vi.fn((options: unknown) => ({ mode: "CLI_AGENT", options }));
}

vi.mock("@augmentcode/auggie-sdk", () => ({
  resolveAugmentCredentials: () => mockResolveCredentials(),
  AugmentLanguageModel: MockAugmentLanguageModel,
}));

describe("augmentClient", () => {
  let validateCredentials: () => Promise<boolean>;
  let getAugmentModel: (id: string) => Promise<any>;

  beforeEach(async () => {
    vi.clearAllMocks();
    constructorCalls.length = 0;

    // Clear module cache to get fresh imports with fresh cachedCredentials
    vi.resetModules();

    // Reset the mock before each test
    mockResolveCredentials.mockReset();

    // Re-import after clearing modules
    const augmentClient = await import("../services/augmentClient");
    validateCredentials = augmentClient.validateCredentials;
    getAugmentModel = augmentClient.getAugmentModel;
  });

  describe("validateCredentials", () => {
    it("should return true when credentials resolve successfully", async () => {
      mockResolveCredentials.mockResolvedValue({
        apiKey: "test-key",
        apiUrl: "https://api.test.com",
      });

      const result = await validateCredentials();

      expect(result).toBe(true);
      expect(mockResolveCredentials).toHaveBeenCalledTimes(1);
    });

    it("should return false when credentials resolution fails", async () => {
      mockResolveCredentials.mockRejectedValue(
        new Error("No credentials found")
      );

      const result = await validateCredentials();

      expect(result).toBe(false);
    });

    it("should handle any error type gracefully", async () => {
      mockResolveCredentials.mockRejectedValue("string error");

      const result = await validateCredentials();

      expect(result).toBe(false);
    });
  });

  describe("getAugmentModel", () => {
    it("should create a model with resolved credentials", async () => {
      mockResolveCredentials.mockResolvedValue({
        apiKey: "test-key",
        apiUrl: "https://api.test.com",
      });

      await getAugmentModel("claude-sonnet-4-5");

      expect(constructorCalls.length).toBe(1);
      expect(constructorCalls[0][0]).toBe("claude-sonnet-4-5");
      expect(constructorCalls[0][1]).toMatchObject({
        apiKey: "test-key",
        apiUrl: "https://api.test.com",
        clientUserAgent: "augment-open-proxy/1.0.0",
      });
    });

    it("should pass model ID through to the SDK unchanged", async () => {
      mockResolveCredentials.mockResolvedValue({
        apiKey: "test-key",
        apiUrl: "https://api.test.com",
      });

      await getAugmentModel("claude-sonnet-4-5");

      expect(constructorCalls[0][0]).toBe("claude-sonnet-4-5");
    });

    it("should cache credentials and not re-resolve on subsequent calls", async () => {
      mockResolveCredentials.mockResolvedValue({
        apiKey: "test-key",
        apiUrl: "https://api.test.com",
      });

      await getAugmentModel("claude-sonnet-4-5");
      await getAugmentModel("claude-haiku-4-5");

      // Should only be called once (cached)
      expect(mockResolveCredentials).toHaveBeenCalledTimes(1);
    });

    it("should throw when credentials resolution fails", async () => {
      mockResolveCredentials.mockRejectedValue(
        new Error("Credentials not found")
      );

      await expect(getAugmentModel("claude-sonnet-4-5")).rejects.toThrow(
        "Credentials not found"
      );
    });

    it("should set debug to false by default", async () => {
      mockResolveCredentials.mockResolvedValue({
        apiKey: "test-key",
        apiUrl: "https://api.test.com",
      });

      await getAugmentModel("claude-sonnet-4-5");

      expect(constructorCalls[0][1]).toMatchObject({ debug: false });
    });

    it("should set debug to true when DEBUG env is 'true'", async () => {
      process.env.DEBUG = "true";
      mockResolveCredentials.mockResolvedValue({
        apiKey: "test-key",
        apiUrl: "https://api.test.com",
      });

      // Need fresh import to pick up env change
      vi.resetModules();
      constructorCalls.length = 0;
      const { getAugmentModel: getAugmentModelFresh } = await import("../services/augmentClient");
      await getAugmentModelFresh("claude-sonnet-4-5");

      expect(constructorCalls[0][1]).toMatchObject({ debug: true });

      delete process.env.DEBUG;
    });

    describe("mode override", () => {
      beforeEach(() => {
        mockResolveCredentials.mockResolvedValue({
          apiKey: "test-key",
          apiUrl: "https://api.test.com",
        });
      });

      it("forces CLI_NONINTERACTIVE for router model butler_a", async () => {
        const model = (await getAugmentModel("butler_a")) as any;
        const payload = model.buildPayload({ prompt: [] });
        expect(payload.mode).toBe("CLI_NONINTERACTIVE");
      });

      it("forces CHAT for claude-sonnet-5 base and suffixed variants", async () => {
        for (const id of ["claude-sonnet-5", "claude-sonnet-5-high", "claude-sonnet-5-500k"]) {
          vi.resetModules();
          constructorCalls.length = 0;
          const { getAugmentModel: fresh } = await import("../services/augmentClient");
          const model = (await fresh(id)) as any;
          const payload = model.buildPayload({ prompt: [] });
          expect(payload.mode).toBe("CHAT");
        }
      });

      it("leaves the SDK default mode untouched for other models", async () => {
        const model = (await getAugmentModel("claude-sonnet-4-5")) as any;
        const payload = model.buildPayload({ prompt: [] });
        expect(payload.mode).toBe("CLI_AGENT");
      });

      it("does not treat claude-sonnet-4x models as Sonnet 5", async () => {
        const model = (await getAugmentModel("claude-sonnet-4-6-500k")) as any;
        const payload = model.buildPayload({ prompt: [] });
        expect(payload.mode).toBe("CLI_AGENT");
      });
    });
  });
});
