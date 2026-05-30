# syntax=docker/dockerfile:1
# ── deps stage: install ALL dependencies (needed for the build) ────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# ── build stage: compile TypeScript → dist/ with esbuild ───────────────────
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
RUN npm run build

# ── prod-deps stage: install ONLY runtime dependencies for the final image ─
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── runtime stage: minimal image with node + dist + prod deps + auggie CLI ─
FROM node:22-alpine AS runtime
WORKDIR /app

# Install the Augment CLI so session-based auth (auggie login) works inside
# the container when the ~/.augment directory is mounted.
RUN npm install -g @augmentcode/auggie

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# OCI labels — GHCR uses org.opencontainers.image.source to auto-link the
# package to the GitHub repository on the package page.
LABEL org.opencontainers.image.source="https://github.com/charnet3d/augment-open-proxy"
LABEL org.opencontainers.image.description="HTTP proxy that lets OpenAI- and Anthropic-compatible clients talk to the Augment backend."
LABEL org.opencontainers.image.licenses="MIT"

EXPOSE 7888

CMD ["node", "dist/index.js"]
