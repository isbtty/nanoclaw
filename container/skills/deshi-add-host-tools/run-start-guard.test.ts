/**
 * run_start 多重発火ガードの単体テスト (isbtty/deshi#451 二次問題)。
 *
 * live e2e では agent が再 run_start / 二重呼びを拒否するため (jobEvicted を
 * 受けて報告・停止する) このガードを実機で発火させられない。構造ガードの
 * 「弾く / 通す」両方をここで決定的に固定する。bun:test で実行。
 */
import { describe, it, expect } from "bun:test";
import {
  shouldDedupeRunStart,
  armRunStartGuard,
  type LastRunStart,
} from "./run-start-guard.js";

const armed: LastRunStart = { triggerSeq: 5, jobId: "job-1", threadId: "t-1" };

describe("shouldDedupeRunStart", () => {
  it("同一 triggerSeq の 2 本目を dedupe する (新 wake 無し)", () => {
    expect(shouldDedupeRunStart(armed, 5)).toEqual(armed);
  });

  it("新しい wake で triggerSeq が前進したら通す (誤抑止しない)", () => {
    expect(shouldDedupeRunStart(armed, 6)).toBeNull();
  });

  it("初回 (直前 run 無し) は通す", () => {
    expect(shouldDedupeRunStart(null, 5)).toBeNull();
  });

  it("triggerSeq < 0 (DB 読めず) はガード無効で通す", () => {
    expect(shouldDedupeRunStart(armed, -1)).toBeNull();
  });
});

describe("armRunStartGuard", () => {
  it("run_start 成功時に新 job で arm する", () => {
    const res = JSON.stringify({ ok: true, jobId: "job-2", threadId: "t-2" });
    expect(armRunStartGuard(null, 7, res, false)).toEqual({
      triggerSeq: 7,
      jobId: "job-2",
      threadId: "t-2",
    });
  });

  it("threadId 欠落でも空文字で arm する", () => {
    const res = JSON.stringify({ ok: true, jobId: "job-3" });
    expect(armRunStartGuard(null, 8, res, false)).toEqual({
      triggerSeq: 8,
      jobId: "job-3",
      threadId: "",
    });
  });

  it("isError のときは arm せず直前状態を維持 (失敗を閉じ込めない)", () => {
    expect(armRunStartGuard(armed, 7, "...", true)).toEqual(armed);
  });

  it("triggerSeq < 0 のときは arm しない", () => {
    const res = JSON.stringify({ ok: true, jobId: "x" });
    expect(armRunStartGuard(armed, -1, res, false)).toEqual(armed);
  });

  it("ok=false のレスポンスでは arm しない", () => {
    const res = JSON.stringify({ ok: false });
    expect(armRunStartGuard(armed, 7, res, false)).toEqual(armed);
  });

  it("非 JSON レスポンスでは arm しない", () => {
    expect(armRunStartGuard(armed, 7, "not json", false)).toEqual(armed);
  });
});
