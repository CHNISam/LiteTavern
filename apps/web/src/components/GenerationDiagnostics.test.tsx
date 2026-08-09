import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GenerationDiagnostics } from './GenerationDiagnostics';
import type { GenerationDiagnosticTraceV1 } from '../lib/generation-diagnostics';

const trace: GenerationDiagnosticTraceV1 = {
  trace_version: 1,
  captured_at: '2026-08-09T00:00:00.000Z',
  generation_request_id: 'generation-1',
  client: {
    sse_frame_count: 1,
    delta_count: 1,
    frames: [],
    assembled: { length: 5, utf8_bytes: 5, sha256: 'a'.repeat(64) }
  }
};

describe('GenerationDiagnostics', () => {
  it('stays out of the normal chat UI unless trace mode is explicit', () => {
    render(<GenerationDiagnostics trace={trace} search="" />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows trace readiness without rendering conversation text', () => {
    const { container } = render(
      <GenerationDiagnostics trace={trace} search="?generation_trace=1" />
    );
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByRole('button')).toBeEnabled();
    expect(container.textContent).not.toContain('private reply');
  });
});
