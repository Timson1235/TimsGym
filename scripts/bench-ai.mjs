// Benchmark Gemini call configurations to find the latency cause.
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function time(label, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const text = (r.text || '').slice(0, 40).replace(/\n/g, ' ');
    console.log(`  ${secs}s  ${label}  ->  "${text}"`);
  } catch (e) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ${secs}s  ${label}  ->  ERROR: ${e.message?.slice(0, 80)}`);
  }
}

console.log('Benchmarking (each = one simple "say hi" call):\n');

await time("gemini-3.6-flash  bare", () =>
  ai.models.generateContent({ model: 'gemini-3.6-flash', contents: 'Say hi in 3 words.' })
);

await time("gemini-3.6-flash  thinkingBudget=0", () =>
  ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: 'Say hi in 3 words.',
    config: { thinkingConfig: { thinkingBudget: 0 } },
  })
);

await time("gemini-2.5-flash  bare", () =>
  ai.models.generateContent({ model: 'gemini-2.5-flash', contents: 'Say hi in 3 words.' })
);

await time("gemini-2.5-flash  thinkingBudget=0", () =>
  ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: 'Say hi in 3 words.',
    config: { thinkingConfig: { thinkingBudget: 0 } },
  })
);

await time("gemini-2.0-flash  bare", () =>
  ai.models.generateContent({ model: 'gemini-2.0-flash', contents: 'Say hi in 3 words.' })
);

console.log('\nDone.');
