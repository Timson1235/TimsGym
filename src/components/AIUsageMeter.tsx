import React from 'react';
import { AIUsage, AIUsageSummary } from '../types';

export const EMPTY_AI_USAGE: AIUsage = {
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
};

export function mergeAIUsage(current: AIUsage, next?: AIUsage): AIUsage {
  if (!next) return current;
  return {
    provider: next.provider,
    model: next.model,
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    cacheCreationTokens: current.cacheCreationTokens + next.cacheCreationTokens,
    cacheReadTokens: current.cacheReadTokens + next.cacheReadTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    estimatedCostUsd: current.estimatedCostUsd + next.estimatedCostUsd,
  };
}

export function formatAIUsage(usage: AIUsage): string {
  const tokens = usage.totalTokens.toLocaleString('de-DE');
  return `${tokens} Tokens · ~$${usage.estimatedCostUsd.toFixed(4)}`;
}

export const AIUsageMeter: React.FC<{ usage: AIUsage; summary?: AIUsageSummary | null; dark?: boolean }> = ({
  usage,
  summary,
  dark = false,
}) => {
  if (summary) {
    const total = summary.allTime;
    const month = summary.currentMonth;
    return (
      <div
        className={`text-[10px] font-mono leading-tight ${dark ? 'text-slate-400' : 'text-slate-500'}`}
        title={`${total.requests} Requests seit Tracking-Start · ${total.inputTokens.toLocaleString('de-DE')} Input · ${total.outputTokens.toLocaleString('de-DE')} Output · geschätzte API-Kosten in USD`}
      >
        <p>Gesamt: {total.totalTokens.toLocaleString('de-DE')} Tokens · ~${total.estimatedCostUsd.toFixed(4)}</p>
        <p className={dark ? 'text-slate-500' : 'text-slate-400'}>
          Dieser Monat: {month.totalTokens.toLocaleString('de-DE')} · ~${month.estimatedCostUsd.toFixed(4)}
        </p>
      </div>
    );
  }
  return (
    <p
      className={`text-[10px] font-mono ${dark ? 'text-slate-400' : 'text-slate-500'}`}
      title={`${usage.inputTokens.toLocaleString('de-DE')} Input · ${usage.outputTokens.toLocaleString('de-DE')} Output · geschätzte API-Kosten in USD`}
    >
      {usage.totalTokens > 0
        ? `${usage.provider === 'claude' ? 'Claude' : 'Gemini'} · ${formatAIUsage(usage)}`
        : 'Claude Sonnet 5.5 · noch keine Nutzung'}
    </p>
  );
};
