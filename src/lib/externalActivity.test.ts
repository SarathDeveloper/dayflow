import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_EXTERNAL_MS, beginExternalActivity, consumeExternalResume, endExternalActivity, finishExternalResume,
  isExternalActivityActive, resetExternalActivity, shouldIgnorePauseForExternal,
} from './externalActivity';

describe('external activity grace window', () => {
  beforeEach(() => resetExternalActivity());

  it('does not cover a pause when no picker is open', () => {
    expect(shouldIgnorePauseForExternal(1000)).toBe(false);
    expect(consumeExternalResume(2000)).toBe(false);
  });

  it('covers the pause and the resume while the picker is open (asked by several listeners)', () => {
    beginExternalActivity(1000);
    expect(shouldIgnorePauseForExternal(1500)).toBe(true);
    expect(consumeExternalResume(30_000)).toBe(true);
    expect(consumeExternalResume(30_001)).toBe(true);
    finishExternalResume();
    expect(consumeExternalResume(31_000)).toBe(false);
  });

  it('still covers the resume when the picker change event arrives first', () => {
    beginExternalActivity(0);
    expect(shouldIgnorePauseForExternal(10)).toBe(true);
    endExternalActivity(); // change event before the activity resume
    expect(consumeExternalResume(5_000)).toBe(true);
  });

  it('treats coming back after the window expired as leaving', () => {
    beginExternalActivity(0);
    expect(shouldIgnorePauseForExternal(10)).toBe(true);
    expect(consumeExternalResume(MAX_EXTERNAL_MS + 1)).toBe(false);
  });

  it('never allows a window longer than the maximum', () => {
    beginExternalActivity(0, 60 * 60_000);
    expect(isExternalActivityActive(MAX_EXTERNAL_MS - 1)).toBe(true);
    expect(isExternalActivityActive(MAX_EXTERNAL_MS + 1)).toBe(false);
  });

  it('a pause after the picker finished is a real pause and clears old coverage', () => {
    beginExternalActivity(0);
    shouldIgnorePauseForExternal(5);
    finishExternalResume();
    expect(shouldIgnorePauseForExternal(100)).toBe(false);
    expect(consumeExternalResume(200)).toBe(false);
  });
});
