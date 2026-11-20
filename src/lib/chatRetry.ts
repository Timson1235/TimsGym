import type { AIChatMessage } from '../types';

export function retryForResponse(text: string, response: {
  status?: string; retrySafe?: boolean; trace?: { terminationReason?: string };
}): AIChatMessage['retry'] {
  const reason = response.trace?.terminationReason;
  return response.status === 'error' || response.status === 'interrupted'
    || ['provider_error', 'empty_response', 'round_limit', 'interrupted'].includes(reason || '')
    ? { text, needsReview: response.retrySafe !== true } : undefined;
}

/** Retain local failure controls only while server history has not resolved the turn. */
export function reconcileRetryHistory(server: AIChatMessage[], cached: AIChatMessage[]): AIChatMessage[] {
  const local = cached.filter((message) => message.id !== 'welcome_msg');
  const same = (a?: AIChatMessage, b?: AIChatMessage) => Boolean(a && b && a.role === b.role && a.content === b.content);
  const result = server.map((message, index) => {
    const saved = local.find((item, position) => item.retry && same(item, message)
      && same(local[position - 1], server[index - 1]));
    return saved ? { ...message, retry: saved.retry } : message;
  });
  const failure = local.at(-1);
  const question = local.at(-2);
  if (!failure?.retry || question?.role !== 'user' || result.some((message) => message.retry)) return result;
  if (same(result.at(-1), question)) return [...result, failure];
  const preceding = local.slice(0, -2);
  if ((!result.length && !preceding.length) || same(result.at(-1), preceding.at(-1))) {
    return [...result, question, failure];
  }
  return result;
}
