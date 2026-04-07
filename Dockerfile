# Stage 1 — Builder: compile native addons (better-sqlite3)
FROM node:24-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Stage 2 — Runtime
FROM node:24-alpine

# Runtime dependencies: openssl for TLS cert ops, git for allowed remote
# commands, jq for the Docker SessionStart drift-detection hook (and the
# /sync skill on hosts that don't have host-side jq) — both invoke
# `docker exec icc jq ...` to read the in-container applied-config manifest.
RUN apk add --no-cache openssl git jq

# Create non-root user
RUN addgroup -S icc && adduser -S icc -G icc -h /home/icc

WORKDIR /app
COPY --from=builder /app .

# Create .icc directory owned by icc user
RUN mkdir -p /home/icc/.icc && chown -R icc:icc /home/icc/.icc

EXPOSE 3179 3180 4179

ENV ICC_LOCALHOST_HTTP_PORT=3178

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s CMD ["node", "docker/healthcheck.ts"]

USER icc

ENTRYPOINT ["node", "docker/entrypoint.ts"]
