import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AppSettingsPanel } from './AppSettingsPanel';
import {
  readQuickReplySettings,
  writeQuickReplySettings,
  type QuickReplySettings
} from '../lib/quick-replies';
import {
  DEFAULT_REPLY_SUGGESTIONS_SETTINGS,
  readReplySuggestionsSettings,
  writeReplySuggestionsSettings,
  type ReplySuggestionsSettings
} from '../lib/reply-suggestions';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function SettingsHarness() {
  const [settings, setSettings] = useState<QuickReplySettings>({
    enabled: true,
    behavior: 'FILL',
    replies: []
  });
  const [suggestions, setSuggestions] = useState<ReplySuggestionsSettings>(
    DEFAULT_REPLY_SUGGESTIONS_SETTINGS
  );
  return (
    <AppSettingsPanel
      open
      onClose={() => undefined}
      onImport={() => undefined}
      onMigrate={() => undefined}
      onPersonas={() => undefined}
      onWorldbooks={() => undefined}
      onFeedback={() => undefined}
      quickReplies={settings}
      onQuickRepliesChange={(next) => {
        setSettings(next);
        writeQuickReplySettings(next);
      }}
      replySuggestions={suggestions}
      onReplySuggestionsChange={(next) => {
        setSuggestions(next);
        writeReplySuggestionsSettings(next);
      }}
    />
  );
}

it('creates and persists a direct-send quick reply from settings', () => {
  render(<SettingsHarness />);
  fireEvent.click(screen.getByRole('button', { name: /快捷回复|Quick replies/ }));
  fireEvent.click(screen.getByRole('button', { name: /添加快捷回复|Add quick reply/ }));

  fireEvent.change(screen.getByLabelText(/快捷回复 1 标签|Quick reply 1 label/), {
    target: { value: 'Agree' }
  });
  fireEvent.change(screen.getByLabelText(/快捷回复 1 消息|Quick reply 1 message/), {
    target: { value: 'I agree.' }
  });
  // Named explicitly: the panel has a second select since reply suggestions gained a
  // trigger, and an unnamed lookup would now match both.
  fireEvent.change(
    screen.getByRole('combobox', { name: /点击按钮时|When clicked/ }),
    { target: { value: 'SEND' } }
  );

  expect(readQuickReplySettings()).toMatchObject({
    enabled: true,
    behavior: 'SEND',
    replies: [{ label: 'Agree', message: 'I agree.', enabled: true }]
  });
});

it('persists the reply-suggestions trigger, and defaults to manual', () => {
  // Manual is the default because automatic spends an extra allowance unit per reply.
  // A reader who never opens this panel must never be opted into that.
  expect(readReplySuggestionsSettings().trigger).toBe('MANUAL');

  render(<SettingsHarness />);
  fireEvent.click(screen.getByRole('button', { name: /快捷回复|Quick replies/ }));
  fireEvent.change(
    screen.getByRole('combobox', { name: /AI 回复建议|AI reply suggestions/ }),
    { target: { value: 'AUTOMATIC' } }
  );

  expect(readReplySuggestionsSettings().trigger).toBe('AUTOMATIC');
});
