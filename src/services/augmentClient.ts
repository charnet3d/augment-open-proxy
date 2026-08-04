import {
  AugmentLanguageModel,
  resolveAugmentCredentials,
  type AugmentCredentials,
} from "@augmentcode/auggie-sdk";
import { patchModelForImages } from "./augmentImagePatch";
import { patchModelForSignatures } from "./augmentSignaturePatch";

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

// Router models are gated by the CLI user-agent and require CLI_NONINTERACTIVE
// mode. The CLI/registry advertises the router under its user-facing name
// ("prism-a"); the Augment backend only accepts requests naming the internal
// model ID ("butler_a"). Kept as an exact-match pair for now to minimize
// blast radius; broaden when more routers are confirmed.
const ROUTER_PUBLIC_MODEL_ID = "prism-a";
const ROUTER_INTERNAL_MODEL_ID = "butler_a";

function isRouterModel(modelId: string): boolean {
  return modelId === ROUTER_PUBLIC_MODEL_ID || modelId === ROUTER_INTERNAL_MODEL_ID;
}

// Sonnet 5 (base + effort/size suffixes, e.g. "claude-sonnet-5-high",
// "claude-sonnet-5-500k") returns HTTP 500 under the SDK's default CLI_AGENT
// mode but works under CHAT mode, confirmed by direct SDK probing. Matches
// only the "-5" family so "claude-sonnet-4*" etc. are untouched.
function isSonnet5Model(modelId: string): boolean {
  return /^claude-sonnet-5(-|$)/.test(modelId);
}

export async function getAugmentModel(modelId: string): Promise<AugmentLanguageModel> {
  const creds = await getCachedCredentials();
  const router = isRouterModel(modelId);
  // Translate the user-facing router name to the internal ID the backend
  // actually expects. All other model IDs pass through unchanged.
  const backendModelId = modelId === ROUTER_PUBLIC_MODEL_ID ? ROUTER_INTERNAL_MODEL_ID : modelId;

  // Model IDs arriving here are already in canonical form (e.g. "claude-haiku-4-5",
  // "gpt-5-4", "gemini-3-1-pro-preview") because expandShortName() is applied at
  // registry load time. The SDK uses CLI_AGENT mode by default, which the backend
  // accepts for canonical names with both session and API-key auth.
  const model = new AugmentLanguageModel(backendModelId, {
    apiKey: creds.apiKey,
    apiUrl: creds.apiUrl,
    debug: process.env.DEBUG === "true",
    // Router models are only visible to requests carrying the CLI user-agent.
    clientUserAgent: router ? CLI_USER_AGENT : "augment-open-proxy/1.0.0",
  });

  // Some models require a non-default `mode` on the request payload:
  //  - Router models (butler_a / prism-a) need CLI_NONINTERACTIVE; the SDK's
  //    default CLI_AGENT is rejected with 404 for these.
  //  - Sonnet 5 needs CHAT; CLI_AGENT returns HTTP 500 for this family.
  // Guarded so the mocked SDK in tests (which has no buildPayload) is not
  // affected. At most one of these applies per model.
  const forcedMode = router
    ? "CLI_NONINTERACTIVE"
    : isSonnet5Model(modelId)
      ? "CHAT"
      : undefined;
  const original = (model as any).buildPayload;
  if (forcedMode && typeof original === "function") {
    const bound = original.bind(model);
    (model as any).buildPayload = (options: unknown) => ({
      ...bound(options),
      mode: forcedMode,
    });
  }

  // Experimental: enable image input by injecting Augment IMAGE nodes for
  // AI SDK v5 file parts. The SDK drops images by default. Falls back to the
  // SDK's original buildPayload for prompts without images. The image-path
  // payload is built from scratch (not via the wrapped buildPayload above),
  // so it needs the same forced mode passed through explicitly.
  patchModelForImages(model, forcedMode ?? "CLI_AGENT");

  // Flatten tool-call history for router models (butler_a / prism-a) that
  // route to Vertex AI Gemini thinking backends. Augment strips thought
  // signatures server-side, so we convert all structured tool turns to plain
  // text to avoid signature-validation errors on replayed history.
  patchModelForSignatures(model);

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