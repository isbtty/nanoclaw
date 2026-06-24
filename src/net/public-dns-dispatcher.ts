/**
 * Public-DNS undici dispatcher — mDNSResponder 非依存化 (送信経路).
 *
 * 背景: macOS の mDNSResponder が間欠的に wedge すると getaddrinfo 経路の名前解決が
 * 全停止し、`fetch`(undici) を使う channel 送信 (lineFetch 等) が `fetch failed` で
 * 配信不能になる (isbtty/deshi#457)。
 *
 * 対策: undici のグローバル dispatcher の connect.lookup を c-ares (`dns.Resolver`)
 * ベースに差し替え、公共DNS(1.1.1.1/8.8.8.8) で直接解決して getaddrinfo/mDNSResponder
 * を迂回する。Node 22 の内蔵グローバル `fetch` も `Symbol.for('undici.globalDispatcher.1')`
 * を共有するため、setGlobalDispatcher でホストプロセスの全 outbound fetch に適用される。
 *
 * 注意: `dns.setServers()` 単体では効かない。あれは `dns.resolve*()`(c-ares) にしか
 * 影響せず、fetch/undici が内部で使う `dns.lookup()`(= getaddrinfo) は素通りするため。
 * よって connect.lookup を c-ares 解決に差し込む必要がある。詳細は deshi の
 * docs/adr/0013-dns-mdns-resilience.md (Layer 2)。
 */
import dns from 'dns';
import type { LookupAddress, LookupOptions } from 'dns';
import net from 'net';
import { Agent, setGlobalDispatcher } from 'undici';

import { log } from '../log.js';

const PUBLIC_DNS = (process.env.NANOCLAW_PUBLIC_DNS ?? '1.1.1.1,8.8.8.8')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const resolver = new dns.Resolver();
try {
  resolver.setServers(PUBLIC_DNS);
} catch (err) {
  // 不正な設定なら system resolver のまま。lookup 側で getaddrinfo に fallback する。
  log.warn('public DNS resolver setServers failed; falling back to system resolver', {
    servers: PUBLIC_DNS,
    error: (err as Error)?.message,
  });
}

// undici の connect.lookup は Node の net.LookupFunction を期待する
// (options: dns.LookupOptions, callback: (err, address: string | LookupAddress[], family?) => void)。
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

// dns.LookupOptions.family は number | 'IPv4' | 'IPv6'。数値 (4/6/0) に正規化する。
function normalizeFamily(family: LookupOptions['family']): number {
  if (family === 4 || family === 'IPv4') return 4;
  if (family === 6 || family === 'IPv6') return 6;
  return 0;
}

function resolveViaCares(hostname: string, family: number): Promise<LookupAddress[]> {
  const v4 = (): Promise<LookupAddress[]> =>
    new Promise((resolve, reject) => {
      resolver.resolve4(hostname, (err, addrs) => {
        if (err) reject(err);
        else resolve(addrs.map((address) => ({ address, family: 4 })));
      });
    });
  const v6 = (): Promise<LookupAddress[]> =>
    new Promise((resolve, reject) => {
      resolver.resolve6(hostname, (err, addrs) => {
        if (err) reject(err);
        else resolve(addrs.map((address) => ({ address, family: 6 })));
      });
    });
  if (family === 6) return v6();
  if (family === 4) return v4();
  // family 0: prefer IPv4 (dns.setDefaultResultOrder('ipv4first') と整合)、IPv6 に fallback。
  return v4().catch(() => v6());
}

/**
 * Node 互換 lookup。公共ホストは c-ares (公共DNS) で解決し getaddrinfo を迂回する。
 * IP リテラルや c-ares が解けない名前 (localhost / コンテナ名 / /etc/hosts) は
 * system resolver に fallback し、内部接続性を維持する。
 */
function caresLookup(hostname: string, options: LookupOptions | number, callback: LookupCallback): void {
  const opts: LookupOptions = typeof options === 'number' ? { family: options } : (options ?? {});
  const family = normalizeFamily(opts.family);

  // IP リテラルは DNS を引かずそのまま返す。
  const ipVersion = net.isIP(hostname);
  if (ipVersion) {
    if (opts.all) callback(null, [{ address: hostname, family: ipVersion }]);
    else callback(null, hostname, ipVersion);
    return;
  }

  resolveViaCares(hostname, family).then(
    (records) => {
      if (records.length === 0) {
        // c-ares が空応答。system resolver に委ねる。
        dns.lookup(hostname, opts, callback);
        return;
      }
      if (opts.all) callback(null, records);
      else callback(null, records[0].address, records[0].family);
    },
    () => {
      // c-ares 失敗 (localhost / コンテナ名 / 一過性 miss) → system getaddrinfo。
      dns.lookup(hostname, opts, callback);
    },
  );
}

let installed = false;

/** undici グローバル dispatcher を c-ares lookup 版に差し替える (冪等)。 */
export function installPublicDnsDispatcher(): void {
  if (installed) return;
  installed = true;
  setGlobalDispatcher(new Agent({ connect: { lookup: caresLookup } }));
  log.info('public DNS dispatcher installed (mDNSResponder bypass)', { servers: PUBLIC_DNS });
}
