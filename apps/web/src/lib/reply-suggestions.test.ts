import { describe, expect, it } from 'vitest';

import { suggestionKeyFor } from './reply-suggestions';

describe('suggestionKeyFor', () => {
  it('is stable for one conversation state, so a double press costs once', () => {
    expect(suggestionKeyFor('conv-1', 'msg-9')).toBe(suggestionKeyFor('conv-1', 'msg-9'));
    expect(suggestionKeyFor('conv-1', 'msg-9')).not.toBe(
      suggestionKeyFor('conv-1', 'msg-10')
    );
  });

  it('separates one attempt from the next', () => {
    expect(suggestionKeyFor('conv-1', 'msg-9', 1)).not.toBe(
      suggestionKeyFor('conv-1', 'msg-9')
    );
  });

  it('separates one language from another', () => {
    // Cloud replays a settled key from storage without calling the model. Without
    // the locale in the key, switching the interface to English and pressing 代写
    // again would replay the Chinese candidates bought before the switch — the
    // reader would change the setting and watch nothing happen.
    expect(suggestionKeyFor('conv-1', 'msg-9', 0, 'en')).not.toBe(
      suggestionKeyFor('conv-1', 'msg-9', 0, 'zh-CN')
    );
    expect(suggestionKeyFor('conv-1', 'msg-9', 1, 'en')).not.toBe(
      suggestionKeyFor('conv-1', 'msg-9', 1, 'zh-CN')
    );
  });

  it('leaves the default locale’s keys exactly where they were', () => {
    // Every key already settled in Cloud was written without a locale segment.
    // Appending one unconditionally would invalidate all of them at once and
    // re-charge every reader for candidates they had already bought.
    expect(suggestionKeyFor('conv-1', 'msg-9', 0, 'zh-CN')).toBe('suggest:conv-1:msg-9');
    expect(suggestionKeyFor('conv-1', 'msg-9', 2, 'zh-CN')).toBe('suggest:conv-1:msg-9:2');
    expect(suggestionKeyFor('conv-1', 'msg-9')).toBe('suggest:conv-1:msg-9');
  });

  it('keeps the attempt last, so a retry is still a fresh key in either language', () => {
    expect(suggestionKeyFor('conv-1', 'msg-9', 2, 'en')).toBe('suggest:conv-1:msg-9:en:2');
  });
});
