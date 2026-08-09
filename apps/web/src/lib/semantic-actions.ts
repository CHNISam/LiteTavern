export const SEMANTIC_ACTION_POLICY_V1 = Object.freeze({
  policyVersion: 'semantic_action_policy_v1',
  maxActions: 4 as number
});

export interface SemanticTextAction {
  action_id: string;
  type: 'text';
  content: string;
}

export interface SemanticTurnV1 {
  protocol_version: 1;
  turn_id: string;
  actions: SemanticTextAction[];
}

export function parseSemanticTurnV1(
  value: unknown,
  maxActions: number = SEMANTIC_ACTION_POLICY_V1.maxActions
): SemanticTurnV1 {
  if (!value || typeof value !== 'object') throw new Error('TURN_FORMAT_INVALID');
  const candidate = value as Record<string, unknown>;
  if (
    candidate.protocol_version !== 1 ||
    typeof candidate.turn_id !== 'string' ||
    !candidate.turn_id ||
    !Array.isArray(candidate.actions) ||
    candidate.actions.length < 1 ||
    candidate.actions.length > maxActions ||
    Object.keys(candidate).some((key) => !['protocol_version', 'turn_id', 'actions', 'quota'].includes(key))
  ) {
    throw new Error('TURN_FORMAT_INVALID');
  }
  const actions = candidate.actions.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('TURN_FORMAT_INVALID');
    const action = value as Record<string, unknown>;
    if (
      action.type !== 'text' ||
      typeof action.action_id !== 'string' ||
      !action.action_id ||
      typeof action.content !== 'string' ||
      !action.content.trim() ||
      Object.keys(action).some((key) => !['action_id', 'type', 'content'].includes(key))
    ) {
      throw new Error('TURN_FORMAT_INVALID');
    }
    return {
      action_id: action.action_id,
      type: 'text' as const,
      content: action.content.trim()
    };
  });
  if (new Set(actions.map((action) => action.action_id)).size !== actions.length) {
    throw new Error('TURN_FORMAT_INVALID');
  }
  return {
    protocol_version: 1,
    turn_id: candidate.turn_id,
    actions
  };
}
