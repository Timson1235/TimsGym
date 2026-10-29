import React, { useEffect, useState } from 'react';
import { fetchExecutionTrace } from '../lib/api';

type Trace = { id:string; thread_id:string; kind:string; name:string; status:string; started_at:number; ended_at:number|null; parent_trace_id:string|null };
type Span = { id:string; parent_span_id:string|null; sequence:number; kind:string; name:string; status:string; started_at:number; ended_at:number|null; input_payload_id:string|null; output_payload_id:string|null; error_type:string|null };
type Detail = { trace:Trace; spans:Span[] };
const seconds = (start:number,end:number|null) => `${Math.max(0,(end ?? Date.now()/1000)-start).toFixed(2)} s`;

/** The request is the trace container; number its stages, not the container. */
function hierarchyNumbers(spans: Span[]): Map<string, string> {
  const byId = new Map(spans.map(span => [span.id, span]));
  const wrappers = new Set(spans.filter(span => span.kind === 'request'
    && (!span.parent_span_id || !byId.has(span.parent_span_id))).map(span => span.id));
  const parentOf = (span: Span) => span.parent_span_id && !wrappers.has(span.parent_span_id)
    ? byId.get(span.parent_span_id) : undefined;
  const positions = new Map<string, number>();
  const siblingCounts = new Map<string | null, number>();
  for (const span of [...spans].sort((a, b) => a.sequence - b.sequence)) {
    if (wrappers.has(span.id)) continue;
    const parent = parentOf(span)?.id ?? null;
    const position = (siblingCounts.get(parent) || 0) + 1;
    siblingCounts.set(parent, position);
    positions.set(span.id, position);
  }
  const numbers = new Map<string, string>([...wrappers].map(id => [id, '']));
  const number = (span: Span, ancestors = new Set<string>()): string => {
    if (numbers.has(span.id)) return numbers.get(span.id)!;
    if (ancestors.has(span.id)) return String(span.sequence);
    ancestors.add(span.id);
    const parent = parentOf(span);
    const label = parent ? `${number(parent, ancestors)}.${positions.get(span.id)}` : String(positions.get(span.id));
    numbers.set(span.id, label);
    return label;
  };
  spans.forEach(span => number(span));
  return numbers;
}

function Payload({traceId,id,label,load}:{traceId:string;id:string|null;label:string;load:typeof fetchExecutionTrace}) {
  const [open,setOpen] = useState(false);
  const [data,setData] = useState<unknown>();
  const [error,setError] = useState('');
  useEffect(() => {
    if (!open || !id) return;
    let cancelled = false;
    setData(undefined); setError('');
    load(`/${encodeURIComponent(traceId)}/payload/${encodeURIComponent(id)}`)
      .then(result => {if(!cancelled) setData(result.data);})
      .catch(e => {if(!cancelled) setError(e.message);});
    return () => {cancelled=true;};
  },[traceId,id,open,load]);
  if (!id) return null;
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="mt-2">
    <summary className="cursor-pointer text-sm font-medium">{label}</summary>
    {open && <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-3 text-xs text-slate-100">{error || (data === undefined ? 'Loading…' : JSON.stringify(data,null,2))}</pre>}
  </details>;
}

export function ExecutionTraces({load=fetchExecutionTrace}:{load?:typeof fetchExecutionTrace}) {
  const [traces,setTraces] = useState<Trace[]>([]);
  const [selected,setSelected] = useState<string|null>(null);
  const [detail,setDetail] = useState<Detail|null>(null);
  const [error,setError] = useState('');
  const [live,setLive] = useState(true);
  const [follow,setFollow] = useState(true);
  const [filter,setFilter] = useState('');
  const [exporting,setExporting] = useState(false);
  useEffect(() => {
    let cancelled=false;
    let timer:ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await load();
        if(cancelled) return;
        setTraces(result.traces); setError('');
        setSelected(value => follow ? result.traces[0]?.id || null : value || result.traces[0]?.id || null);
      } catch(e) {if(!cancelled) setError((e as Error).message);}
      if(!cancelled && live) timer=setTimeout(refresh,2000);
    };
    void refresh();
    return () => {cancelled=true; clearTimeout(timer);};
  },[load,live,follow]);
  useEffect(() => {
    let cancelled=false;
    let timer:ReturnType<typeof setTimeout>;
    setDetail(null);
    if(!selected) return;
    const refresh = async () => {
      try {
        const result = await load(`/${encodeURIComponent(selected)}`);
        if(cancelled) return;
        setDetail(result);
      } catch(e) {if(!cancelled) setError((e as Error).message);}
      if(!cancelled && live) timer=setTimeout(refresh,1000);
    };
    void refresh();
    return () => {cancelled=true;clearTimeout(timer);};
  },[selected,load,live]);
  const download = async () => {
    if(!selected || exporting) return;
    setExporting(true);
    try {
      const result = await load(`/${encodeURIComponent(selected)}?payloads=true`);
      const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download=`trace-${selected}.json`;link.click();
      setTimeout(() => URL.revokeObjectURL(url),1000);
    } catch(e) {setError((e as Error).message);}
    finally {setExporting(false);}
  };
  const spanNumbers = hierarchyNumbers(detail?.spans || []);
  return <main className="mx-auto max-w-7xl p-4 text-slate-800 sm:p-6">
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div><a href="/" className="text-sm text-brand-700">← Back to TimsGym</a><h1 className="mt-2 text-2xl font-semibold">Execution traces</h1>
        <p className="text-sm text-slate-500">Your private execution records. Payloads load when expanded. Keep this tab open alongside the coach.</p></div>
      <div className="flex flex-wrap gap-4"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={follow} onChange={e=>setFollow(e.target.checked)}/>Follow newest trace</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={live} onChange={e=>setLive(e.target.checked)}/>Live updates</label></div>
    </header>
    {error && <p role="alert" className="mb-3 rounded bg-rose-50 p-3 text-rose-700">{error}</p>}
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="rounded-xl border bg-white p-3">
        <input aria-label="Filter traces" placeholder="Filter by ID, chat, status…" className="mb-3 w-full rounded border p-2 text-sm" value={filter} onChange={e=>setFilter(e.target.value)}/>
        <div className="max-h-[75vh] space-y-2 overflow-auto">{traces.filter(t=>`${t.id} ${t.thread_id} ${t.kind} ${t.status}`.toLowerCase().includes(filter.toLowerCase())).map(t =>
          <button key={t.id} onClick={()=>{setFollow(false);setSelected(t.id);}} className={`w-full rounded-lg border p-3 text-left text-sm ${selected===t.id?'border-brand-600 bg-brand-50':'border-slate-200'}`}>
            <span className="flex justify-between gap-2 font-medium"><span>{t.name}</span><span className={t.status==='running'?'text-amber-700':''}>{t.status}</span></span>
            <span className="mt-1 block text-xs text-slate-500">{new Date(t.started_at*1000).toLocaleString()} · {seconds(t.started_at,t.ended_at)}</span>
            <span className="block truncate font-mono text-xs">{t.id}</span>
          </button>)}{!traces.length && <p className="text-sm text-slate-500">No traces yet. Send a coach message in the app.</p>}</div>
      </aside>
      <section className="min-w-0 rounded-xl border bg-white p-4">
        {detail ? <>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-2"><div><h2 className="font-semibold">{detail.trace.name} · {detail.trace.status}</h2>
            <p className="break-all font-mono text-xs text-slate-500">{detail.trace.id}</p>
            {detail.trace.parent_trace_id && <button className="text-sm text-brand-700 underline" onClick={()=>{setFollow(false);setSelected(detail.trace.parent_trace_id);}}>Open originating chat trace</button>}</div>
            <button disabled={exporting} onClick={download} className="app-secondary rounded-lg px-3 py-2 text-sm">{exporting?'Exporting…':'Export JSON'}</button></div>
          {!detail.spans.length && <p className="text-sm text-slate-500">Waiting for the first span…</p>}
          <div className="space-y-3">{detail.spans.map(span => {
            let depth=0, parent=span.parent_span_id;
            const visited=new Set<string>();
            while(parent && !visited.has(parent)) {visited.add(parent);depth++;parent=detail.spans.find(s=>s.id===parent)?.parent_span_id ?? null;}
            return <article key={span.id} className="rounded-lg border border-slate-200 p-3" style={{marginLeft:Math.min(depth,4)*12}}>
              <div className="flex flex-wrap justify-between gap-2 text-sm"><strong>{spanNumbers.get(span.id) ? `${spanNumbers.get(span.id)} ` : ''}{span.name}</strong><span className={span.status==='error'?'text-rose-700':span.status==='running'?'text-amber-700':'text-slate-500'}>{span.status} · {seconds(span.started_at,span.ended_at)}</span></div>
              <p className="text-xs text-slate-500">{span.kind}{span.error_type ? ` · ${span.error_type}`:''}</p>
              <Payload load={load} traceId={detail.trace.id} id={span.input_payload_id} label="Input"/>
              <Payload load={load} traceId={detail.trace.id} id={span.output_payload_id} label={span.status==='running'?'Output so far':'Output'}/>
            </article>;
          })}</div>
        </> : <p className="text-sm text-slate-500">{selected?'Loading trace…':'Select a trace to inspect it.'}</p>}
      </section>
    </div>
  </main>;
}
