/**
 * Auto-attach helper for `send_message`: scan an agent's message body for
 * deliverable-looking path references and copy those files into the message's
 * outbox so they ride along as attachments.
 *
 * Lets the agent reply with prose like:
 *   "Done — see `output/report.pdf` and `chart.png`."
 * without needing a separate `send_file` call per attachment. Keeps the
 * authoring flow natural while still using the same outbox + `files: [...]`
 * delivery contract the host already understands.
 *
 * Filter strategy is intentionally conservative:
 *
 *   1. Deliverable extension whitelist (PDFs, images, docs, data exports).
 *      Source code (.ts, .py, .go, ...) is deliberately excluded — an agent
 *      mentioning `src/foo.ts` in chat is almost always referring to code
 *      under review, not a download.
 *   2. Workspace containment. Resolved paths must live under the configured
 *      workspace root. Anything else (host paths, /etc, traversal via ..) is
 *      dropped silently.
 *   3. Real files only. Symlinks and missing files are dropped — the latter
 *      catches casual references to paths that don't actually exist yet.
 *
 * Anything that fails these checks is silently skipped, never surfaced as an
 * error: auto-attach is a best-effort enhancement and must never make a
 * `send_message` call fail.
 */
import fs from 'fs';
import path from 'path';

/**
 * Extensions we treat as "agent emitted artifact" worth attaching. Whitelisted
 * (not blacklisted) so unknown extensions default to "not a deliverable".
 */
export const DELIVERABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Documents
  '.pdf',
  '.docx',
  '.pptx',
  '.xlsx',
  // Data / config
  '.csv',
  '.json',
  '.yaml',
  '.yml',
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  // Text-y deliverables
  '.html',
  '.md',
  '.txt',
]);

export interface AutoAttachRoots {
  /** Resolution base for relative paths the agent writes (e.g. `report.pdf`). */
  agentRoot: string;
  /** Containment boundary for security checks — paths outside this are dropped. */
  workspaceRoot: string;
  /** Where per-message outbox subdirs are created. */
  outboxRoot: string;
}

/**
 * Scan `text` for deliverable-looking file path references and return absolute
 * paths to existing files that pass containment checks. Best-effort: anything
 * that fails any check is silently dropped.
 *
 * Matched syntaxes:
 *   - Backtick-quoted relative paths: `output/report.pdf`, `chart.png`
 *   - Backtick-quoted absolute paths: `/workspace/agent/output/report.pdf`
 *   - Bare absolute paths under the workspace root anywhere in prose
 *
 * Relative matches are resolved under `roots.agentRoot`. Absolute matches must
 * land under `roots.workspaceRoot` after path normalization, else they're
 * dropped (defends against `../`-style escape).
 */
export function extractDeliverablePaths(text: string, roots: AutoAttachRoots): string[] {
  const found = new Set<string>();

  // Backtick-quoted token containing an extension. Excludes whitespace and
  // backticks so we don't accidentally swallow surrounding prose.
  const backtickPattern = /`([^\s`]+\.[A-Za-z0-9]+)`/g;
  collectMatches(backtickPattern, text, (raw) => {
    const resolved = resolveAndValidate(raw, roots);
    if (resolved) found.add(resolved);
  });

  // Bare absolute path under the workspace root. Anchored to workspaceRoot so
  // we don't pick up arbitrary system paths (`/etc/passwd`, /tmp/foo.json) the
  // agent may mention in passing.
  const escapedRoot = escapeRegExp(roots.workspaceRoot);
  const absPattern = new RegExp(`${escapedRoot}/[^\\s\`'"]+\\.[A-Za-z0-9]+`, 'g');
  collectMatches(absPattern, text, (raw) => {
    const resolved = resolveAndValidate(raw, roots);
    if (resolved) found.add(resolved);
  });

  return Array.from(found);
}

/**
 * Copy each `sourcePath` into `<outboxRoot>/<messageId>/<filename>` and return
 * the basenames used (in input order, with collisions disambiguated by
 * `name-2.ext`, `name-3.ext`, ...).
 *
 * Returns `[]` and creates nothing if `sourcePaths` is empty — callers can
 * branch on the result to decide whether to include `files:` in the outbound
 * message content.
 */
export function attachToOutbox(
  messageId: string,
  sourcePaths: readonly string[],
  outboxRoot: string,
): string[] {
  if (sourcePaths.length === 0) return [];

  const outboxDir = path.join(outboxRoot, messageId);
  fs.mkdirSync(outboxDir, { recursive: true });

  const filenames: string[] = [];
  const used = new Set<string>();
  for (const src of sourcePaths) {
    const filename = disambiguateFilename(path.basename(src), used);
    fs.copyFileSync(src, path.join(outboxDir, filename));
    filenames.push(filename);
    used.add(filename);
  }
  return filenames;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function collectMatches(pattern: RegExp, text: string, onMatch: (raw: string) => void): void {
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    // Group 1 if present (capturing group used by backtick pattern), else full match.
    onMatch(m[1] ?? m[0]);
  }
}

function resolveAndValidate(rawPath: string, roots: AutoAttachRoots): string | null {
  if (!hasDeliverableExt(rawPath)) return null;

  const abs = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(roots.agentRoot, rawPath);

  // Containment: must live under the workspace root after normalization.
  // path.relative returning a value that starts with '..' (or is absolute on
  // Windows) means abs is outside root.
  const rel = path.relative(roots.workspaceRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  // Real file only — and explicitly reject symlinks so a planted symlink under
  // the workspace can't be used to exfiltrate /etc/passwd via auto-attach.
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile() || st.isSymbolicLink()) return null;

  return abs;
}

function hasDeliverableExt(p: string): boolean {
  return DELIVERABLE_EXTENSIONS.has(path.extname(p).toLowerCase());
}

function disambiguateFilename(filename: string, used: Set<string>): string {
  if (!used.has(filename)) return filename;
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate)) return candidate;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
