import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const directGeneration = vi.hoisted(() => vi.fn());
vi.mock('./lib/byok-client', () => ({ streamByokGeneration: directGeneration }));

import { App } from './App';
import { chatRepository, repositoryPartition, resetChatRepositoryForTests } from './lib/chat-repository';
import { credentialStore } from './lib/credential-store';
import { modelConfigurationStore } from './lib/model-configuration-store';
import { writeModelPreference } from './lib/model-preference';

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem('litetavern.device-id.v1', 'device-1');
  const partition = repositoryPartition({
    environment: window.location.origin,
    principal: 'guest:device-1'
  });
  const character = {
    character_id: 'nova-card', name: 'Nova', profile_summary: 'Pilot',
    personality_summary: 'Calm', first_message: '', avatar_seed: 'Nova',
    is_owned: true, last_message: null
  };
  await chatRepository.replaceCharacters(partition, [character]);
  await chatRepository.openConversation(partition, {
    conversationId: 'local-conversation-1', characterId: character.character_id, source: 'LOCAL'
  });
  const credential = await credentialStore.save({
    provider: 'openai', label: 'Personal OpenAI', apiKey: 'sk-browser-only'
  });
  const configuration = await modelConfigurationStore.save({
    provider: 'openai', model_name: 'gpt-4.1-mini', display_name: 'Personal OpenAI',
    base_url: 'https://api.openai.com/v1', credential_id: credential.credentialId
  });
  writeModelPreference({ usageMode: 'BYOK', configurationId: configuration.model_configuration_id });
  directGeneration.mockImplementation(async (input, options) => {
    options?.onDelta?.('Direct reply');
    expect(input.apiKey).toBe('sk-browser-only');
    expect(input.input).toBe('Private prompt');
    return 'Direct reply';
  });
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  directGeneration.mockReset();
  await Promise.all([
    resetChatRepositoryForTests(),
    credentialStore.reset(),
    modelConfigurationStore.reset()
  ]);
  localStorage.clear();
});

it('sends BYOK prompts only to the browser adapter when Cloud is unreachable', async () => {
  const cloudRequests: Array<{ url: string; body: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    cloudRequests.push({ url: String(input), body: String(init?.body ?? '') });
    return Promise.reject(new TypeError('Cloud unavailable'));
  });

  const firstMount = render(<App />);
  const composer = await screen.findByPlaceholderText(/Nova/);
  await screen.findByRole('combobox');
  fireEvent.change(composer, { target: { value: 'Private prompt' } });
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

  expect(await screen.findByText('Direct reply', { selector: '.message-bubble' })).toBeInTheDocument();
  expect(directGeneration).toHaveBeenCalledOnce();
  const serializedCloud = JSON.stringify(cloudRequests);
  expect(serializedCloud).not.toContain('sk-browser-only');
  expect(serializedCloud).not.toContain('Private prompt');
  expect(serializedCloud).not.toContain('/generations');
  expect(serializedCloud).not.toContain('/client-turns');

  firstMount.unmount();
  render(<App />);
  expect(
    await screen.findByText('Direct reply', { selector: '.message-bubble' })
  ).toBeInTheDocument();
  expect(screen.getByText('Private prompt', { selector: '.message-bubble' }))
    .toBeInTheDocument();
  expect(directGeneration).toHaveBeenCalledOnce();
});
