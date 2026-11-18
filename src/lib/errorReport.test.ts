import { describe, expect, it } from 'vitest';
import {
  admitReport,
  buildErrorReport,
  MAX_MESSAGE_CHARS,
  MAX_REPORTS_PER_SESSION,
  MAX_STACK_CHARS,
  newSendLog,
  scrubText,
} from './errorReport';

const context = { path: '/', appVersion: '1.1.0', platform: 'web' };

describe('scrubText', () => {
  it('removes emails, URL query strings and long numbers', () => {
    expect(scrubText('No account for asha@example.com')).toBe('No account for [email]');
    expect(scrubText('GET https://x.app/reset?token=abc#type=recovery failed')).toBe('GET https://x.app/reset failed');
    expect(scrubText('card 4111111111111111, amount 2500')).toBe('card [number], amount 2500');
  });
});

describe('buildErrorReport', () => {
  it('describes an Error with its name, message and scrubbed stack', () => {
    const error = new TypeError('x is undefined for a@b.co');
    const report = buildErrorReport('render', error, { ...context, path: '/home?tab=1#top' });
    expect(report.kind).toBe('render');
    expect(report.message).toBe('TypeError: x is undefined for [email]');
    expect(report.stack).toContain('[email]');
    expect(report.path).toBe('/home');
  });

  it('keeps a plain Error message without a name prefix', () => {
    expect(buildErrorReport('error', new Error('boom'), context).message).toBe('boom');
  });

  it('handles strings, message objects and other thrown values', () => {
    expect(buildErrorReport('rejection', 'just text', context)).toMatchObject({ message: 'just text', stack: null });
    expect(buildErrorReport('rejection', { message: 'obj' }, context).message).toBe('obj');
    expect(buildErrorReport('rejection', 42, context).message).toBe('Non-error thrown: 42');
    expect(buildErrorReport('rejection', undefined, context).message).toBe('Non-error thrown: undefined');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(buildErrorReport('rejection', cyclic, context).message).toBe('Non-error thrown: [object Object]');
  });

  it('clips to the table limits', () => {
    const error = new Error('m'.repeat(5000));
    error.stack = 's'.repeat(10_000);
    const report = buildErrorReport('error', error, context);
    expect(report.message).toHaveLength(MAX_MESSAGE_CHARS);
    expect(report.stack).toHaveLength(MAX_STACK_CHARS);
  });
});

describe('admitReport', () => {
  it('sends each distinct error once', () => {
    const log = newSendLog();
    const report = buildErrorReport('error', new Error('same'), context);
    expect(admitReport(log, report)).toBe(true);
    expect(admitReport(log, { ...report })).toBe(false);
    expect(admitReport(log, buildErrorReport('rejection', new Error('same'), context))).toBe(true);
  });

  it('caps reports per session', () => {
    const log = newSendLog();
    let sent = 0;
    for (let i = 0; i < MAX_REPORTS_PER_SESSION + 5; i += 1) {
      if (admitReport(log, buildErrorReport('error', `error ${i}`, context))) sent += 1;
    }
    expect(sent).toBe(MAX_REPORTS_PER_SESSION);
  });

  it('drops noise', () => {
    const log = newSendLog();
    for (const message of ['Script error.', 'ResizeObserver loop completed with undelivered notifications.', 'Failed to fetch']) {
      expect(admitReport(log, buildErrorReport('error', message, context))).toBe(false);
    }
    const extension = new Error('ext');
    extension.stack = 'Error: ext\n    at chrome-extension://abc/content.js:1:1';
    expect(admitReport(log, buildErrorReport('error', extension, context))).toBe(false);
    expect(log.sent).toBe(0);
  });
});
