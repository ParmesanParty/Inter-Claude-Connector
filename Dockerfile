# Stage 1 — Builder: compile native addons (better-sqlite3)
FROM node:24-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Stage 2 — Runtime
FROM node:24-alpine

# Runtime dependencies: openssl for TLS cert ops, git for allowed remote commands
RUN apk add --no-cache openssl git

# Create non-root user
RUN addgroup -S icc && adduser -S icc -G icc -h /home/icc

WORKDIR /app
COPY --from=builder /app .

# Create .icc directory owned by icc user
RUN mkdir -p /home/icc/.icc && chown -R icc:icc /home/icc/.icc

EXPOSE 3179 3180 4179

USER icc

ENTRYPOINT ["node", "docker/entrypoint.ts"]
