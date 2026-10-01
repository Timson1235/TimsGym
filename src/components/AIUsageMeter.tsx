import React from 'react';
import { AIUsage } from '../types';

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

export const AIUsageMeter: React.FC<{ usage: AIUsage; dark?: boolean }> = ({
  usage,
  dark = false,
}) => (
  <p
    className={`text-[10px] font-mono ${dark ? 'text-slate-400' : 'text-slate-500'}`}
    title={`${usage.inputTokens.toLocaleString('de-DE')} Input · ${usage.outputTokens.toLocaleString('de-DE')} Output · geschätzte API-Kosten in USD`}
  >
    {usage.totalTokens > 0
      ? `${usage.provider === 'claude' ? 'Claude' : 'Gemini'} · ${formatAIUsage(usage)}`
      : 'Claude Sonnet 5.5 · noch keine Nutzung'}
  </p>
);
