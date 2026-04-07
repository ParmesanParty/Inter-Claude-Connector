# Sub-project A: Docker CI Auto-Publish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions workflow that publishes `parmesanparty/icc` as a multi-arch Docker image (`linux/amd64` + `linux/arm64`) on every merge to `main` and on every `v*` git tag, so that rpi1 (and any future Docker peer) can update via `docker compose pull && docker compose up -d` with no local build step.

**Architecture:** Two parallel build jobs on GitHub-hosted native runners (`ubuntu-24.04` + `ubuntu-24.04-arm`) produce digest-only single-arch images via `docker/build-push-action`. A third `merge` job composes the digests into a multi-arch manifest under the human-readable tags derived by `docker/metadata-action`. Layer caching via `type=gha`. Authenticates to Docker Hub using `DOCKER_USERNAME` + `DOCKER_PASSWORD` repo secrets.

**Tech Stack:** GitHub Actions, `docker/login-action@v3`, `docker/metadata-action@v5`, `docker/build-push-action@v6`, `docker/setup-buildx-action@v3`.

**Related spec:** `docs/superpowers/specs/2026-04-07-docker-ci-publish-design.md`

---

## Prerequisites

**Before the first workflow run succeeds, the user must:**

1. Create a Docker Hub Personal Access Token (PAT) with `Read, Write, Delete` scope on the `parmesanparty/icc` repository (https://hub.docker.com/settings/security)
2. Add two GitHub repository secrets (at https://github.com/ParmesanParty/Inter-Claude-Connector/settings/secrets/actions):
   - `DOCKER_USERNAME` — `parmesanparty`
   - `DOCKER_PASSWORD` — the PAT value

These are one-time manual steps. The implementation agent must pause and prompt the user to confirm before running the workflow end-to-end in Task 3.

---

## File Structure

| Path | Responsibility | Action |
|---|---|---|
| `.github/workflows/docker-publish.yml` | Multi-arch build + publish workflow | Create |

No code changes elsewhere. `docker-compose.yml` already references `image: parmesanparty/icc:latest`.

---

## Task 1: Create the workflow file with build matrix and manifest merge

**Files:**
- Create: `.github/workflows/docker-publish.yml`

- [ ] **Step 1: Create `.github/workflows/` directory if it does not exist**

Run:
```bash
mkdir -p .github/workflows
ls -la .github/workflows/
```

Expected: directory exists (empty or containing unrelated workflows).

- [ ] **Step 2: Write the workflow file**

Create `.github/workflows/docker-publish.yml` with the following exact contents:

```yaml
name: Publish Docker image

on:
  push:
    branches: [main]
    tags: ['v*']

concurrency:
  group: docker-publish-${{ github.ref }}
  cancel-in-progress: false

env:
  IMAGE: parmesanparty/icc

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: linux/amd64
            runner: ubuntu-24.04
          - platform: linux/arm64
            runner: ubuntu-24.04-arm
    runs-on: ${{ matrix.runner }}
    outputs:
      digest-amd64: ${{ steps.set-digest.outputs.digest-amd64 }}
      digest-arm64: ${{ steps.set-digest.outputs.digest-arm64 }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}

      - name: Compute cache scope
        id: cache-scope
        run: |
          platform="${{ matrix.platform }}"
          echo "scope=build-${platform//\//-}" >> "$GITHUB_OUTPUT"

      - name: Build and push (digest only)
        id: build
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: ${{ matrix.platform }}
          outputs: type=image,name=${{ env.IMAGE }},push-by-digest=true,name-canonical=true,push=true
          cache-from: type=gha,scope=${{ steps.cache-scope.outputs.scope }}
          cache-to: type=gha,mode=max,scope=${{ steps.cache-scope.outputs.scope }}

      - name: Export digest to job output
        id: set-digest
        run: |
          platform="${{ matrix.platform }}"
          key="digest-${platform##*/}"
          echo "$key=${{ steps.build.outputs.digest }}" >> "$GITHUB_OUTPUT"

  merge:
    runs-on: ubuntu-24.04
    needs: build
    steps:
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}

      - name: Docker metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.IMAGE }}
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=sha,format=short,prefix=
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=semver,pattern={{major}}

      - name: Create multi-arch manifest
        run: |
          set -euo pipefail
          tags=$(jq -cr '.tags | map("-t " + .) | join(" ")' <<< "$DOCKER_METADATA_OUTPUT_JSON")
          docker buildx imagetools create $tags \
            ${{ env.IMAGE }}@${{ needs.build.outputs.digest-amd64 }} \
            ${{ env.IMAGE }}@${{ needs.build.outputs.digest-arm64 }}

      - name: Inspect manifest
        run: |
          docker buildx imagetools inspect ${{ env.IMAGE }}:${{ steps.meta.outputs.version }}
```

- [ ] **Step 3: Verify YAML parses locally**

Run:
```bash
python3 -c 'import yaml, sys; yaml.safe_load(open(".github/workflows/docker-publish.yml")); print("OK")'
```

Expected: `OK`. If Python complains about YAML syntax, fix the file before committing.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/docker-publish.yml
git commit -m "ci(docker): add multi-arch publish workflow for Docker Hub

Publishes parmesanparty/icc on every push to main (as :latest + :<sha>)
and on every v* tag (as semver tags). Parallel native builds on
ubuntu-24.04 and ubuntu-24.04-arm runners; digest-only intermediates
merged into a multi-arch manifest by a third job. Layer caching via
type=gha scoped per platform.

Prerequisite: DOCKER_USERNAME and DOCKER_PASSWORD repo secrets must
exist before the workflow can run. See docs/superpowers/plans/2026-04-07-sub-project-a-docker-ci-publish.md.

Related spec: docs/superpowers/specs/2026-04-07-docker-ci-publish-design.md"
```

---

## Task 2: Prompt the user to provision Docker Hub secrets

- [ ] **Step 1: Verify the user has added the repo secrets**

Pause implementation and ask the user:

> "Have you added `DOCKER_USERNAME` and `DOCKER_PASSWORD` as repository secrets at https://github.com/ParmesanParty/Inter-Claude-Connector/settings/secrets/actions? The workflow will fail at the Docker Hub login step without them."

Wait for confirmation before proceeding to Task 3. If the user has not added them, read them the "Prerequisites" section at the top of this plan and wait until they confirm.

- [ ] **Step 2: Push the workflow to `main` to trigger the first run**

```bash
git push origin main
```

Expected: workflow run appears in https://github.com/ParmesanParty/Inter-Claude-Connector/actions within a few seconds.

---

## Task 3: Verify end-to-end — workflow success, multi-arch manifest, rpi1 pull

- [ ] **Step 1: Watch the first workflow run to completion**

Run:
```bash
gh run watch --exit-status $(gh run list --workflow=docker-publish.yml --limit=1 --json databaseId --jq '.[0].databaseId')
```

Expected: `✓ main Publish Docker image · <run-id>` within ~5 minutes (native builds, cold cache).

If it fails:
- Read the failure: `gh run view --log-failed $(gh run list --workflow=docker-publish.yml --limit=1 --json databaseId --jq '.[0].databaseId')`
- Common failures: (a) missing secrets → back to Task 2; (b) Docker Hub PAT insufficient scope → regenerate with Read+Write+Delete; (c) YAML syntax → revert the push, fix locally, repeat Task 2

- [ ] **Step 2: Verify the multi-arch manifest on Docker Hub**

```bash
docker buildx imagetools inspect parmesanparty/icc:latest
```

Expected: two platforms listed (`linux/amd64` and `linux/arm64`), each with a matching SHA256 digest.

- [ ] **Step 3: Pull and run on rpi1 via ICC message**

Use the ICC MCP tool `send_message` to ask rpi1 to run the new pull flow. Send:

```
to: rpi1/inter-claude-connector
status: ACTION_NEEDED
body: [TOPIC: docker-ci-verify] The new GH Actions workflow just
published parmesanparty/icc:latest. Please run
`docker compose pull && docker compose up -d` from your ICC project
directory and confirm: (1) the pull fetches the new image (check image
ID changes), (2) the container comes up healthy via
`docker ps --filter name=icc`, (3) an ICC ping from um890 reaches you.
Reply with any errors.
```

- [ ] **Step 4: Wait for rpi1's reply and verify**

Read the reply via `check_messages`. Expected: all three confirmations green. If rpi1 reports a failure, diagnose with the logs they provide — do not dismiss as "pre-existing" (per CLAUDE.md directive).

- [ ] **Step 5: Update project memory to reflect the new update flow**

Read `~/.claude/projects/-home-albertnam-code-inter-claude-connector/memory/project_rpi1_deployment.md` and replace the "restart with" guidance (currently `docker compose up -d --build`) with `docker compose pull && docker compose up -d`. Also update the root `MEMORY.md` entry that references rpi1 deployment if it mentions `--build`.

Run:
```bash
grep -rn "compose up -d --build" ~/.claude/projects/-home-albertnam-code-inter-claude-connector/memory/
```

Expected after fix: no results.

- [ ] **Step 6: Final commit if any memory changes were made**

Memory files are not part of the repo — they live under `~/.claude/`, no git commit needed. Skip this step if no memory updates were required.

---

## Task 4: Verify tag-driven path with a throwaway tag (optional smoke test)

Only run this task if Task 3 succeeded and you want to confirm the semver path works before the first real release.

- [ ] **Step 1: Create and push a throwaway tag**

```bash
git tag v0.0.0-citest
git push origin v0.0.0-citest
```

- [ ] **Step 2: Watch the workflow run**

```bash
gh run watch --exit-status $(gh run list --workflow=docker-publish.yml --event=push --limit=1 --json databaseId --jq '.[0].databaseId')
```

Expected: another successful run.

- [ ] **Step 3: Verify semver tags appeared on Docker Hub**

```bash
docker buildx imagetools inspect parmesanparty/icc:0.0.0-citest
```

Expected: manifest with both platforms.

- [ ] **Step 4: Delete the throwaway tag locally and on the remote**

```bash
git tag -d v0.0.0-citest
git push origin :refs/tags/v0.0.0-citest
```

- [ ] **Step 5: Delete the throwaway tag on Docker Hub**

Either via the Docker Hub web UI (https://hub.docker.com/r/parmesanparty/icc/tags) or via:

```bash
curl -s -H "Authorization: JWT $(curl -s -X POST https://hub.docker.com/v2/users/login/ -H 'Content-Type: application/json' -d "{\"username\":\"parmesanparty\",\"password\":\"<PAT>\"}" | jq -r .token)" \
  -X DELETE "https://hub.docker.com/v2/repositories/parmesanparty/icc/tags/0.0.0-citest/"
```

(Replace `<PAT>` with the same Docker Hub PAT used by CI. Web UI is easier.)

---

## Self-review coverage matrix

| Spec section | Covered by |
|---|---|
| Workflow file path | Task 1 Step 2 |
| Triggers (main + v* tags) | Task 1 Step 2 `on:` block |
| Tag derivation (latest, sha, semver) | Task 1 Step 2 `metadata-action` block in `merge` job |
| Build matrix (amd64 + arm64 native runners) | Task 1 Step 2 `strategy.matrix` block |
| Digest-only intermediates + manifest merge | Task 1 Step 2 build job `outputs:` + merge job `buildx imagetools create` |
| GHA layer cache | Task 1 Step 2 `cache-from` / `cache-to` |
| Docker Hub auth via secrets | Task 1 Step 2 `docker/login-action` |
| Secrets prerequisite | Task 2 |
| First-run verification | Task 3 |
| Multi-arch manifest verification | Task 3 Step 2 |
| rpi1 end-to-end pull | Task 3 Steps 3–4 |
| Tag-driven path verification | Task 4 (optional) |
| Project memory update | Task 3 Step 5 |
| No code changes elsewhere | (implicit: file-structure table shows only one create) |

No placeholders detected. No gaps.
