// Applied-config manifest module for sub-project B's /sync skill.
//
// What is a manifest? Each host stores a per-identity record at
// ~/.icc/applied-config-manifest.<identity>.json describing the last
// successful /sync: the setup payload version, when it was applied, and a
// hash of each managed file's ICC-owned region. /sync uses this on the next
// run to detect:
//   1. version drift (server payload version differs from manifest version)
//   2. hand edits (current file hash differs from manifest hash for the
//      ICC-owned region — sibling/non-ICC content is ignored)
//
// Three flavors of "owned region":
//   1. JSON subtree — for ~/.claude.json (mcpServers.icc) and
//      ~/.claude/settings.json (hooks). Use hashJsonSubtree.
//   2. Marker-bracketed region — for ~/.claude/CLAUDE.md, between
//      <!-- ICC:BEGIN --> and <!-- ICC:END -->. Use hashClaudeMdRegion.
//   3. Whole-file — for ~/.claude/skills/{watch,snooze,wake,sync}/SKILL.md
//      (we own the entire file). Use hashFileContents.
//
// Hash width: 64 chars (full SHA-256). Manifest entries are compared for
// byte-exact equality on every sync — collisions would be catastrophic
// (silently masking hand edits). This is intentionally NOT unified with
// hashPayload in src/setup-config.ts, which is deliberately truncated to 12
// chars for user-facing brevity in the drift hint. A future "cleanup"
// refactor must NOT merge them — the asymmetry is by design.
//
// Atomic writes: writeManifest writes to a tempfile then renames into place
// so a crashed process can never leave a half-written manifest. A corrupted
// manifest from any other cause must also not crash hook startup, so
// readManifest catches parse errors and returns null — /sync will overwrite
// it cleanly on the next run.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { canonicalJson } from './setup-config.ts';

export const ICC_MARKER_BEGIN = '<!-- ICC:BEGIN -->';
export const ICC_MARKER_END = '<!-- ICC:END -->';

export interface AppliedConfigManifest {
  version: string | null;
  appliedAt: string;
  files: Record<string, string>;
}

/**
 * Reads a manifest from disk. Returns null when the file is missing OR when
 * the contents are malformed JSON. Never throws — corrupted manifests must
 * not crash hook startup (Plan C resilience).
 */
export function readManifest(path: string): AppliedConfigManifest | null {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(content) as AppliedConfigManifest;
  } catch {
    return null;
  }
}

/**
 * Atomic write: tempfile + rename, mode 0600, trailing newline.
 */
export function writeManifest(path: string, manifest: AppliedConfigManifest): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

function getSubtree(obj: unknown, dottedPath: string): unknown {
  let cur: any = obj;
  for (const key of dottedPath.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Navigates `obj` to the dotted path, canonical-serializes the subtree, and
 * returns the full 64-char SHA-256 hex. Sibling keys at every level are
 * ignored entirely.
 */
export function hashJsonSubtree(obj: unknown, dottedPath: string): string {
  const subtree = getSubtree(obj, dottedPath);
  return createHash('sha256').update(canonicalJson(subtree), 'utf8').digest('hex');
}

/**
 * Full SHA-256 hex of arbitrary string content. Used for skill files where
 * the entire file is ICC-owned.
 */
export function hashFileContents(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const MARKER_REGEX = /<!--\s*ICC:BEGIN[^>]*-->([\s\S]*?)<!--\s*ICC:END\s*-->/;

/**
 * Returns the trimmed inner content between ICC:BEGIN/END markers, or null
 * if markers are absent.
 */
export function extractClaudeMdRegion(fileContent: string): string | null {
  const match = fileContent.match(MARKER_REGEX);
  if (!match || match[1] === undefined) return null;
  return match[1].trim();
}

/**
 * Extracts the ICC-owned region of a CLAUDE.md file and returns its full
 * SHA-256. Returns null when markers are absent.
 */
export function hashClaudeMdRegion(fileContent: string): string | null {
  const inner = extractClaudeMdRegion(fileContent);
  if (inner === null) return null;
  return hashFileContents(inner);
}

/**
 * Wraps inner content with ICC:BEGIN/END markers, ensuring a trailing
 * newline before the END marker.
 */
export function wrapClaudeMdWithMarkers(inner: string): string {
  const body = inner.endsWith('\n') ? inner : inner + '\n';
  return `${ICC_MARKER_BEGIN}\n${body}${ICC_MARKER_END}`;
}
