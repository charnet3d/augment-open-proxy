import { execFile } from "node:child_process";
import type { ModelsListResponse, ReasoningEffort } from "../types/openai";

/**
 * Augment effort levels in ascending order. The CLI advertises a model-specific
 * subset (e.g. opus4.7 → ["Medium","High","xHigh"], opus4.6 → ["Low","Medium",
 * "High","Max"]). The backend selects the depth via a model ID suffix
 * (`<base>-<level>`, lowercased), confirmed by probing the live API.
 */
const ORDERED_EFFORT_LEVELS = ["low", "medium", "high", "max", "xhigh"] as const;

/**
 * Convert an Augment CLI short name to the canonical backend model ID.
 *
 * Rules (confirmed by probing the backend without CHAT-mode override):
 *   Claude  haiku/sonnet/opus + version + optional suffix
 *                                         →  claude-{family}-{version, dots→dashes}{-suffix}
 *                                            e.g. opus4.6-500k → claude-opus-4-6-500k
 *   GPT     gpt{version} + optional suffix →  gpt-{version, dots→dashes}{-suffix}
 *                                            e.g. gpt5.6-sol → gpt-5-6-sol
 *   Grok    grok{version} + optional suffix →  grok-{version, dots→dashes}{-suffix}
 *                                            e.g. grok4.5 → grok-4-5
 *   Gemini  gemini-{X.Y}-{rest}           →  gemini-{X-Y}-{rest}  (dots→dashes)
 *   Others  (e.g. code-review)            →  pass through, dots→dashes
 */
export function expandShortName(shortName: string): string {
  // Claude: haiku/sonnet/opus + numeric version + optional dash-suffix (e.g. -500k)
  const claudeMatch = shortName.match(/^(haiku|sonnet|opus)(\d[\d.]*)(-[a-z0-9]+)?$/i);
  if (claudeMatch) {
    const family = claudeMatch[1].toLowerCase();
    const version = claudeMatch[2].replace(/\./g, "-");
    const suffix = claudeMatch[3] ?? "";
    return `claude-${family}-${version}${suffix}`;
  }

  // GPT/Grok: {family}{version} + optional dash-suffix (e.g. -mini, -sol, -luna, -terra)
  const gptGrokMatch = shortName.match(/^(gpt|grok)(\d[\d.]*)(-[a-z0-9]+)?$/i);
  if (gptGrokMatch) {
    const family = gptGrokMatch[1].toLowerCase();
    const version = gptGrokMatch[2].replace(/\./g, "-");
    const suffix = gptGrokMatch[3] ?? "";
    return `${family}-${version}${suffix}`;
  }

  // All others (gemini-X.Y-..., code-review, …): replace dots with dashes
  return shortName.replace(/\./g, "-");
}

/**
 * Fallback model list — used when `auggie models list --json` fails or returns
 * bad output. These are already in canonical (expanded) form.
 *
 * Mirrors a live `GET /v1/models` snapshot (effort-level variants included)
 * with the model IDs from the `.env.example` `AOP_DISABLE_EFFORT_MODELS`
 * sample already excluded, since the fallback path can't apply that filter
 * itself (it skips `fetchModelEntries`'s per-entry disable logic). Re-sync
 * periodically as Augment adds/retires models or effort tiers.
 */
export const FALLBACK_MODEL_IDS: readonly string[] = [
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-6-500k",
  "claude-sonnet-5-high",
  "claude-sonnet-5-high-low",
  "claude-sonnet-5-high-medium",
  "claude-sonnet-5-high-high",
  "claude-sonnet-5-high-xhigh",
  "claude-sonnet-5-high-max",
  "claude-sonnet-5-500k",
  "claude-sonnet-5-500k-low",
  "claude-sonnet-5-500k-medium",
  "claude-sonnet-5-500k-high",
  "claude-sonnet-5-500k-xhigh",
  "claude-sonnet-5-500k-max",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-6-500k",
  "claude-opus-4-7",
  "claude-opus-4-7-medium",
  "claude-opus-4-7-high",
  "claude-opus-4-7-xhigh",
  "claude-opus-4-7-500k",
  "claude-opus-4-8",
  "claude-opus-4-8-medium",
  "claude-opus-4-8-high",
  "claude-opus-4-8-xhigh",
  "claude-opus-5",
  "claude-opus-5-medium",
  "claude-opus-5-high",
  "claude-opus-5-xhigh",
  "gemini-3-1-pro-preview",
  "gpt-5",
  "gpt-5-1",
  "gpt-5-2",
  "gpt-5-4",
  "gpt-5-4-mini",
  "gpt-5-5",
  "gpt-5-6-luna",
  "gpt-5-6-sol",
  "gpt-5-6-terra",
  "grok-4-5",
  "code-review",
  "prism-a",
];

/**
 * Per-base-model entry: canonical base ID plus the lowercase effort suffixes
 * advertised by the CLI for that model. Suffixes are kept in CLI order so the
 * generated variant list is stable.
 */
export interface ModelEntry {
  baseId: string;
  effortLevels: string[];
}

let cachedEntries: ModelEntry[] | null = null;
let cachedModelIds: string[] | null = null;
// True when the cached result came from the hardcoded fallback rather than a
// live `auggie` call. The cache is intentionally not locked in on fallback so
// the next request can retry the CLI (e.g. after a Docker container has fully
// mounted the session volume and the network is available).
let cacheIsFallback = false;
// Timestamp (ms) of the last time we fell back to the hardcoded list. Used to
// throttle retries: we attempt auggie at most once per RETRY_COOLDOWN_MS so a
// persistently-broken CLI doesn't add a 10-second timeout penalty to every
// request.
let lastFallbackAt = 0;
export const RETRY_COOLDOWN_MS = 30_000; // 30 seconds between retry attempts

function runAuggieModelsList(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "auggie",
      ["models", "list", "--json"],
      // shell:true is required on Windows so npm-installed .cmd wrappers are found.
      { timeout: 20_000, shell: true },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      }
    );
  });
}

/**
 * Expand a single CLI entry into the flat list of canonical IDs the registry
 * exposes: the base ID, followed by one suffixed variant per advertised effort
 * level (lowercased, CLI order preserved).
 */
export function expandModelEntry(entry: ModelEntry): string[] {
  const ids = [entry.baseId];
  for (const level of entry.effortLevels) {
    ids.push(`${entry.baseId}-${level}`);
  }
  return ids;
}

/**
 * Parse `AOP_DISABLE_EFFORT_MODELS` into normalized model IDs.
 *
 * A bare base ID disables all advertised effort levels for that model, while
 * a suffixed ID (e.g. `claude-opus-4-7-low`) disables only that level. Accepts
 * either short names (`opus4.6`, `opus4.7-low`) or canonical IDs; both are
 * normalized through `expandShortName`. Entries are comma- or whitespace-
 * separated and case-sensitive after normalization.
 */
export function getEffortDisabledBaseIds(): Set<string> {
  const raw = process.env.AOP_DISABLE_EFFORT_MODELS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(expandShortName)
  );
}

async function fetchModelEntries(): Promise<{ entries: ModelEntry[]; isFallback: boolean }> {
  const disabled = getEffortDisabledBaseIds();
  try {
    const stdout = await runAuggieModelsList();
    const data = JSON.parse(stdout.trim()) as {
      registryAvailable?: boolean;
      models?: Array<{ shortName?: string; effortLevels?: unknown }>;
    };
    if (Array.isArray(data.models)) {
      const entries: ModelEntry[] = [];
      for (const m of data.models) {
        if (typeof m.shortName !== "string" || m.shortName.length === 0) continue;
        const baseId = expandShortName(m.shortName);
        const advertised = Array.isArray(m.effortLevels)
          ? m.effortLevels
              .filter((l): l is string => typeof l === "string" && l.length > 0)
              .map((l) => l.toLowerCase())
          : [];
        const disabledLevels = disabled.has(baseId)
          ? advertised
          : advertised.filter((level) => disabled.has(`${baseId}-${level}`));
        const effortLevels = advertised.filter(
          (level) => !disabled.has(baseId) && !disabled.has(`${baseId}-${level}`)
        );
        if (disabledLevels.length > 0) {
          console.debug(
            `[modelRegistry] effort levels disabled for ${baseId} via AOP_DISABLE_EFFORT_MODELS (disabled: ${disabledLevels.join(", ")})`
          );
        }
        entries.push({ baseId, effortLevels });
      }
      if (entries.length > 0) return { entries, isFallback: false };
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[modelRegistry] auggie models list failed (${reason}); using fallback model list`);
  }
  console.debug(`[modelRegistry] fallback model IDs: ${FALLBACK_MODEL_IDS.join(", ")}`);
  return {
    entries: FALLBACK_MODEL_IDS.map((baseId) => ({ baseId, effortLevels: [] })),
    isFallback: true,
  };
}

async function getModelEntries(): Promise<ModelEntry[]> {
  // Use the cache when it holds a real (non-fallback) result.
  if (cachedEntries !== null && !cacheIsFallback) {
    return cachedEntries;
  }
  // When the cache is a fallback, only re-try auggie after the cooldown has
  // elapsed. This prevents a persistently-broken CLI from adding a 10-second
  // timeout penalty to every single request.
  if (cachedEntries !== null && Date.now() - lastFallbackAt < RETRY_COOLDOWN_MS) {
    return cachedEntries;
  }
  const { entries, isFallback } = await fetchModelEntries();
  cachedEntries = entries;
  cacheIsFallback = isFallback;
  // Pre-derive and lock in the flat ID list only when the result is real.
  // On fallback, leave cachedModelIds null so it is also retried next time.
  if (isFallback) {
    lastFallbackAt = Date.now();
    cachedModelIds = null;
  } else {
    cachedModelIds = entries.flatMap(expandModelEntry);
  }
  return cachedEntries;
}

export async function getModelIds(): Promise<string[]> {
  if (cachedModelIds !== null) {
    return cachedModelIds;
  }
  const entries = await getModelEntries();
  if (!cacheIsFallback) {
    // Should already be set by getModelEntries, but be defensive.
    cachedModelIds ??= entries.flatMap(expandModelEntry);
    return cachedModelIds;
  }
  // Still on fallback — compute on the fly without caching.
  return entries.flatMap(expandModelEntry);
}

export async function listModels(): Promise<ModelsListResponse> {
  const ids = await getModelIds();
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model" as const,
      created,
      owned_by: "augment",
    })),
  };
}

export async function isModelAvailable(modelId: string): Promise<boolean> {
  const ids = await getModelIds();
  return ids.includes(modelId);
}

/**
 * Anthropic publishes dated snapshot IDs (e.g. `claude-haiku-4-5-20251001`)
 * that clients like Claude Code hard-code. The Augment backend only knows the
 * undated canonical form (`claude-haiku-4-5`). Strip the trailing
 * `-YYYYMMDD` suffix when the stripped form is in the registry so dated IDs
 * route to the matching canonical model. Returns the original ID otherwise.
 */
const ANTHROPIC_DATE_SUFFIX = /-[0-9]{8}$/;

export async function normalizeModelId(modelId: string): Promise<string> {
  if (!modelId) return modelId;
  const ids = await getModelIds();
  if (ids.includes(modelId)) return modelId;

  // Try expanding if it's a short name (e.g. prism-a -> butler_a, haiku4.5 -> claude-haiku-4-5)
  const expanded = expandShortName(modelId);
  if (expanded !== modelId && ids.includes(expanded)) return expanded;

  const stripped = modelId.replace(ANTHROPIC_DATE_SUFFIX, "");
  if (stripped !== modelId && ids.includes(stripped)) return stripped;
  return modelId;
}

/**
 * Map an OpenAI `reasoning_effort` value to the closest Augment effort level
 * the model actually advertises, then return the suffixed model ID. Returns
 * `undefined` when no rewrite should happen, i.e. when:
 *   - the model is not a known base in the registry, or
 *   - the model has no advertised effort levels, or
 *   - the requested effort is "none" (caller should use the base model), or
 *   - no reasonable level mapping exists.
 *
 * Mapping rules:
 *   - "none" → undefined (forward to the base model, no depth suffix).
 *   - "minimal" is treated as the lowest level (Augment has no minimal tier).
 *   - "xhigh" maps directly to Augment's xhigh tier when advertised.
 *   - Exact (case-insensitive) match wins.
 *   - Otherwise snap to the closest level by index in ORDERED_EFFORT_LEVELS.
 */
export async function resolveEffortModelId(
  modelId: string,
  effort: ReasoningEffort
): Promise<string | undefined> {
  if (effort === "none") return undefined;
  const requested = effort === "minimal" ? "low" : effort;
  const disabled = getEffortDisabledBaseIds();
  if (disabled.has(modelId) || disabled.has(`${modelId}-${requested}`)) {
    return undefined;
  }

  const entries = await getModelEntries();
  const entry = entries.find((e) => e.baseId === modelId);
  if (!entry || entry.effortLevels.length === 0) return undefined;

  if (entry.effortLevels.includes(requested)) {
    return `${entry.baseId}-${requested}`;
  }

  const targetIdx = ORDERED_EFFORT_LEVELS.indexOf(
    requested as (typeof ORDERED_EFFORT_LEVELS)[number]
  );
  if (targetIdx === -1) return undefined;

  let best: string | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const level of entry.effortLevels) {
    const idx = ORDERED_EFFORT_LEVELS.indexOf(
      level as (typeof ORDERED_EFFORT_LEVELS)[number]
    );
    if (idx === -1) continue;
    const dist = Math.abs(idx - targetIdx);
    if (dist < bestDist) {
      bestDist = dist;
      best = level;
    }
  }
  return best ? `${entry.baseId}-${best}` : undefined;
}
