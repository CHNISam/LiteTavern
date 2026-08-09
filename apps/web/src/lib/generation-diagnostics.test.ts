import { describe, expect, it } from 'vitest';
import {
  createGenerationDiagnosticTrace,
  generationDiagnosticsEnabled,
  withRuntimeTraceLayers
} from './generation-diagnostics';

describe('generation diagnostics', () => {
  it('requires an explicit query opt-in', () => {
    expect(generationDiagnosticsEnabled('?generation_trace=1')).toBe(true);
    expect(generationDiagnosticsEnabled('?generation_trace=0')).toBe(false);
    expect(generationDiagnosticsEnabled('')).toBe(false);
  });

  it('keeps raw frame, runtime, and UI text out of the exported package', async () => {
    const trace = await createGenerationDiagnosticTrace({
      generationRequestId: 'generation-1',
      frames: [{ event: 'delta', data: '{"text":"private reply"}', seq: 1 }],
      deltas: ['private reply'],
      now: () => new Date('2026-08-09T00:00:00.000Z')
    });
    const complete = await withRuntimeTraceLayers(trace, 'private reply');

    expect(complete.client.runtime_input).toEqual(complete.client.ui_message);
    expect(JSON.stringify(complete)).not.toContain('private reply');
  });
});
