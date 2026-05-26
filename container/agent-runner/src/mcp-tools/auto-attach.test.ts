/**
 * Tests for the auto-attach helper used by `send_message`. Uses tmpdir as both
 * the workspace root and the agent root so the production hardcoded
 * `/workspace/*` paths don't leak into the test environment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { attachToOutbox, extractDeliverablePaths, type AutoAttachRoots } from './auto-attach.js';

let tmpRoot: string;
let roots: AutoAttachRoots;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-auto-attach-'));
  roots = {
    workspaceRoot: tmpRoot,
    agentRoot: path.join(tmpRoot, 'agent'),
    outboxRoot: path.join(tmpRoot, 'outbox'),
  };
  fs.mkdirSync(roots.agentRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function touch(rel: string, contents = 'x'): string {
  const abs = path.isAbsolute(rel) ? rel : path.join(roots.agentRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
  return abs;
}

describe('extractDeliverablePaths — backtick relative paths', () => {
  it('extracts a single backtick-quoted deliverable', () => {
    touch('output/report.pdf');
    const result = extractDeliverablePaths('Done — see `output/report.pdf`', roots);
    expect(result).toEqual([path.join(roots.agentRoot, 'output/report.pdf')]);
  });

  it('extracts multiple deliverables in the same message', () => {
    touch('report.pdf');
    touch('chart.png');
    const result = extractDeliverablePaths('Attached: `report.pdf` and `chart.png`', roots);
    expect(result.sort()).toEqual(
      [path.join(roots.agentRoot, 'report.pdf'), path.join(roots.agentRoot, 'chart.png')].sort(),
    );
  });

  it('dedupes when the same path is mentioned twice', () => {
    touch('report.pdf');
    const result = extractDeliverablePaths('See `report.pdf`. Yes, `report.pdf` again.', roots);
    expect(result).toEqual([path.join(roots.agentRoot, 'report.pdf')]);
  });
});

describe('extractDeliverablePaths — extension whitelist', () => {
  it('skips source code extensions even if the file exists', () => {
    touch('src/foo.ts');
    const result = extractDeliverablePaths('Look at `src/foo.ts`', roots);
    expect(result).toEqual([]);
  });

  it('skips backtick tokens without a file extension', () => {
    touch('README');
    const result = extractDeliverablePaths('See `README`', roots);
    expect(result).toEqual([]);
  });

  it('accepts case-insensitively (e.g. .PDF)', () => {
    touch('report.PDF');
    const result = extractDeliverablePaths('See `report.PDF`', roots);
    expect(result).toEqual([path.join(roots.agentRoot, 'report.PDF')]);
  });
});

describe('extractDeliverablePaths — containment', () => {
  it('drops relative paths that escape the workspace via ..', () => {
    // The escape target file does exist outside the workspace, so the only
    // thing keeping it out is the containment check itself.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-outside-'));
    try {
      fs.writeFileSync(path.join(outsideDir, 'secret.pdf'), 'x');
      const escapeRel = path.relative(roots.agentRoot, path.join(outsideDir, 'secret.pdf'));
      const result = extractDeliverablePaths(`escape: \`${escapeRel}\``, roots);
      expect(result).toEqual([]);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('drops absolute paths outside the workspace root', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-outside-'));
    try {
      const outsideFile = path.join(outsideDir, 'secret.pdf');
      fs.writeFileSync(outsideFile, 'x');
      const result = extractDeliverablePaths(`see \`${outsideFile}\``, roots);
      expect(result).toEqual([]);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects symlinks even if their target is a regular file inside workspace', () => {
    const targetAbs = touch('real.pdf');
    const linkAbs = path.join(roots.agentRoot, 'link.pdf');
    fs.symlinkSync(targetAbs, linkAbs);
    const result = extractDeliverablePaths('see `link.pdf`', roots);
    expect(result).toEqual([]);
  });
});

describe('extractDeliverablePaths — missing files', () => {
  it('silently drops references to files that do not exist', () => {
    const result = extractDeliverablePaths('see `does-not-exist.pdf`', roots);
    expect(result).toEqual([]);
  });

  it('keeps existing references when others are missing', () => {
    touch('exists.pdf');
    const result = extractDeliverablePaths('see `exists.pdf` and `gone.pdf`', roots);
    expect(result).toEqual([path.join(roots.agentRoot, 'exists.pdf')]);
  });
});

describe('extractDeliverablePaths — absolute paths under workspace', () => {
  it('extracts a bare absolute path under workspaceRoot from prose', () => {
    const abs = touch('output/report.pdf');
    const result = extractDeliverablePaths(`output written to ${abs}`, roots);
    expect(result).toEqual([abs]);
  });

  it('extracts a backtick-quoted absolute path under workspaceRoot', () => {
    const abs = touch('chart.png');
    const result = extractDeliverablePaths(`attached \`${abs}\``, roots);
    expect(result).toEqual([abs]);
  });
});

describe('attachToOutbox', () => {
  it('copies each file into outbox/<messageId>/ and returns the basenames', () => {
    const a = touch('report.pdf', 'AAA');
    const b = touch('chart.png', 'BBB');

    const filenames = attachToOutbox('msg-123', [a, b], roots.outboxRoot);

    expect(filenames).toEqual(['report.pdf', 'chart.png']);
    const dir = path.join(roots.outboxRoot, 'msg-123');
    expect(fs.readFileSync(path.join(dir, 'report.pdf'), 'utf-8')).toBe('AAA');
    expect(fs.readFileSync(path.join(dir, 'chart.png'), 'utf-8')).toBe('BBB');
  });

  it('disambiguates colliding basenames with -2, -3 suffixes', () => {
    const a = touch('alpha/report.pdf', 'first');
    const b = touch('beta/report.pdf', 'second');
    const c = touch('gamma/report.pdf', 'third');

    const filenames = attachToOutbox('msg-dup', [a, b, c], roots.outboxRoot);

    expect(filenames).toEqual(['report.pdf', 'report-2.pdf', 'report-3.pdf']);
    const dir = path.join(roots.outboxRoot, 'msg-dup');
    expect(fs.readFileSync(path.join(dir, 'report.pdf'), 'utf-8')).toBe('first');
    expect(fs.readFileSync(path.join(dir, 'report-2.pdf'), 'utf-8')).toBe('second');
    expect(fs.readFileSync(path.join(dir, 'report-3.pdf'), 'utf-8')).toBe('third');
  });

  it('returns empty and creates no directory when given no paths', () => {
    const filenames = attachToOutbox('msg-empty', [], roots.outboxRoot);
    expect(filenames).toEqual([]);
    expect(fs.existsSync(path.join(roots.outboxRoot, 'msg-empty'))).toBe(false);
  });
});
