export interface TextFingerprint {
  length: number;
  utf8_bytes: number;
  sha256: string;
}

export interface SseFrameFingerprint extends TextFingerprint {
  index: number;
  event: string;
  seq?: number;
}

export interface GenerationDiagnosticTraceV1 {
  trace_version: 1;
  captured_at: string;
  generation_request_id?: string;
  server?: Record<string, unknown>;
  client: {
    sse_frame_count: number;
    delta_count: number;
    frames: SseFrameFingerprint[];
    assembled: TextFingerprint;
    runtime_input?: TextFingerprint;
    ui_message?: TextFingerprint;
  };
}

export function generationDiagnosticsEnabled(
  search = typeof window === 'undefined' ? '' : window.location.search
): boolean {
  return new URLSearchParams(search).get('generation_trace') === '1';
}

export async function withRuntimeTraceLayers(
  trace: GenerationDiagnosticTraceV1,
  text: string
): Promise<GenerationDiagnosticTraceV1> {
  const value = await fingerprintText(text);
  return {
    ...trace,
    client: { ...trace.client, runtime_input: value, ui_message: value }
  };
}

export function downloadGenerationTrace(trace: GenerationDiagnosticTraceV1): void {
  const blob = new Blob([JSON.stringify(trace, null, 2)], {
    type: 'application/json;charset=utf-8'
  });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const id = trace.generation_request_id ?? 'unknown';
  anchor.href = href;
  anchor.download = `litetavern-generation-trace-${id}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

const encoder = new TextEncoder();

export async function fingerprintText(value: string): Promise<TextFingerprint> {
  const bytes = encoder.encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return {
    length: value.length,
    utf8_bytes: bytes.byteLength,
    sha256: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  };
}

export async function createGenerationDiagnosticTrace(input: {
  generationRequestId?: string;
  server?: Record<string, unknown>;
  frames: Array<{ event: string; data: string; seq?: number }>;
  deltas: string[];
  now?: () => Date;
}): Promise<GenerationDiagnosticTraceV1> {
  const frameFingerprints = await Promise.all(input.frames.map(async (frame, index) => ({
    index: index + 1,
    event: frame.event,
    ...(frame.seq === undefined ? {} : { seq: frame.seq }),
    ...(await fingerprintText(frame.data))
  })));
  return {
    trace_version: 1,
    captured_at: (input.now ?? (() => new Date()))().toISOString(),
    ...(input.generationRequestId
      ? { generation_request_id: input.generationRequestId }
      : {}),
    ...(input.server ? { server: input.server } : {}),
    client: {
      sse_frame_count: frameFingerprints.length,
      delta_count: input.deltas.length,
      frames: frameFingerprints,
      assembled: await fingerprintText(input.deltas.join(''))
    }
  };
}
