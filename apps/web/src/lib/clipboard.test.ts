import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else setClipboard(undefined);
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('writes through the async clipboard when it is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    await expect(copyText('你认为呢')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('你认为呢');
  });

  it('falls back to the legacy copy when the clipboard API is missing', async () => {
    setClipboard(undefined);
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    await expect(copyText('你认为呢')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('reports failure instead of copying an empty message', async () => {
    const writeText = vi.fn();
    setClipboard({ writeText });
    await expect(copyText('')).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
