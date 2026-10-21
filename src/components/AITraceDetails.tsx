import React from 'react';
import { Clock3 } from 'lucide-react';
import { AITrace } from '../types';

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  })} s`;
}

export const AITraceDetails: React.FC<{ trace: AITrace; dark?: boolean }> = ({
  trace,
  dark = false,
}) => {
  const maxDuration = Math.max(...trace.steps.map((step) => step.durationMs), 1);
  const overheadMs = Math.max((trace.roundTripMs || trace.totalMs) - trace.totalMs, 0);

  return (
    <details className={`mt-2 border-t pt-1.5 ${dark ? 'border-slate-800' : 'border-slate-100'}`}>
      <summary
        className={`cursor-pointer list-none flex items-center gap-1.5 text-xs font-mono ${
          dark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600'
        }`}
      >
        <Clock3 className="h-3 w-3" />
        <span>
          {formatDuration(trace.roundTripMs || trace.totalMs)} · {trace.agentSteps} Agent-
          {trace.agentSteps === 1 ? 'Schritt' : 'Schritte'}
          {trace.slowestStep ? ` · langsamste Phase: ${trace.slowestStep.name}` : ''}
        </span>
      </summary>

      <div className="mt-2 space-y-1.5">
        {trace.providerFallback && (
          <div className="text-xs text-amber-700">
            {trace.providerFallback.from} → {trace.providerFallback.to}: {trace.providerFallback.reason === 'timeout' ? 'Zeitlimit erreicht' : 'Anbieterfehler'}
          </div>
        )}
        {trace.firstTextMs != null && (
          <div className="text-xs text-slate-500">Erster Text nach {formatDuration(trace.firstTextMs)}</div>
        )}
        {trace.steps.map((step, index) => (
          <div key={`${step.kind}-${step.name}-${index}`} className="grid grid-cols-[minmax(0,1fr)_48px] gap-2 items-center">
            <div className="min-w-0">
              <div className={`flex justify-between gap-2 text-xs ${dark ? 'text-slate-400' : 'text-slate-500'}`}>
                <span className="truncate">{step.name}</span>
                <span className="opacity-60">{step.kind}</span>
              </div>
              <div className={`mt-0.5 h-1 overflow-hidden ${dark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                <div
                  className={step.kind === 'llm' ? 'h-full bg-brand-500' : 'h-full bg-amber-400'}
                  style={{ width: `${Math.max((step.durationMs / maxDuration) * 100, 2)}%` }}
                />
              </div>
            </div>
            <span className={`text-right text-xs font-mono ${dark ? 'text-slate-400' : 'text-slate-500'}`}>
              {formatDuration(step.durationMs)}
            </span>
          </div>
        ))}

        <div className={`pt-1 text-xs font-mono ${dark ? 'text-slate-500' : 'text-slate-400'}`}>
          Modell {formatDuration(trace.modelMs)} · Tools {formatDuration(trace.toolMs)} · Server {formatDuration(trace.totalMs)}
          {trace.roundTripMs ? ` · Netzwerk/Overhead ${formatDuration(overheadMs)}` : ''}
        </div>
      </div>
    </details>
  );
};
