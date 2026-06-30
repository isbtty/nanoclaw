import { beforeEach, describe, expect, it } from 'vitest';

import { _resetAckCacheForTests, forgetJob, getJobAck, putJobAck } from './ack-cache.js';

describe('ack-cache', () => {
  beforeEach(() => {
    _resetAckCacheForTests();
  });

  describe('jobId → ackText map', () => {
    it('putJobAck → getJobAck で取得できる', () => {
      putJobAck('job-1', '資料を作ってます ✏️');
      expect(getJobAck('job-1')).toBe('資料を作ってます ✏️');
    });

    it('未登録 jobId は undefined', () => {
      expect(getJobAck('nope')).toBeUndefined();
    });

    it('同じ jobId への 2 回目 put は無視される (古い要約を上書きしない)', () => {
      putJobAck('job-1', '一回目');
      putJobAck('job-1', '二回目');
      expect(getJobAck('job-1')).toBe('一回目');
    });

    it('forgetJob で削除できる', () => {
      putJobAck('job-1', 'x');
      forgetJob('job-1');
      expect(getJobAck('job-1')).toBeUndefined();
    });
  });
});
