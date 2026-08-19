// Probe WHY gemini-3.6-flash is slow: capture hidden "thinking" token usage.
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function probe(label, model, config) {
  const t0 = Date.now();
  try {
    const r = await ai.models.generateContent({ model, contents: 'Say hi in 3 words.', config });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const u = r.usageMetadata || {};
    console.log(`\n${label}  (${secs}s)`);
    console.log(`  reply:            "${(r.text || '').replace(/\n/g, ' ').slice(0, 40)}"`);
    console.log(`  prompt tokens:    ${u.promptTokenCount ?? '?'}`);
    console.log(`  THINKING tokens:  ${u.thoughtsTokenCount ?? 0}   <-- hidden reasoning`);
    console.log(`  answer tokens:    ${u.candidatesTokenCount ?? '?'}`);
    console.log(`  total tokens:     ${u.totalTokenCount ?? '?'}`);
  } catch (e) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n${label}  (${secs}s)  ERROR: ${String(e.message).slice(0, 90)}`);
  }
}

await probe('gemini-3.6-flash  (default)', 'gemini-3.6-flash', undefined);
await probe('gemini-3.6-flash  (thinkingBudget: 256)', 'gemini-3.6-flash', { thinkingConfig: { thinkingBudget: 256 } });
await probe('gemini-2.5-flash  (thinkingBudget: 0)', 'gemini-2.5-flash', { thinkingConfig: { thinkingBudget: 0 } });
