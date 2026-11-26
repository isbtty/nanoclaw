import { readFileSync } from 'node:fs';

// Source and compiled host modules both sit one directory below the install root.
export const MOUNT_VERIFICATION_PROGRAM = readFileSync(
  new URL('../container/agent-runner/verify-mounted-fixture.cjs', import.meta.url),
  'utf8',
);
