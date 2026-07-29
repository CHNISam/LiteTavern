import { ApiError, api } from './api';

/**
 * A persona is who the user is inside the story — the name a character calls them and
 * how that character should picture them. It is deliberately not the account: the
 * email, plan and Alpha state shown in the account panel never travel into a prompt.
 */
export interface Persona {
  persona_id: string;
  name: string;
  description: string;
  is_default: boolean;
  updated_at?: string;
}

export interface PersonaDraft {
  name: string;
  description: string;
}

/**
 * True when the deployment this client is talking to has no persona/worldbook API at
 * all (an older LiteTavern Cloud, or the stripped internal gate). A missing route is
 * a reason to hide the feature, never to show the user an error about their data.
 */
export function isFeatureUnavailable(reason: unknown): boolean {
  if (!(reason instanceof ApiError)) return false;
  // The internal gate answers an unknown path with its own NOT_FOUND code; a Cloud
  // build older than this feature answers with the framework's bare 404. Both mean
  // the same thing here. A missing *resource* uses RESOURCE_NOT_FOUND instead, and
  // these helpers are only ever applied to collection endpoints.
  return reason.code === 'NOT_FOUND' || reason.status === 404;
}

export async function listPersonas(): Promise<Persona[] | null> {
  try {
    const response = await api<{ personas: Persona[] }>('/v1/personas');
    return response.personas;
  } catch (reason) {
    if (isFeatureUnavailable(reason)) return null;
    throw reason;
  }
}

export async function createPersona(draft: PersonaDraft): Promise<Persona> {
  const response = await api<{ persona: Persona }>('/v1/personas', {
    method: 'POST',
    body: JSON.stringify({ name: draft.name, description: draft.description })
  });
  return response.persona;
}

export async function updatePersona(
  personaId: string,
  patch: Partial<PersonaDraft> & { is_default?: true }
): Promise<Persona> {
  const response = await api<{ persona: Persona }>(`/v1/personas/${personaId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
  return response.persona;
}

export async function deletePersona(personaId: string): Promise<void> {
  await api(`/v1/personas/${personaId}`, { method: 'DELETE' });
}

/** Bind the identity a conversation speaks as; `null` runs it without one. */
export async function bindConversationPersona(
  conversationId: string,
  personaId: string | null
): Promise<void> {
  await api(`/v1/conversations/${conversationId}/persona`, {
    method: 'PUT',
    body: JSON.stringify({ persona_id: personaId })
  });
}

export async function readConversationPersona(
  conversationId: string
): Promise<string | null> {
  try {
    const response = await api<{ conversation?: { persona_id?: string | null } }>(
      `/v1/conversations/${conversationId}`
    );
    return response.conversation?.persona_id ?? null;
  } catch {
    return null;
  }
}
