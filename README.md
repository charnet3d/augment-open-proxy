# augment-open-proxy

OpenAI- and Anthropic-compatible HTTP proxy that routes requests through the Augment SDK. Use any OpenAI- or Anthropic-compatible client (Claude Code, Cursor, Continue, etc.) with Augment LLMs.

## Prerequisites

- **Augment account** — authenticate via the official CLI:
  ```bash
  auggie login
  ```
  This stores your OAuth session in `~/.augment/session.json`, which the proxy picks up automatically. Alternatively, set `AUGMENT_API_TOKEN` + `AUGMENT_API_URL` (see [Configuration](#configuration)).

  > Don't have `auggie` installed? `npm install -g @augmentcode/auggie` — or, if you're using the Docker image below, the CLI is already inside and you can `docker exec` it. See [Token-based auth without auggie](#token-based-auth-without-auggie) at the bottom of this README.

## Installation

Pick the option that fits your setup. All four accept the same configuration (see [Configuration](#configuration)).

### Option 1 — npm / npx (no install, runs anywhere with Node ≥ 20)

```bash
# One-off run
npx augment-open-proxy

# Or install globally
npm install -g augment-open-proxy
augment-open-proxy
```

`npx` always fetches the latest published version. Pin a specific version with `npx augment-open-proxy@1.0.1` if you want reproducibility.

### Option 2 — Docker image (no Node required)

Pre-built multi-arch images (linux/amd64, linux/arm64) are published to **GitHub Container Registry** on every release.

```bash
# Session-based auth — mount your auggie login session
docker run -d \
  --name augment-open-proxy \
  -p 7888:7888 \
  -e AOP_HOST=0.0.0.0 \
  -v "$HOME/.augment:/root/.augment:ro" \
  ghcr.io/charnet3d/augment-open-proxy:latest
```

Pin a version with `ghcr.io/charnet3d/augment-open-proxy:1.0.1`. Tags: `latest`, full semver (`1.0.1`), and major.minor (`1.0`).

### Option 3 — Standalone binary (no Node, no Docker)

Self-contained executables for **linux-x64**, **linux-arm64**, **darwin-arm64**, and **win-x64** are attached to every [GitHub Release](https://github.com/charnet3d/augment-open-proxy/releases).

```bash
# Linux/macOS — download, extract, run
curl -L https://github.com/charnet3d/augment-open-proxy/releases/latest/download/augment-open-proxy-linux-x64.tar.gz | tar -xz
./augment-open-proxy-linux-x64
```

```powershell
# Windows
Invoke-WebRequest -Uri https://github.com/charnet3d/augment-open-proxy/releases/latest/download/augment-open-proxy-win-x64.zip -OutFile aop.zip
Expand-Archive aop.zip
.\aop\augment-open-proxy-win-x64.exe
```

Binaries are built with [Node SEA](https://nodejs.org/api/single-executable-applications.html) — Node and the proxy are baked into one ~100 MB file. No `node_modules`, no PATH setup.

### Option 4 — From source (contributors / unreleased changes)

```bash
git clone https://github.com/charnet3d/augment-open-proxy.git
cd augment-open-proxy
npm install
npm start          # runs src/index.ts via tsx
# or
npm run build      # bundle to dist/
node dist/index.js
```

Requires Node 22+. See [Development](#development) for the full contributor workflow.

## Configuration

Copy `.env.example` to `.env` and set your values:

```env
AOP_PORT=7888
AOP_HOST=localhost
AUGMENT_API_TOKEN=
AUGMENT_API_URL=
```

| Variable | Required | Description |
|---|---|---|
| `AOP_PORT` | No | Server port (default: `7888`) |
| `AOP_HOST` | No | Bind address (default: `localhost`) |
| `AUGMENT_API_TOKEN` | No | API token for authentication. Falls back to `auggie login` session if omitted. |
| `AUGMENT_API_URL` | No | Tenant-specific API URL. Required when `AUGMENT_API_TOKEN` is set. |
| `AOP_DISABLE_EFFORT_MODELS` | No | Comma- or whitespace-separated list of base model IDs (or CLI short names) whose effort variants should be hidden from `/v1/models` and not used for `reasoning_effort` rewriting. See [Reasoning effort](API.md#reasoning-effort). |
| `AOP_LOGGING` | No | Per-request logging verbosity. `none` (silent), `info` (one line per request: method, path, status, durationMs, model, requestId, usage — default), or `body` (`info` plus full request and assembled response payloads). See [Structured logging](API.md#structured-logging). |
| `AOP_LOG_FORMAT` | No | Output shape for log records: `text` (human-readable single line, default) or `json` (single-line JSON per record). See [Structured logging](API.md#structured-logging). |
| `AOP_HEADERS_TIMEOUT_MS` | No | Milliseconds to wait for the first response byte from the upstream (default: `1800000` = 30 min). Node's default 5-minute limit trips long thinking calls; this raises it. Set to `0` to disable. |
| `AOP_BODY_TIMEOUT_MS` | No | Milliseconds allowed between consecutive body chunks from the upstream (default: `1800000` = 30 min). Set to `0` to disable. |
| `AOP_CONNECT_TIMEOUT_MS` | No | Milliseconds for the TCP connect handshake to the upstream (default: `30000` = 30 s). Set to `0` to disable. |

## Usage

Once the proxy is running (via any of the four options above) it serves on `http://localhost:7888` by default.

### Token-based auth without auggie

Skip `auggie login` entirely by exporting your tenant credentials before starting the proxy. This is the standard mode for CI, containers in CI, and any headless box:

```bash
export AUGMENT_API_TOKEN=<token>
export AUGMENT_API_URL=<url>
npx augment-open-proxy            # or docker run -e AUGMENT_API_TOKEN ... ghcr.io/...
```

For Docker, pass them as `-e` flags:

```bash
docker run -d -p 7888:7888 \
  -e AOP_HOST=0.0.0.0 \
  -e AUGMENT_API_TOKEN=<token> \
  -e AUGMENT_API_URL=<url> \
  ghcr.io/charnet3d/augment-open-proxy:latest
```

### Docker Compose (build from source)

If you cloned the repo (Option 4), a `docker-compose.yml` is included for one-command builds:

```bash
auggie login            # session-based auth
docker compose up -d --build
```

Or token-based:

```bash
AUGMENT_API_TOKEN=<token> AUGMENT_API_URL=<url> docker compose up -d --build
```

Override the port with `AOP_PORT=<n> docker compose up`. Tail logs with `docker compose logs -f`, stop with `docker compose down`.

### Container management

```bash
docker logs -f augment-open-proxy   # tail logs
docker stop augment-open-proxy      # stop
docker rm augment-open-proxy        # remove container
```

### curl examples

List available models:
```bash
curl http://localhost:7888/v1/models
```

Send a chat completion:
```bash
curl http://localhost:7888/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Use with coding agents

Point your agent's OpenAI base URL to the proxy:

```bash
OPENAI_BASE_URL=http://localhost:7888/v1
```

For Anthropic-native clients (Claude Code, Anthropic SDK), point them at the
Anthropic-compatible endpoint instead:

```bash
ANTHROPIC_BASE_URL=http://localhost:7888 claude
```

## API Endpoints

See **[API.md](API.md)** for the full endpoint reference, including:

- `GET /v1/models` — list available models
- `POST /v1/chat/completions` — OpenAI Chat Completions (streaming + tool calling)
- `POST /v1/responses` — OpenAI Responses API (streaming + tool calling + reasoning)
- `POST /v1/messages` — Anthropic Messages API (Claude Code, `@anthropic-ai/sdk`)
- `POST /v1/messages/count_tokens` — token-count estimation
- [Reasoning effort](API.md#reasoning-effort) — suffixed model IDs and `reasoning_effort` rewriting
- [Image input](API.md#image-input-experimental) — `image_url` content parts (experimental)
- [Structured logging](API.md#structured-logging) — `AOP_LOGGING` / `AOP_LOG_FORMAT`

## Known Limitations

- **Token counting** — Augment does not expose exact token counts.
- **Image input is experimental** — see above; relies on a runtime SDK patch and may break on upstream changes.
- **No audio input** — audio content parts are not supported.
- **Rate limits** — subject to your Augment account tier.

## Note about some prompts

Certain user prompts cause `claude-sonnet-4-6` to hang at the Augment
backend: the upstream `chat-stream` endpoint accepts the connection,
returns `200 OK` headers, then writes zero body bytes. Other prompts on
the same proxy, credentials, and model continue to succeed, so this is a
prompt-content issue at the upstream — not the proxy, the account, or the
request size.

Reproducer: Originally [`scripts/prompt-causing-issue.md`](scripts/prompt-causing-issue.md)
 a 21-line "3d Rubik's in an HTML file" request. But the issue
was reproduced even with a one sentence prompt: "build a 3d rubiks cube in an html file". It fails
identically through:

- Claude Code (full system prompt + 50+ tools, ~125 KB body)
- pi-agent (minimal system prompt, no tools, ~1 KB body)
- OpenWebUI (no agent wrapper at all)
- raw `curl` against `/v1/messages` and `/v1/chat/completions`
- **More importantly**: The official Augment VS Code extension, not using this proxy.

How it surfaces:

- After roughly 5–6 minutes the **backend** ends the stream early —
  it sends a terminal frame with no content and `input_tokens = 0`
  (no usage at all). This is not a client- or proxy-side timeout.

Workarounds:

- Reword the prompt; some simpler variations worked but no general pattern
  emerged.
- Switch to `claude-sonnet-4-5` or `claude-sonnet-4` for the same
  prompt — both return normally.

If you can reproduce against your own tenant, share the failing `req=` id
from the proxy log with Augment support — they have the upstream traces
that the proxy does not.

## Troubleshooting

| Problem | Fix |
|---|---|
| `401 Unauthorized` or auth errors | Run `auggie login` and re-authenticate, or set `AUGMENT_API_TOKEN` and `AUGMENT_API_URL` in `.env`. |
| `model not found` | Check the model name — use `claude-sonnet-4-5`, `claude-haiku-4-5`, `claude-opus-4-1`, etc. See your Augment dashboard for available models. |
| Proxy won't start | Verify `AOP_PORT` is not already in use: `lsof -i :7888` (Linux/macOS) or `netstat -ano \| findstr :7888` (Windows). |
| Streaming hangs | Ensure `stream: true` is set in the request body and the client supports SSE. |
| SDK connection errors | Check your network connection and that `~/.augment/session.json` exists and is not expired. Run `auggie login` to refresh. |

## Development

### Build

| Command | Output |
|---|---|
| `npm run build` | Bundles `src/` to `dist/index.js` via esbuild. Used by the published npm package and by the Docker image. |
| `npm run build:sea -- <target>` | Builds a Node SEA binary for the current host. `target` must match the host arch (`linux-x64`, `linux-arm64`, `darwin-arm64`, `win-x64`). SEA does not cross-compile. |
| `npm run typecheck` | Strict TypeScript check without emitting files (the runtime builds skip type-checking for speed). |

### Releasing

Releases are fully automated by [`.github/workflows/release.yml`](.github/workflows/release.yml). To cut a new version:

1. Bump the version: `npm version <major|minor|patch> --no-git-tag-version`
2. Commit the change.
3. Push a matching tag: `git tag v$(node -p "require('./package.json').version") && git push origin --tags`

The workflow validates the tag, runs tests, then publishes binaries to GitHub Releases, the Docker image to `ghcr.io`, and the npm package via OIDC trusted publishing. A manual `workflow_dispatch` trigger is also available in the Actions tab for re-runs.

### Tests

| Command | Scope |
|---|---|
| `npm test` | Unit + integration tests. No network. Safe to run in CI without secrets. |
| `npm run test:watch` | Unit + integration tests in watch mode. |
| `npm run test:coverage` | Unit + integration tests with v8 coverage report. |
| `npm run test:e2e` | End-to-end tests against the real Augment API. Requires `auggie login` or `AUGMENT_API_TOKEN` + `AUGMENT_API_URL` in `.env`; the suite self-skips when no credentials are detected. |

The e2e suite is excluded from the default run via `vitest.config.ts` and lives under its own config (`vitest.e2e.config.ts`) so unit-test runs stay hermetic and fast.

## Project Structure

```
src/
  index.ts          # Entry point — starts the Hono server
  routes/           # OpenAI-compatible route handlers
  services/         # Augment SDK client + experimental image patch
  types/            # Shared TypeScript types
  utils/            # Request/response transformers
  __tests__/        # Vitest unit, integration, and e2e suites
```
