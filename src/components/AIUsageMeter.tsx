import React from 'react';
import { AIUsage, AIUsageSummary } from '../types';

export const EMPTY_AI_USAGE: AIUsage = {
  provider: 'claude',
  model: 'claude-haiku-5-5',
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
    provider: !current.totalTokens || current.provider === next.provider ? next.provider : 'mixed',
    model: next.model,
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    cacheCreationTokens: current.cacheCreationTokens + next.cacheCreationTokens,
    cacheReadTokens: current.cacheReadTokens + next.cacheReadTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    estimatedCostUsd: current.estimatedCostUsd == null || next.estimatedCostUsd == null ? null : current.estimatedCostUsd + next.estimatedCostUsd,
    knownCostUsd: (current.knownCostUsd ?? current.estimatedCostUsd ?? 0) + (next.knownCostUsd ?? next.estimatedCostUsd ?? 0),
    usageComplete: current.usageComplete !== false && next.usageComplete !== false,
  };
}

export function formatCost(usage: {estimatedCostUsd: number | null; knownCostUsd?: number}): string {
  return usage.estimatedCostUsd == null
    ? `Kosten unvollständig${usage.knownCostUsd ? ` (bekannt ~$${usage.knownCostUsd.toFixed(4)})` : ''}`
    : `~$${usage.estimatedCostUsd.toFixed(4)}`;
}

export function formatAIUsage(usage: AIUsage): string {
  const tokens = usage.totalTokens.toLocaleString('de-DE');
  return `${usage.usageComplete === false ? "mind. " : ""}${tokens} Tokens · ${formatCost(usage)}`;
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
        className={`text-xs font-mono leading-tight ${dark ? 'text-slate-400' : 'text-slate-500'}`}
        title={`${total.requests} Requests seit Tracking-Start · ${total.inputTokens.toLocaleString('de-DE')} Input · ${total.outputTokens.toLocaleString('de-DE')} Output · geschätzte API-Kosten in USD`}
      >
        <p>Gesamt: {total.totalTokens.toLocaleString('de-DE')} Tokens · {formatCost(total)}</p>
        <p className={dark ? 'text-slate-500' : 'text-slate-400'}>
          Dieser Monat: {month.totalTokens.toLocaleString('de-DE')} · {formatCost(month)}
        </p>
      </div>
    );
  }
  return (
    <p
      className={`text-xs font-mono ${dark ? 'text-slate-400' : 'text-slate-500'}`}
      title={`${usage.inputTokens.toLocaleString('de-DE')} Input · ${usage.outputTokens.toLocaleString('de-DE')} Output · geschätzte API-Kosten in USD`}
    >
      {usage.totalTokens > 0
        ? `${usage.provider === 'mixed' ? 'Claude + Gemini' : usage.provider === 'claude' ? 'Claude' : 'Gemini'} · ${formatAIUsage(usage)}`
        : 'Noch keine Nutzung'}
    </p>
  );
};
