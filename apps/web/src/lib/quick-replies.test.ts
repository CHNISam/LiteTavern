import { afterEach, describe, expect, it } from 'vitest';
import {
  moveQuickReply,
  readQuickReplySettings,
  writeQuickReplySettings
} from './quick-replies';

afterEach(() => localStorage.clear());

describe('quick reply settings', () => {
  it('persists a bounded, trimmed set of browser-local replies', () => {
    writeQuickReplySettings({
      enabled: true,
      behavior: 'FILL',
      replies: [
        { id: 'one', label: '  Agree  ', message: '  I agree.  ', enabled: true },
        { id: 'two', label: '', message: 'Later', enabled: false }
      ]
    });

    expect(readQuickReplySettings()).toEqual({
      enabled: true,
      behavior: 'FILL',
      replies: [
        { id: 'one', label: 'Agree', message: 'I agree.', enabled: true },
        { id: 'two', label: 'Later', message: 'Later', enabled: false }
      ]
    });
  });

  it('falls back safely when storage is malformed', () => {
    localStorage.setItem('litetavern.quick-replies.v1', '{bad json');

    expect(readQuickReplySettings()).toEqual({
      enabled: true,
      behavior: 'FILL',
      replies: []
    });
  });

  it('moves replies without changing their identity', () => {
    const replies = [
      { id: 'one', label: 'One', message: '1', enabled: true },
      { id: 'two', label: 'Two', message: '2', enabled: true },
      { id: 'three', label: 'Three', message: '3', enabled: true }
    ];

    expect(moveQuickReply(replies, 'two', -1).map((reply) => reply.id))
      .toEqual(['two', 'one', 'three']);
    expect(moveQuickReply(replies, 'one', -1)).toEqual(replies);
  });
});
