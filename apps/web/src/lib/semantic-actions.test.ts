import { describe, expect, it } from 'vitest';

import { parseSemanticTurnV1 } from './semantic-actions';

describe('SemanticTurnV1', () => {
  it.each([1, 2, 4])('accepts %s canonical text actions when policy permits them', (count) => {
    const actions = Array.from({ length: count }, (_, index) => ({
      action_id: `message-${index}`,
      type: 'text',
      content: `bubble ${index}`
    }));
    expect(parseSemanticTurnV1({ protocol_version: 1, turn_id: 'turn-1', actions }, count).actions)
      .toHaveLength(count);
  });

  it('rejects overflow, duplicate ids, and extra model fields', () => {
    const action = { action_id: 'message-1', type: 'text', content: 'hello' };
    expect(() => parseSemanticTurnV1({
      protocol_version: 1,
      turn_id: 'turn-1',
      actions: [action, { ...action }]
    }, 1)).toThrowError(/TURN_FORMAT_INVALID/);
    expect(() => parseSemanticTurnV1({
      protocol_version: 1,
      turn_id: 'turn-1',
      actions: [action, { ...action }]
    }, 2)).toThrowError(/TURN_FORMAT_INVALID/);
    expect(() => parseSemanticTurnV1({
      protocol_version: 1,
      turn_id: 'turn-1',
      actions: [{ ...action, timing: 500 }]
    })).toThrowError(/TURN_FORMAT_INVALID/);
  });
});
