# Multi-stage production Dockerfile for fable-agentic-whatsapp
# Optimized for low-spec VPS environments (1-2 GB RAM, 1-2 vCPU)

# --- Stage 1: Build Web Cockpit UI ---
FROM oven/bun:1.2 AS ui-builder
WORKDIR /app/ui

COPY ui/package.json ./
RUN bun install --frozen-lockfile || bun install

COPY ui/ ./
RUN bun run build

# --- Stage 2: Production Runtime ---
FROM oven/bun:1.2-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

# Install dependencies
COPY package.json patch-baileys.mjs ./
RUN bun install --production --frozen-lockfile || bun install --production
RUN bun patch-baileys.mjs

# Copy source code and prebuilt UI distribution
COPY src/ ./src/
COPY --from=ui-builder /app/ui/dist ./ui/dist

# Ensure data directory exists with write permissions and assign ownership to bun user
RUN mkdir -p /app/data && chown -R bun:bun /app

VOLUME ["/app/data"]

EXPOSE 3000

# Hermetic healthcheck using Bun's native fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER bun

CMD ["bun", "run", "src/index.ts"]
