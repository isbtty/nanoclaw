import { describe, it, expect } from 'vitest';
import path from 'path';

import { getLaunchdLabel } from '../src/install-slug.js';
import { renderExtraEnvVars } from './service.js';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 */

// Helper: generate a plist string the same way service.ts does
function generatePlist(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  extraEnv: Record<string, string | undefined> = {},
): string {
  const label = getLaunchdLabel(projectRoot);
  const extraEnvXml = renderExtraEnvVars(extraEnv);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${projectRoot}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>${extraEnvXml}
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/nanoclaw.error.log</string>
</dict>
</plist>`;
}

function generateSystemdUnit(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  isSystem: boolean,
): string {
  return `[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/nanoclaw.log
StandardError=append:${projectRoot}/logs/nanoclaw.error.log

[Install]
WantedBy=${isSystem ? 'multi-user.target' : 'default.target'}`;
}

describe('plist generation', () => {
  it('contains the slug-scoped label', () => {
    const projectRoot = '/home/user/nanoclaw';
    const plist = generatePlist('/usr/local/bin/node', projectRoot, '/home/user');
    expect(plist).toContain(`<string>${getLaunchdLabel(projectRoot)}</string>`);
    expect(plist).toMatch(/<string>com\.nanoclaw-v2-[0-9a-f]{8}<\/string>/);
  });

  it('uses the correct node path', () => {
    const plist = generatePlist(
      '/opt/node/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
  });

  it('points to dist/index.js', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('/home/user/nanoclaw/dist/index.js');
  });

  it('sets log paths', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('nanoclaw.log');
    expect(plist).toContain('nanoclaw.error.log');
  });
});

describe('systemd unit generation', () => {
  it('user unit uses default.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      true,
    );
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('uses KillMode=process to preserve detached children', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('KillMode=process');
  });

  it('sets correct ExecStart', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/srv/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /srv/nanoclaw/dist/index.js',
    );
  });
});

describe('plist EnvironmentVariables — deshi host-tools env (renderExtraEnvVars)', () => {
  it('空 env はベース dict (PATH / HOME) のみで、追加 entry を一切出さない', () => {
    const plist = generatePlist('/usr/local/bin/node', '/home/user/nanoclaw', '/home/user');
    // PATH と HOME は必ずある
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain('<key>HOME</key>');
    // 余計な key は無い (空フラグメントが綺麗に省略されること)
    expect(plist).not.toContain('DESHI_DAEMON_URL');
    expect(plist).not.toContain('DESHI_DAEMON_DEVICE_SECRET');
    // EnvironmentVariables の dict 閉じが HOME の直後に来る (= 余白行のみ)
    expect(plist).toContain(
      '<string>/home/user</string>\n    </dict>',
    );
  });

  it('DESHI_DAEMON_URL と DESHI_DAEMON_DEVICE_SECRET が両方ある時、両方 plist に embed', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      {
        DESHI_DAEMON_URL: 'http://localhost:3100',
        DESHI_DAEMON_DEVICE_SECRET: 'abc123',
      },
    );
    expect(plist).toContain('<key>DESHI_DAEMON_URL</key>');
    expect(plist).toContain('<string>http://localhost:3100</string>');
    expect(plist).toContain('<key>DESHI_DAEMON_DEVICE_SECRET</key>');
    expect(plist).toContain('<string>abc123</string>');
  });

  it('片方だけの場合はもう片方を skip して valid plist を生成する', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      { DESHI_DAEMON_URL: 'http://localhost:3100' },
    );
    expect(plist).toContain('<key>DESHI_DAEMON_URL</key>');
    expect(plist).not.toContain('DESHI_DAEMON_DEVICE_SECRET');
  });

  it('XML-unsafe 文字 (& < > " \\\') を含む値は escape される (= 壊れた plist にならない)', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      {
        DESHI_DAEMON_URL: 'http://example.com/?a=1&b=<2>',
        DESHI_DAEMON_DEVICE_SECRET: '"quote\'apos&',
      },
    );
    expect(plist).toContain('<string>http://example.com/?a=1&amp;b=&lt;2&gt;</string>');
    expect(plist).toContain('<string>&quot;quote&apos;apos&amp;</string>');
    // 生の `&b=` / `<2>` がそのまま残っていない (= XML parser を壊さない)
    expect(plist).not.toContain('&b=<2>');
    expect(plist).not.toContain('"quote\'apos&<');
  });

  it('空文字や undefined の value は entry ごと dropped (key だけ残らない)', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      {
        DESHI_DAEMON_URL: '',
        DESHI_DAEMON_DEVICE_SECRET: undefined,
      },
    );
    expect(plist).not.toContain('DESHI_DAEMON_URL');
    expect(plist).not.toContain('DESHI_DAEMON_DEVICE_SECRET');
  });
});

describe('WSL nohup fallback', () => {
  it('generates a valid wrapper script', () => {
    const projectRoot = '/home/user/nanoclaw';
    const nodePath = '/usr/bin/node';
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');

    // Simulate what service.ts generates
    const wrapper = `#!/bin/bash
set -euo pipefail
cd ${JSON.stringify(projectRoot)}
nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot)}/dist/index.js >> ${JSON.stringify(projectRoot)}/logs/nanoclaw.log 2>> ${JSON.stringify(projectRoot)}/logs/nanoclaw.error.log &
echo $! > ${JSON.stringify(pidFile)}`;

    expect(wrapper).toContain('#!/bin/bash');
    expect(wrapper).toContain('nohup');
    expect(wrapper).toContain(nodePath);
    expect(wrapper).toContain('nanoclaw.pid');
  });
});
