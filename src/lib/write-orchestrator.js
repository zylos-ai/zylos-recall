export const EXTRACTION_PROMPT = `SYSTEM
You extract atomic memories from a slice of the agent's conversation: read the slice, find
what is worth remembering, and for each, write (a) the SITUATION it should be recalled in
and (b) the condensed fact itself.

Be selective — extract only durable, reusable specifics (facts, decisions, preferences,
states, identifiers, commitments, outcomes). Skip pleasantries and transient chatter.
Quality over quantity; if nothing is worth keeping, return an empty list.

For each memory:
- "key": the SITUATION / NEED in which this memory becomes relevant — written as the
  situation or question the agent/user will be in when they need it, with the cue that
  identifies it. Write it the way that situation will actually present NEXT time
  (query/situation register), at the generality where it matches the recurrence — NOT bound
  to this instance, NOT a title, NOT a restatement of the value. This is the retrieval address.
- "value": the fact itself, condensed and self-contained — what is true / changed / was
  decided, with just enough context to stand alone. Capture the outcome, not the transcript.
  Ground it strictly in the slice; invent nothing.

Return ONLY JSON:
{"memories":[{"key":"<situation/need to recall this>","value":"<condensed self-contained fact>"}]}

USER
Conversation slice:
{segment}`;

export const CONSOLIDATION_PROMPT = `SYSTEM
You are the write-time memory consolidator. A new atomic item has been distilled and keyed.
You are given the new item plus the existing nodes whose keys are nearest (vector neighbors,
with full values). Decide how to fold the new item into the store. Choose ONE operation:
- CREATE : genuinely new — no neighbor covers the same subject/fact.
- UPDATE : a neighbor covers the same subject → fold in, output the FULL new value:
           • new detail on the same fact → merge into one denser value;
           • conflicts with / supersedes the neighbor (fact changed, or old value now wrong)
             → REVISE or REPLACE the stale detail — never keep stale and new side by side.
           Keep that node's id. Prefer the most correct, current information.
- NOOP   : already fully represented by a neighbor (adds nothing) → no change.

Guidelines:
- Judge "same subject" by what the values are ABOUT, not key-string overlap.
- Only UPDATE a node you were given; never invent an id.
- When genuinely unsure between UPDATE and CREATE, choose CREATE (a redundant node is cheaper
  than a merge that buries a distinct fact; near-identical keys stay co-retrievable anyway).
- Do not fabricate detail beyond the new item and the chosen neighbor.
- Salience is handled upstream — do NOT score importance; only fit / dedup / revise.

Return ONLY this JSON:
{"operation":"CREATE|UPDATE|NOOP","target_id":"<id for UPDATE, else null>","value":"<CREATE: new value; UPDATE: full merged/revised value; NOOP: null>","reason":"<one short clause>"}

USER
New item — value: {new_value}
New item — key: {new_key}
Nearest existing nodes (id · key · value):
{neighbors}`;

export async function distillSession({
  messages,
  llmClient,
  topicEngine,
  nodeWriter,
  k = 5,
  maxRepairs = 2
} = {}) {
  assertDependencies({ messages, llmClient, topicEngine, nodeWriter });
  const topK = normalizePositiveInteger(k, 'k');
  const repairs = normalizeNonNegativeInteger(maxRepairs, 'maxRepairs');
  const segmentIndexes = await topicEngine.segment(messages);
  const summary = {
    segments: segmentIndexes.length,
    created: 0,
    updated: 0,
    noop: 0,
    skipped: 0
  };

  for (const indexes of segmentIndexes) {
    const segmentText = buildSegmentText(messages, indexes);
    const extraction = await extractWithRepair(llmClient, segmentText, repairs);
    summary.skipped += extraction.skipped;
    for (const item of extraction.memories) {
      const result = await processMemoryItem({
        item,
        llmClient,
        nodeWriter,
        k: topK,
        maxRepairs: repairs
      });
      if (result.op) summary[summaryKey(result.op)] += 1;
      summary.skipped += result.skipped;
    }
  }

  return summary;
}

function summaryKey(op) {
  if (op === 'CREATE') return 'created';
  if (op === 'UPDATE') return 'updated';
  return 'noop';
}

async function processMemoryItem({ item, llmClient, nodeWriter, k, maxRepairs }) {
  const neighbors = await nodeWriter.searchNeighbors({ key: item.key, k });
  const exact = exactKeyNeighbor(item.key, neighbors);

  if (exact) {
    const decision = await consolidateWithRepair({
      llmClient,
      item,
      neighbors,
      maxRepairs,
      exact
    });
    if (!decision) return { op: null, skipped: 1 };
    if (decision.operation === 'NOOP') {
      await nodeWriter.applyConsolidation({ operation: 'NOOP' });
      return { op: 'NOOP', skipped: 0 };
    }
    await nodeWriter.applyConsolidation({
      operation: 'UPDATE',
      target_id: exact.id,
      value: decision.value || item.value
    });
    return { op: 'UPDATE', skipped: 0 };
  }

  const decision = await consolidateWithRepair({
    llmClient,
    item,
    neighbors,
    maxRepairs
  });
  if (!decision) return { op: null, skipped: 1 };
  if (decision.operation === 'CREATE') decision.key = item.key;
  const applied = await nodeWriter.applyConsolidation(decision);
  return { op: applied.op, skipped: 0 };
}

async function extractWithRepair(llmClient, segmentText, maxRepairs) {
  let last = { memories: [], skipped: 0 };
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const candidate = normalizeExtraction(await llmClient.extract(segmentText));
    if (candidate.valid) return candidate;
    last = candidate;
  }
  return last;
}

async function consolidateWithRepair({ llmClient, item, neighbors, maxRepairs, exact = null }) {
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const candidate = normalizeDecision(
      await llmClient.consolidate(item, neighbors),
      neighbors,
      exact
    );
    if (candidate.valid) return candidate.decision;
  }
  return null;
}

function normalizeExtraction(value) {
  const parsed = parseMaybeJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.memories)) {
    return { valid: false, memories: [], skipped: 1 };
  }

  const memories = [];
  let skipped = 0;
  for (const item of parsed.memories) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      skipped += 1;
      continue;
    }
    const key = normalizeOptionalString(item.key);
    const value = normalizeOptionalString(item.value);
    if (!key || !value) {
      skipped += 1;
      continue;
    }
    memories.push({ key, value });
  }

  return {
    valid: skipped === 0 || memories.length > 0,
    memories,
    skipped
  };
}

function normalizeDecision(value, neighbors, exact) {
  const parsed = parseMaybeJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, decision: null };
  }
  const operation = normalizeOptionalString(parsed.operation)?.toUpperCase();
  if (!['CREATE', 'UPDATE', 'NOOP'].includes(operation)) {
    return { valid: false, decision: null };
  }

  if (operation === 'NOOP') {
    return {
      valid: true,
      decision: { operation: 'NOOP' }
    };
  }

  const valueText = normalizeOptionalString(parsed.value);
  if (!valueText) return { valid: false, decision: null };

  if (exact) {
    return {
      valid: true,
      decision: {
        operation: 'UPDATE',
        target_id: exact.id,
        value: valueText,
        reason: normalizeOptionalString(parsed.reason) || null
      }
    };
  }

  if (operation === 'CREATE') {
    return {
      valid: true,
      decision: {
        operation: 'CREATE',
        key: normalizeOptionalString(parsed.key) || null,
        value: valueText,
        reason: normalizeOptionalString(parsed.reason) || null
      }
    };
  }

  const targetId = normalizeOptionalString(parsed.target_id);
  const allowedIds = new Set(neighbors.map(neighbor => neighbor.id));
  if (!targetId || !allowedIds.has(targetId)) {
    return { valid: false, decision: null };
  }

  return {
    valid: true,
    decision: {
      operation: 'UPDATE',
      target_id: targetId,
      value: valueText,
      reason: normalizeOptionalString(parsed.reason) || null
    }
  };
}

function exactKeyNeighbor(key, neighbors) {
  const normalized = key.toLocaleLowerCase();
  return neighbors.find(neighbor => neighbor.key.toLocaleLowerCase() === normalized) || null;
}

function buildSegmentText(messages, indexes) {
  return indexes.map(index => messageText(messages[index])).filter(Boolean).join('\n\n');
}

function messageText(message) {
  if (typeof message === 'string') return message.trim();
  if (message && typeof message === 'object') {
    return String(message.text ?? message.content ?? message.message ?? '').trim();
  }
  return '';
}

function parseMaybeJson(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function assertDependencies({ messages, llmClient, topicEngine, nodeWriter }) {
  if (!Array.isArray(messages)) throw new Error('distillSession requires messages');
  if (!llmClient || typeof llmClient.extract !== 'function' || typeof llmClient.consolidate !== 'function') {
    throw new Error('distillSession requires llmClient.extract and llmClient.consolidate');
  }
  if (!topicEngine || typeof topicEngine.segment !== 'function') {
    throw new Error('distillSession requires topicEngine.segment');
  }
  if (
    !nodeWriter ||
    typeof nodeWriter.searchNeighbors !== 'function' ||
    typeof nodeWriter.applyConsolidation !== 'function'
  ) {
    throw new Error('distillSession requires nodeWriter search/apply primitives');
  }
}

function normalizePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function normalizeNonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return number;
}
