/**
 * Per-messaging-group container env overrides.
 *
 * Operator-managed file `data/container-env.json` (not materialized from the
 * DB — survives spawns and image rebuilds, gitignored with the rest of data/):
 *
 *   {
 *     "byMessagingGroup": {
 *       "<messaging-group-id>": { "CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS": "1" }
 *     }
 *   }
 *
 * Entries are appended as `-e KEY=value` at container spawn, after the
 * provider/gateway env so operator values win. Missing file = no overrides;
 * a malformed file is ignored with a warning rather than blocking spawns.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

interface ContainerEnvOverridesFile {
  byMessagingGroup?: Record<string, Record<string, string>>;
}

/** Pure parser, split out for tests. Returns {} on any shape mismatch. */
export function parseEnvOverrides(raw: string, messagingGroupId: string): Record<string, string> {
  const parsed = JSON.parse(raw) as ContainerEnvOverridesFile;
  const entry = parsed?.byMessagingGroup?.[messagingGroupId];
  if (!entry || typeof entry !== 'object') return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

export function envOverridesForMessagingGroup(messagingGroupId: string | null): Record<string, string> {
  if (!messagingGroupId) return {};
  const file = path.join(DATA_DIR, 'container-env.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return {};
  }
  try {
    return parseEnvOverrides(raw, messagingGroupId);
  } catch (err) {
    log.warn('Invalid data/container-env.json — ignoring env overrides', { err });
    return {};
  }
}
