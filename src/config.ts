import { config } from "dotenv";

// Load .env file at module evaluation time so environment variables
// are available to all modules that import this config.
// This module is the entry point for environment setup.
config({ quiet: true });

export const PORT = parseInt(process.env.AOP_PORT || "7888", 10);
export const HOST = process.env.AOP_HOST || "localhost";

// Structured-logging verbosity. `AOP_LOGGING` (alias `AOP_LOG_LEVEL`) accepts:
//   - "none" / "off" / "silent" → no per-request log lines
//   - "info"                    → one JSON line per request with method, path,
//                                 status, durationMs, model, usage (default)
//   - "body"                    → "info" plus full request and response bodies
//                                 (stream responses are summarised after close)
export type LogLevel = "none" | "info" | "body";

function parseLogLevel(raw: string | undefined): LogLevel {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "info") return "info";
  if (v === "none" || v === "off" || v === "silent") return "none";
  if (v === "body" || v === "debug" || v === "verbose") return "body";
  return "info";
}

export const LOG_LEVEL: LogLevel = parseLogLevel(
  process.env.AOP_LOGGING ?? process.env.AOP_LOG_LEVEL
);

// Output shape for log records. `text` (default) emits a human-readable
// single line — best for local development and tailing. `json` emits one
// JSON object per line — best for machine ingestion (jq, Loki, Vector).
export type LogFormat = "json" | "text";

function parseLogFormat(raw: string | undefined): LogFormat {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "json") return "json";
  return "text";
}

export const LOG_FORMAT: LogFormat = parseLogFormat(process.env.AOP_LOG_FORMAT);
