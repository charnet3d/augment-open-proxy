import {
  AugmentLanguageModel,
  resolveAugmentCredentials,
  type AugmentCredentials,
} from "@augmentcode/auggie-sdk";
import { patchModelForImages } from "./augmentImagePatch";

// User-Agent that identifies as the Augment CLI. Some models (like Prism) are
// gated behind this UA.
const CLI_USER_AGENT = "augment.cli/0.28.0 (commit 63537d73)/noninteractive";

// Cache resolved credentials for the process lifetime to avoid repeated
// session-file reads. The SDK's resolveAugmentCredentials() reads
// AUGMENT_API_TOKEN/AUGMENT_API_URL from env automatically.
let cachedCredentials: AugmentCredentials | null = null;

async function getCachedCredentials(): Promise<AugmentCredentials> {
  if (cachedCredentials) return cachedCredentials;
  cachedCredentials = await resolveAugmentCredentials();
  return cachedCredentials;
}

// Router models (currently only butler_a / prism-a) are gated by the CLI
// user-agent and require CLI_NONINTERACTIVE mode. Kept as an exact-match list
// for now to minimize blast radius; broaden when more routers are confirmed.
function isRouterModel(modelId: string): boolean {
  return modelId === "butler_a";
}

export async function getAugmentModel(modelId: string): Promise<AugmentLanguageModel> {
  const creds = await getCachedCredentials();
  const router = isRouterModel(modelId);

  // Model IDs arriving here are already in canonical form (e.g. "claude-haiku-4-5",
  // "gpt-5-4", "gemini-3-1-pro-preview") because expandShortName() is applied at
  // registry load time. The SDK uses CLI_AGENT mode by default, which the backend
  // accepts for canonical names with both session and API-key auth.
  const model = new AugmentLanguageModel(modelId, {
    apiKey: creds.apiKey,
    apiUrl: creds.apiUrl,
    debug: process.env.DEBUG === "true",
    // Router models are only visible to requests carrying the CLI user-agent.
    clientUserAgent: router ? CLI_USER_AGENT : "augment-open-proxy/1.0.0",
  });

  // CHAT mode is required for two independent reasons:
  //  1. API-key auth: the backend rejects CLI_AGENT mode with direct API keys.
  //  2. Short model IDs: the registry exposes short names (e.g. "haiku4.5") that
  //     the backend only accepts in CHAT mode; long names (e.g. "claude-haiku-4-5")
  //     work with either mode.
  // CHAT mode is accepted for all auth types and model ID formats, so we always
  // use it. generateText/streamText call buildPayload internally, so the patch
  // applies regardless of which high-level AI SDK function is used.
  // const originalBuildPayload = (model as any).buildPayload.bind(model);
  // (model as any).buildPayload = (options: unknown) => {
  //   const payload = originalBuildPayload(options);
  //   return { ...payload, mode: "CHAT" };
  // };

  // Router models need CLI_NONINTERACTIVE; the SDK defaults to CLI_AGENT, which
  // the backend rejects with 404 for these. Guarded so the mocked SDK in tests
  // (which has no buildPayload) is not affected.
  const original = (model as any).buildPayload;
  if (router && typeof original === "function") {
    const bound = original.bind(model);
    (model as any).buildPayload = (options: unknown) => ({
      ...bound(options),
      mode: "CLI_NONINTERACTIVE",
    });
  }

  // Experimental: enable image input by injecting Augment IMAGE nodes for
  // AI SDK v5 file parts. The SDK drops images by default. Falls back to the
  // SDK's original buildPayload for prompts without images.
  patchModelForImages(model);

  return model;
}

export async function validateCredentials(): Promise<boolean> {
  try {
    await getCachedCredentials();
    return true;
  } catch {
    return false;
  }
}