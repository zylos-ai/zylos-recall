/**
 * inspect — pair each user prompt in a Claude Code session transcript with the
 * <retrieved-memory> block (recall injection) that actually entered context that turn.
 *
 * Reads Claude Code's OWN transcript (~/.claude/projects/<encoded-cwd>/<session>.jsonl),
 * so it reflects what truly reached the model — independent of the recall component log.
 *
 * NOTE: this is Claude Code-specific (transcript format). Codex transcript support
 * would be a future extension; until then `inspect` only applies on the Claude runtime.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude encodes a project's cwd into the projects dir name by replacing '/' with '-'.
export function defaultProjectDir(cwd = process.cwd(), home = os.homedir()) {
  return path.join(home, '.claude/projects', cwd.replace(/\//g, '-'));
}

export function defaultRetrievalLogPath(home = os.homedir()) {
  return path.join(home, 'zylos/components/recall/logs/retrieval.jsonl');
}

export function resolveTranscript({ session = 'latest', transcriptDir, file } = {}) {
  if (file) return file;
  let dir = transcriptDir || defaultProjectDir();
  if (!fs.existsSync(dir)) {
    // Fall back to the most recently active project dir under ~/.claude/projects.
    const base = path.join(os.homedir(), '.claude/projects');
    if (!fs.existsSync(base)) throw new Error(`No Claude projects dir at ${base}`);
    const dirs = fs.readdirSync(base)
      .map(d => path.join(base, d))
      .filter(d => fs.statSync(d).isDirectory());
    if (!dirs.length) throw new Error(`No project dirs under ${base}`);
    dir = dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  if (!files.length) throw new Error(`No .jsonl transcripts in ${dir}`);
  if (session && session !== 'latest') {
    const match = files.find(f => f.startsWith(session));
    if (!match) throw new Error(`No transcript starting with "${session}" in ${dir}`);
    return path.join(dir, match);
  }
  const newest = files
    .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  return path.join(dir, newest.f);
}

// Human-readable text of a user record, or null if it's a tool result / meta record.
export function promptText(rec) {
  if (rec.isMeta) return null;
  const content = rec.message?.content;
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) {
    if (content.some(p => p?.type === 'tool_result')) return null;
    const text = content.filter(p => p?.type === 'text').map(p => p.text).join('\n').trim();
    return text || null;
  }
  return null;
}

// Strip the C4 envelope so the displayed prompt is the human's actual words.
export function cleanPrompt(text) {
  const cur = String(text).match(/<current-message>\s*([\s\S]*?)\s*<\/current-message>/i);
  let t = cur ? cur[1] : String(text);
  t = t.replace(/\s*----\s*(reply|ack) via:[\s\S]*$/i, '');
  t = t.replace(/^\s*\[[^\]]+\]\s+[^\n]*?\bsaid:\s*/i, '');
  return t.trim();
}

export function isRetrievedMemory(rec) {
  if (rec.type !== 'attachment') return false;
  if (rec.attachment?.type !== 'hook_additional_context') return false;
  const c = rec.attachment.content;
  const joined = Array.isArray(c) ? c.join('\n') : String(c || '');
  return joined.includes('<retrieved-memory');
}

function injectionBlock(rec) {
  const c = rec.attachment.content;
  return Array.isArray(c) ? c.join('\n') : String(c || '');
}

// Extract "[source · date]" chunk headers from a retrieved-memory block.
export function injectionSources(block) {
  const out = [];
  const re = /\[([^\]\n]+?)\s+·\s+([^\]\n]+?)\]/g;
  let m;
  while ((m = re.exec(block))) out.push({ source: m[1], date: m[2] });
  return out;
}

// Parse a transcript into ordered prompt-turns, each with its recall injection (or null).
export function inspectSession(opts = {}) {
  const file = resolveTranscript(opts);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const turns = [];
  let current = null;
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'user') {
      const text = promptText(rec);
      if (text !== null) {
        current = { ts: rec.timestamp || null, prompt: cleanPrompt(text), injection: null };
        turns.push(current);
      }
    } else if (isRetrievedMemory(rec) && current) {
      current.injection = injectionBlock(rec);
    }
  }
  return { file, turns };
}

export function formatInspection({ file, turns }, { last = 12, full = false } = {}) {
  const show = turns.slice(-last);
  const injected = turns.filter(t => t.injection).length;
  const out = [
    `# session: ${path.basename(file)}`,
    `# prompt-turns: ${turns.length} total, showing last ${show.length}`,
    `# injected: ${injected}/${turns.length} turns had a recall block`,
    ''
  ];
  const bar = '──────────────────────────────────────────';
  for (const t of show) {
    const when = t.ts ? new Date(t.ts).toISOString().replace('T', ' ').slice(0, 19) : '(no ts)';
    const msg = t.prompt.replace(/\s+/g, ' ').slice(0, 200);
    out.push(bar);
    out.push(`[${when}] YOU: ${msg}${t.prompt.length > 200 ? ' …' : ''}`);
    if (!t.injection) {
      out.push('   RECALL: (no injection — recall stayed quiet this turn)');
    } else if (full) {
      out.push('   RECALL block:');
      out.push(t.injection.split('\n').map(l => '   | ' + l).join('\n'));
    } else {
      const srcs = injectionSources(t.injection);
      out.push(`   RECALL: injected ${srcs.length} chunk(s):`);
      for (const s of srcs) out.push(`     • ${s.source} (${s.date})`);
    }
  }
  out.push(bar);
  return out.join('\n');
}

export function inspectRetrievalLog({ file = defaultRetrievalLogPath() } = {}) {
  const records = [];
  if (!fs.existsSync(file)) return { file, records };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return { file, records };
}

export function formatRetrievalLogInspection({ file, records }, { last = 20 } = {}) {
  const show = records.slice(-last);
  const serviceCount = records.filter(record => recordKind(record) === 'service').length;
  const clientCount = records.filter(record => recordKind(record) === 'client').length;
  const out = [
    `# retrieval-log: ${path.basename(file)}`,
    `# records: ${records.length} total, showing last ${show.length}`,
    `# service/client: ${serviceCount}/${clientCount}`,
    ''
  ];
  const bar = '──────────────────────────────────────────';
  for (const record of show) {
    out.push(bar);
    const kind = recordKind(record);
    const when = record.ts ? new Date(record.ts).toISOString().replace('T', ' ').slice(0, 19) : '(no ts)';
    const hash = String(record.queryHash || '').slice(0, 12) || '(no hash)';
    if (kind === 'client') {
      out.push(`[${when}] CLIENT ${hash} outcome=${record.outcome || 'unknown'} duration=${formatMs(record.durationMs)}`);
      continue;
    }

    out.push(`[${when}] SERVICE ${hash} injected=${Boolean(record.injected)} duration=${formatMs(record.durationMs)}`);
    if (record.queryPreview) out.push(`   query: ${record.queryPreview}`);
    if (Array.isArray(record.selected)) {
      const selected = record.selected.map(item => {
        const score = item.finalScore ?? item.rankScore ?? item.rerankScore ?? item.score;
        return `${item.id || '?'}:${item.source || '?'}${score === null || score === undefined ? '' : `@${score}`}`;
      });
      out.push(`   selected(${record.selected.length}): ${selected.join(', ') || '(none)'}`);
    }
    for (const stage of Array.isArray(record.stages) ? record.stages : []) {
      out.push(`   ${formatStage(stage)}`);
    }
  }
  out.push(bar);
  return out.join('\n');
}

function recordKind(record) {
  return record.kind === 'client' ? 'client' : 'service';
}

function formatMs(value) {
  return Number.isFinite(Number(value)) ? `${Number(value)}ms` : '?ms';
}

function formatStage(stage) {
  if (!stage || typeof stage !== 'object') return 'stage: (invalid)';
  if (stage.stage === 'denseRetrieve') {
    return `denseRetrieve count=${stage.count ?? stage.candidates ?? 0} candidates=${formatCandidateList(stage.candidates, 'score')}`;
  }
  if (stage.stage === 'rerankFilter') {
    if (stage.enabled === false) return `rerankFilter enabled=false count=${stage.count ?? stage.candidates ?? 0}`;
    return `rerankFilter scored=${stage.scored ?? '?'} kept=${stage.kept ?? '?'} threshold=${stage.threshold ?? '?'} candidates=${formatCandidateList(stage.candidates, 'rerankScore')}`;
  }
  if (stage.stage === 'freeGates') {
    const drops = stage.drops && typeof stage.drops === 'object'
      ? Object.entries(stage.drops).map(([key, value]) => `${key}:${value}`).join(',')
      : '';
    return `freeGates selected=${stage.selected ?? 0} survivors=${formatIds(stage.survivors)} drops=${drops || '(none)'} candidates=${formatGateCandidates(stage.candidates)}`;
  }
  if (stage.stage === 'assemble') {
    return `assemble injected=${Boolean(stage.injected)} bytes=${stage.bytes ?? 0}`;
  }
  return `${stage.stage || 'stage'} ${JSON.stringify(stage)}`;
}

function formatCandidateList(candidates, scoreKey) {
  if (!Array.isArray(candidates)) return '(legacy-count-only)';
  if (!candidates.length) return '(none)';
  return candidates.map(candidate => {
    const score = candidate?.[scoreKey];
    const kept = typeof candidate?.kept === 'boolean' ? ` kept=${candidate.kept}` : '';
    return `${candidate?.id || '?'}${score === null || score === undefined ? '' : `@${score}`}${kept}`;
  }).join(',');
}

function formatGateCandidates(candidates) {
  if (!Array.isArray(candidates)) return '(legacy-count-only)';
  if (!candidates.length) return '(none)';
  return candidates.map(candidate => {
    if (candidate.kept) return `${candidate.id}:kept`;
    return `${candidate.id}:${candidate.dropReason || 'dropped'}`;
  }).join(',');
}

function formatIds(ids) {
  return Array.isArray(ids) && ids.length ? ids.join(',') : '(none)';
}
