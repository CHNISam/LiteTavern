import { Download, ShieldCheck } from 'lucide-react';
import { useT } from '../lib/i18n';
import {
  downloadGenerationTrace,
  generationDiagnosticsEnabled,
  type GenerationDiagnosticTraceV1
} from '../lib/generation-diagnostics';

/** Visible only under `?generation_trace=1`; normal chat never pays this UI cost. */
export function GenerationDiagnostics({
  trace,
  search
}: {
  trace: GenerationDiagnosticTraceV1 | null;
  search?: string;
}) {
  const t = useT();
  if (!generationDiagnosticsEnabled(search)) return null;
  return (
    <aside className="generation-diagnostics" role="status">
      <ShieldCheck size={16} aria-hidden="true" />
      <span>{trace ? t.diagnostics.traceReady : t.diagnostics.traceWaiting}</span>
      <button
        type="button"
        disabled={!trace}
        onClick={() => trace && downloadGenerationTrace(trace)}
        aria-label={t.diagnostics.exportTrace}
      >
        <Download size={15} aria-hidden="true" />
        {t.diagnostics.exportTrace}
      </button>
    </aside>
  );
}
