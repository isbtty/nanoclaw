import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { log } from '../log.js';
import { createAdapterLogger } from './adapter-logger.js';

describe('createAdapterLogger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.spyOn(log, 'debug').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('emits the first occurrence with a prefixed message and structured data', () => {
    const logger = createAdapterLogger('telegram', 1000);
    logger.warn('polling failed', { code: 1 });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('[telegram] polling failed', { code: 1 });
  });

  it('suppresses repeated identical messages within the window', () => {
    const logger = createAdapterLogger('telegram', 1000);
    logger.warn('polling failed');
    logger.warn('polling failed');
    logger.warn('polling failed');
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('re-emits after the window carrying the suppressed count', () => {
    const logger = createAdapterLogger('telegram', 1000);
    logger.warn('polling failed'); // emitted
    logger.warn('polling failed'); // suppressed (1)
    logger.warn('polling failed'); // suppressed (2)
    vi.setSystemTime(1000); // window elapsed
    logger.warn('polling failed'); // emitted with summary
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenLastCalledWith('[telegram] polling failed', { suppressedInWindow: 2 });
  });

  it('does not collapse distinct messages together', () => {
    const logger = createAdapterLogger('telegram', 1000);
    logger.warn('error A');
    logger.warn('error B');
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('throttles each level independently and routes to the matching log method', () => {
    const logger = createAdapterLogger('slack', 1000);
    logger.info('same');
    logger.error('same');
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('namespaces child loggers', () => {
    const logger = createAdapterLogger('telegram', 1000).child('poller');
    logger.warn('failed');
    expect(log.warn).toHaveBeenCalledWith('[telegram:poller] failed', undefined);
  });
});
