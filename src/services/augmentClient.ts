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

// Public-facing model IDs that map to a different internal ID for the SDK
// call. Both entries are router models on the backend, but only "prism-a"
// needs the extra CLI gating handled by needsCliGating() below:
//  - "prism-a" -> "butler_a": gated behind the CLI user-agent and
//    CLI_NONINTERACTIVE mode.
//  - "prism-custom" -> "prism_tenant_custom": no gating needed, confirmed
//    by direct probing that the internal ID works unconditionally under the
//    SDK's default UA and CLI_AGENT mode. The raw public name 403s instead.
const PUBLIC_TO_INTERNAL_MODEL_ID: Record<string, string> = {
  "prism-a": "butler_a",
  "prism-custom": "prism_tenant_custom",
};

// Internal model ID that is unreachable without the CLI user-agent and
// CLI_NONINTERACTIVE mode. Kept as a single exact match for now to minimize
// blast radius; broaden if more CLI-gated models are confirmed.
const CLI_GATED_INTERNAL_MODEL_ID = "butler_a";

function needsCliGating(backendModelId: string): boolean {
  return backendModelId === CLI_GATED_INTERNAL_MODEL_ID;
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
  // Translate a user-facing name to the internal ID the backend actually
  // expects. All other model IDs pass through unchanged.
  const backendModelId = PUBLIC_TO_INTERNAL_MODEL_ID[modelId] ?? modelId;
  const cliGated = needsCliGating(backendModelId);

  // Model IDs arriving here are already in canonical form (e.g. "claude-haiku-4-5",
  // "gpt-5-4", "gemini-3-1-pro-preview") because expandShortName() is applied at
  // registry load time. The SDK uses CLI_AGENT mode by default, which the backend
  // accepts for canonical names with both session and API-key auth.
  const model = new AugmentLanguageModel(backendModelId, {
    apiKey: creds.apiKey,
    apiUrl: creds.apiUrl,
    debug: process.env.DEBUG === "true",
    // CLI-gated models are only visible to requests carrying the CLI user-agent.
    clientUserAgent: cliGated ? CLI_USER_AGENT : "augment-open-proxy/1.0.0",
  });

  // Some models require a non-default `mode` on the request payload:
  //  - CLI-gated models (butler_a) need CLI_NONINTERACTIVE; the SDK's
  //    default CLI_AGENT is rejected with 404 for these.
  //  - Sonnet 5 needs CHAT; CLI_AGENT returns HTTP 500 for this family.
  // Guarded so the mocked SDK in tests (which has no buildPayload) is not
  // affected. At most one of these applies per model.
  const forcedMode = cliGated
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

  // Flatten tool-call history for CLI-gated models (butler_a) that route to
  // Vertex AI Gemini thinking backends. Augment strips thought signatures
  // server-side, so we convert all structured tool turns to plain text to
  // avoid signature-validation errors on replayed history.
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