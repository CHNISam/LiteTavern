import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AppSettingsPanel } from './AppSettingsPanel';
import {
  readQuickReplySettings,
  writeQuickReplySettings,
  type QuickReplySettings
} from '../lib/quick-replies';

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
  fireEvent.change(screen.getByRole('combobox'), {
    target: { value: 'SEND' }
  });

  expect(readQuickReplySettings()).toMatchObject({
    enabled: true,
    behavior: 'SEND',
    replies: [{ label: 'Agree', message: 'I agree.', enabled: true }]
  });
});
