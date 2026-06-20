import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { writeDestinations } from './write-destinations.js';
import { createDestination } from './db/agent-destinations.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, inboundDbPath } from '../../session-manager.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-write-dest' };
});

const TEST_DIR = '/tmp/nanoclaw-test-write-dest';
const AG = 'ag-test';
const SESSION = 'sess-test';
const SENDER_MG = 'mg-sender';
const OTHER_MG = 'mg-other';

function now(): string {
  return new Date().toISOString();
}

function readDestinations(agentGroupId: string, sessionId: string) {
  const db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true });
  const rows = db
    .prepare('SELECT name, display_name, type, channel_type, platform_id FROM destinations ORDER BY name')
    .all() as Array<{
    name: string;
    display_name: string | null;
    type: string;
    channel_type: string | null;
    platform_id: string | null;
  }>;
  db.close();
  return rows;
}

describe('writeDestinations — implicit "here" reply destination', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({ id: AG, name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: SENDER_MG,
      channel_type: 'line',
      platform_id: 'line:user:Usender',
      name: 'Sender',
      is_group: 0,
      unknown_sender_policy: 'request_approval',
      created_at: now(),
    });
    createSession({
      id: SESSION,
      agent_group_id: AG,
      messaging_group_id: SENDER_MG,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    initSessionFolder(AG, SESSION);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('adds "here" pointing at the session\'s own conversation when no named destination covers it', () => {
    writeDestinations(AG, SESSION);

    const dests = readDestinations(AG, SESSION);
    const here = dests.find((d) => d.name === 'here');
    expect(here).toBeDefined();
    expect(here).toMatchObject({
      type: 'channel',
      channel_type: 'line',
      platform_id: 'line:user:Usender',
      display_name: 'Sender',
    });
  });

  it('keeps "here" alongside a named destination to a *different* conversation (the cross-user-leak fix)', () => {
    // The agent already has a destination to someone else (e.g. the owner).
    // Without "here", the new sender's reply would be misdelivered to them.
    createMessagingGroup({
      id: OTHER_MG,
      channel_type: 'line',
      platform_id: 'line:user:Uowner',
      name: 'Owner',
      is_group: 0,
      unknown_sender_policy: 'request_approval',
      created_at: now(),
    });
    createDestination({
      agent_group_id: AG,
      local_name: 'owner',
      target_type: 'channel',
      target_id: OTHER_MG,
      created_at: now(),
    });

    writeDestinations(AG, SESSION);

    const dests = readDestinations(AG, SESSION);
    expect(dests.map((d) => d.name).sort()).toEqual(['here', 'owner']);
    expect(dests.find((d) => d.name === 'here')?.platform_id).toBe('line:user:Usender');
    expect(dests.find((d) => d.name === 'owner')?.platform_id).toBe('line:user:Uowner');
  });

  it('does not add a duplicate "here" when a named destination already covers this conversation', () => {
    // Owner's own session: the named destination already points at the
    // session's own messaging group, so no implicit "here" is needed.
    createDestination({
      agent_group_id: AG,
      local_name: 'self-named',
      target_type: 'channel',
      target_id: SENDER_MG,
      created_at: now(),
    });

    writeDestinations(AG, SESSION);

    const dests = readDestinations(AG, SESSION);
    expect(dests.some((d) => d.name === 'here')).toBe(false);
    expect(dests.map((d) => d.name)).toEqual(['self-named']);
  });
});
