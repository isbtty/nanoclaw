'use strict';

// Fixed program run by the host in the group's agent runtime. The result contains
// only a boolean. Paths, file bytes and OS errors must never go to stdout/stderr.
const fs = require('node:fs');
const { O_APPEND, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_RDWR } = fs.constants;
const MAX_BYTES = 8 * 1024 * 1024;
const segment = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
// Docker Desktop's Linux VM exposes these built-in tunnel devices even in a
// container created with `--network none`. They have no namespace link while
// DOWN, but `/sys/class/net` still lists them (and a `bonding_masters` control
// file), so "anything except lo" rejects the real isolated runtime. Keep the
// exception deliberately closed over the observed kernel devices and types;
// an ordinary veth/eth interface is never accepted, even while DOWN.
const dormantKernelTunnels = new Map([
  ['erspan0', '1'],
  ['gre0', '778'],
  ['gretap0', '1'],
  ['ip6_vti0', '769'],
  ['ip6gre0', '823'],
  ['ip6tnl0', '769'],
  ['ip_vti0', '768'],
  ['sit0', '776'],
  ['tunl0', '768'],
]);

function networkIsIsolated(readText = (file) => fs.readFileSync(file, 'utf8')) {
  const rows = readText('/proc/net/dev').split('\n').slice(2);
  const names = [];
  for (const row of rows) {
    if (!row.trim()) continue;
    const colon = row.indexOf(':');
    if (colon < 0) return false;
    const name = row.slice(0, colon).trim();
    if (!name || names.includes(name)) return false;
    names.push(name);
  }
  if (!names.includes('lo')) return false;

  const flags = (name) => {
    const raw = readText('/sys/class/net/' + name + '/flags').trim();
    return /^0x[0-9a-f]+$/i.test(raw) ? Number.parseInt(raw.slice(2), 16) : NaN;
  };
  const loopbackFlags = flags('lo');
  if (readText('/sys/class/net/lo/type').trim() !== '772' || !Number.isInteger(loopbackFlags)) return false;
  if ((loopbackFlags & 0x9) !== 0x9) return false; // IFF_UP | IFF_LOOPBACK

  for (const name of names) {
    if (name === 'lo') continue;
    const expectedType = dormantKernelTunnels.get(name);
    if (!expectedType || readText('/sys/class/net/' + name + '/type').trim() !== expectedType) return false;
    const deviceFlags = flags(name);
    if (!Number.isInteger(deviceFlags) || (deviceFlags & 0x1) !== 0) return false; // IFF_UP must stay clear
    if (readText('/sys/class/net/' + name + '/operstate').trim() !== 'down') return false;
  }
  return true;
}

function extraName(path) {
  const prefix = '/workspace/extra/';
  if (typeof path !== 'string' || !path.startsWith(prefix)) return false;
  return segment.test(path.slice(prefix.length));
}

function validMarker(marker, runId) {
  return (
    typeof marker === 'string' && marker.length <= 200 && /^[A-Za-z0-9_=:.-]+$/.test(marker) && marker.endsWith(runId)
  );
}

function validRequest(request) {
  if (!request || typeof request !== 'object' || !extraName(request.mountPath)) return false;
  const { check, runId, relative, expectMarker, appendMarker } = request;
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) return false;
  if (check === 'deny-path') return extraName(request.containerPath) && request.containerPath !== request.mountPath;
  if (!['read-marker', 'append-marker'].includes(check) || !validMarker(expectMarker, runId)) return false;
  if (check === 'read-marker' && relative === 'INDEX.md') return true;
  if (typeof relative !== 'string' || relative.length > 220) return false;
  const parts = relative.split('/');
  const basename = parts.pop();
  if (parts.length > 1 || !parts.every((part) => segment.test(part))) return false;
  if (!basename.endsWith('-' + runId + '.md') || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(basename)) return false;
  return check === 'read-marker' || (validMarker(appendMarker, runId) && appendMarker !== expectMarker);
}

function readBounded(fd) {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error();
  const bytes = Buffer.alloc(stat.size);
  for (let offset = 0; offset < bytes.length;) {
    const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (n === 0) throw new Error();
    offset += n;
  }
  return bytes.toString('utf8');
}

function containsToken(text, marker) {
  for (let start = text.indexOf(marker); start !== -1; start = text.indexOf(marker, start + 1)) {
    if (!/[A-Za-z0-9._-]/.test(text[start - 1] || ' ') && !/[A-Za-z0-9._-]/.test(text[start + marker.length] || ' '))
      return true;
  }
  return false;
}

function checkFile(fd, request) {
  const text = readBounded(fd);
  if (!containsToken(text, request.expectMarker)) return false;
  if (request.check === 'read-marker') return true;
  const marker = request.appendMarker;
  const count = (value) => value.split(/\r?\n/).filter((line) => line === marker).length;
  const existing = count(text);
  if (existing > 0) return existing === 1;
  const line = Buffer.from((text.endsWith('\n') ? '' : '\n') + marker + '\n');
  if (fs.fstatSync(fd).size + line.length > MAX_BYTES || fs.writeSync(fd, line) !== line.length) return false;
  fs.fsyncSync(fd);
  return count(readBounded(fd)) === 1;
}

function verify(request) {
  if (!validRequest(request)) return false;
  // Require the network namespace actually selected by the runtime.
  if (!networkIsIsolated()) return false;
  // All permitted destination names are ASCII and contain no mountinfo escapes.
  const mountpoints = fs
    .readFileSync('/proc/self/mountinfo', 'utf8')
    .trimEnd()
    .split('\n')
    .map((row) => row.split(' ')[4]);
  if (mountpoints.filter((path) => path === request.mountPath).length !== 1) return false;
  if (request.check === 'deny-path') {
    const path = request.containerPath;
    if (mountpoints.some((point) => point === path || point.startsWith(path + '/'))) return false;
    try {
      fs.lstatSync(path);
      return false;
    } catch (error) {
      return error.code === 'ENOENT';
    }
  }

  const filePath = request.mountPath + '/' + request.relative;
  if (
    mountpoints.some(
      (point) => point.startsWith(request.mountPath + '/') && (point === filePath || filePath.startsWith(point + '/')),
    )
  )
    return false;
  // Open each component relative to a pinned directory fd. A renamed directory
  // or a symlink in the shared filesystem cannot redirect a subsequent open.
  const fds = [];
  try {
    fds.push(fs.openSync(request.mountPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW));
    const parts = request.relative.split('/');
    const basename = parts.pop();
    const child = (part) => '/proc/self/fd/' + fds[fds.length - 1] + '/' + part;
    for (const part of parts) fds.push(fs.openSync(child(part), O_RDONLY | O_DIRECTORY | O_NOFOLLOW));
    const mode = request.check === 'append-marker' ? O_RDWR | O_APPEND : O_RDONLY;
    const fd = fs.openSync(child(basename), mode | O_NOFOLLOW | O_NONBLOCK);
    fds.push(fd);
    return checkFile(fd, request);
  } finally {
    for (const fd of fds.reverse()) fs.closeSync(fd);
  }
}

if (typeof module !== 'undefined') module.exports = { checkFile, networkIsIsolated, validRequest, verify };
// node -e supplies the JSON as argv[1]. Requiring the module only loads its definitions.
if (process.argv.length === 2 && process.execArgv.includes('-e')) {
  let ok = false;
  try {
    if (process.argv[1].length <= 2048) ok = verify(JSON.parse(process.argv[1]));
  } catch {}
  process.stdout.write(JSON.stringify({ ok }) + '\n');
  process.exitCode = ok ? 0 : 1;
}
