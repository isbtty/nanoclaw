/**
 * hostFetch のリトライ挙動を決定的に固定する単体テスト。
 *
 * live e2e では host.docker.internal の一過性瞬断を再現できないため、fetch を
 * 差し替えて「一過性の接続失敗 → バックオフ後に復帰」等のシナリオを固定する。
 * bun:test で実行 (sibling run-start-guard.test.ts と同経路)。
 */
import { describe, it, expect } from "bun:test";
import { hostFetch, HOST_FETCH_RETRY_DELAYS_MS } from "./host-fetch.js";

const HOST = "http://host.docker.internal:5180";
const noSleep = async (): Promise<void> => {};
const ok = (): Response => new Response("ok", { status: 200 });

describe("hostFetch retry", () => {
  it("一過性の接続エラーはバックオフでリトライし、復帰したら成功する", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed");
      return ok();
    }) as unknown as typeof fetch;

    const res = await hostFetch(HOST, "health", {}, undefined, {
      fetchImpl,
      sleep: noSleep,
    });

    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });

  it("HTTP エラー応答 (5xx) はリトライしない — サーバーには届いている", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("boom", { status: 503 });
    }) as unknown as typeof fetch;

    const res = await hostFetch(HOST, "health", {}, undefined, {
      fetchImpl,
      sleep: noSleep,
    });

    expect(res.status).toBe(503);
    expect(calls).toBe(1);
  });

  it("AbortError は即座に伝播しリトライしない", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;

    await expect(
      hostFetch(HOST, "health", {}, undefined, { fetchImpl, sleep: noSleep }),
    ).rejects.toThrow("aborted");
    expect(calls).toBe(1);
  });

  it("全リトライ枯渇後に host.docker.internal → localhost フォールバックを1回試す", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const u = String(input);
      seen.push(u);
      if (u.includes("host.docker.internal")) throw new TypeError("fetch failed");
      return ok(); // localhost は成功する想定
    }) as unknown as typeof fetch;

    const res = await hostFetch(HOST, "health", {}, undefined, {
      fetchImpl,
      sleep: noSleep,
    });

    expect(res.status).toBe(200);
    const primary = seen.filter((u) => u.includes("host.docker.internal")).length;
    const fallback = seen.filter((u) => u.includes("localhost")).length;
    expect(primary).toBe(HOST_FETCH_RETRY_DELAYS_MS.length + 1);
    expect(fallback).toBe(1);
  });

  it("primary もフォールバックも全滅なら最後の接続エラーを throw する", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed: ENOTFOUND host.docker.internal");
    }) as unknown as typeof fetch;

    await expect(
      hostFetch(HOST, "health", {}, undefined, { fetchImpl, sleep: noSleep }),
    ).rejects.toThrow("ENOTFOUND");
  });

  it("最大試行回数はバックオフ配列長 + 1 に一致する", async () => {
    let calls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      // primary だけ数える (localhost フォールバックは除外)
      if (String(input).includes("host.docker.internal")) calls++;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(
      hostFetch(HOST, "health", {}, undefined, { fetchImpl, sleep: noSleep }),
    ).rejects.toThrow();
    expect(calls).toBe(HOST_FETCH_RETRY_DELAYS_MS.length + 1);
  });
});
