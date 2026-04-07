# Docker CI Auto-Publish — Design

**Date:** 2026-04-07
**Status:** Approved, ready for implementation plan
**Sub-project:** A of 4 (Docker update flow improvements)
**Related:** rpi1 proposal item #1 in thread `9f20c338`

## Problem

Updating a Docker-deployed ICC peer (currently rpi1, the only one) requires:

```bash
git pull
docker compose build       # ~30s arm64 native build, can fail on better-sqlite3
docker compose up -d
```

Three steps with three failure modes:
1. **Forgot `git pull`** — silently builds stale code.
2. **Local build cost** — every Docker host rebuilds the same image; arm64 builds are slow on Pi-class hardware.
3. **Repo clone required on Docker hosts** — defeats the "container is the unit of deployment" principle.

The Docker host shouldn't need a checkout at all. The container image is the deliverable.

## Goal

After this work, the rpi1 update flow becomes:

```bash
docker compose pull
docker compose up -d
```

`sitruss/icc:latest` on Docker Hub is the canonical source. CI publishes a new multi-arch manifest on every merge to `main`, and on every `v*` git tag.

## Non-goals

- Image signing (cosign) — defer
- SBOM generation — defer
- GHCR mirror — defer; Docker Hub is canonical, mirror only if reliability becomes an issue
- Auto-pulling on Docker hosts after publish — covered by sub-project D (`/upgrade` skill)
- Notifying ICC peers when a new image is available — out of scope

## Design

### Workflow file

**Path:** `.github/workflows/docker-publish.yml`

### Triggers

| Trigger | Tags published |
|---|---|
| `push` to `main` | `sitruss/icc:latest`, `sitruss/icc:<short-sha>` |
| `push` of tag `v*` (e.g. `v1.0.0`) | `sitruss/icc:<version>` (e.g. `1.0.0`, `1.0`, `1`), `sitruss/icc:latest` |

The two trigger paths share one workflow. `docker/metadata-action@v5` handles tag derivation from refs:

- `type=raw,value=latest,enable={{is_default_branch}}`
- `type=sha,format=short,prefix=` (no `sha-` prefix)
- `type=semver,pattern={{version}}`
- `type=semver,pattern={{major}}.{{minor}}`
- `type=semver,pattern={{major}}`

### Build matrix — native parallel arch builds

Two parallel build jobs, one per platform, each on a native runner. No QEMU emulation.

| Job | `runs-on` | Platform |
|---|---|---|
| `build-amd64` | `ubuntu-24.04` | `linux/amd64` |
| `build-arm64` | `ubuntu-24.04-arm` | `linux/arm64` |

**Why native:** QEMU emulation occasionally segfaults on `npm install` for native modules. ICC depends on `better-sqlite3` (native addon), so native builds avoid a real flakiness class. GitHub-hosted `ubuntu-24.04-arm` is free for public repos.

Each build job:

1. Checks out the repo
2. Logs in to Docker Hub via `docker/login-action@v3` using `DOCKER_USERNAME` + `DOCKER_PASSWORD` secrets
3. Builds the image with `docker/build-push-action@v6`, pushing to a **digest-only** ref (no human-readable tag yet) — `outputs: type=image,name=sitruss/icc,push-by-digest=true,name-canonical=true`
4. Exports the resulting digest as a job output

Layer cache: `cache-from: type=gha` + `cache-to: type=gha,mode=max`. Per-platform cache scopes (`scope: build-${{ matrix.platform }}`).

### Manifest merge job

A third job, `merge`, runs after both `build-amd64` and `build-arm64` complete. It:

1. Pulls the digest outputs from both build jobs
2. Uses `docker buildx imagetools create` to compose a multi-arch manifest under each tag derived by `metadata-action`
3. Verifies the manifest with `docker buildx imagetools inspect`

The multi-arch tags (`:latest`, `:<short-sha>`, `:<semver>`) only appear on Docker Hub after the merge job succeeds. Build failures on either platform abort before any human-readable tag is created — no half-published manifests.

### Secrets prerequisite

Before the first workflow run, the repo owner must:

1. Create a Docker Hub Personal Access Token (PAT) with `Read, Write, Delete` scope on the `sitruss/icc` repository
2. Add two GitHub repository secrets:
   - `DOCKER_USERNAME` — Docker Hub username (`parmesanparty`)
   - `DOCKER_PASSWORD` — the PAT value

This is a one-time manual step. The implementation plan must call it out as a checklist item.

### No code changes elsewhere

`docker-compose.yml` already references `image: sitruss/icc:latest`. The workflow's job is purely to make sure that tag points at fresh bits.

## Verification

1. **First successful run on `main`:**
   - Both `build-amd64` and `build-arm64` jobs complete
   - `merge` job creates multi-arch manifest
   - `docker manifest inspect sitruss/icc:latest` from any host shows both `linux/amd64` and `linux/arm64` entries with matching digests
2. **End-to-end on rpi1:**
   - `docker compose pull` fetches the new manifest
   - `docker compose up -d` recreates the container with the new image
   - Container reports healthy via the existing `healthcheck` block in `docker-compose.yml`
   - ICC server registers and accepts inbound peer traffic
3. **Tag-driven path:**
   - Push a throwaway tag like `v0.0.1-test` and confirm semver tags appear on Docker Hub, then delete the tag and `latest` rolls back appropriately on the next `main` push

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Docker Hub PAT rotation forgotten → workflow fails silently for users | Document expiry date in repo `SECURITY.md` or similar; PAT auth failures appear in CI logs immediately |
| `ubuntu-24.04-arm` runner pool experiences capacity issues | Build jobs are independent; amd64 still publishes. Rare per GitHub status history. Acceptable. |
| `gha` cache exceeds 10 GB GitHub limit | `mode=max` retention is bounded; GitHub auto-prunes oldest entries. No action needed. |
| `better-sqlite3` ABI mismatch between build host and container Node version | Already handled by existing `Dockerfile` (uses same Node base image for build and runtime); CI build matches local build |

## Open questions

None. All design decisions resolved during brainstorming session 2026-04-07.
