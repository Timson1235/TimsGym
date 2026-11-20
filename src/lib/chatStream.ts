export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'status'; message: string }
  | { type: 'reset' }
  | { type: 'final'; result: any }
  | { type: 'error'; message: string };

/** Decode arbitrary network chunks, including split UTF-8 and SSE frames. */
export async function readChatStream(response: Response, onEvent: (event: ChatStreamEvent) => void) {
  if (!response.body) throw new Error('Streaming response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue; // Heartbeat/comment.
        const event = JSON.parse(data) as ChatStreamEvent;
        if (event.type === 'error') throw new Error(event.message);
        if (event.type === 'final') return event.result;
        onEvent(event);
      }
      if (done) throw new Error('Connection ended before the coach confirmed completion. Reload the chat and check your workout before retrying.');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
