import { collectCorpusChunks } from './corpus.js';
import { createEmbedder } from './embedders/index.js';
import { ChunkStore } from './store.js';

export async function buildIndex(config, options = {}) {
  const embedder = options.embedder || createEmbedder(config.embedder);
  const store = options.store || new ChunkStore(config.indexPath);
  const closeStore = !options.store;
  const { chunks, files } = collectCorpusChunks(config);

  try {
    store.initialize(embedder);
    const vectorsByChunk = await embedChangedChunks(store, chunks, embedder, config, options);
    const result = store.replaceCorpus(chunks, embedder.id(), vectorsByChunk);
    return {
      ...result,
      files: files.length,
      embedderId: embedder.id(),
      dimension: embedder.dimension()
    };
  } finally {
    if (closeStore) store.close();
  }
}

async function embedChangedChunks(store, chunks, embedder, config, options = {}) {
  const vectors = new Array(chunks.length);
  const changed = [];
  const changedIndexes = [];
  const batchSize = Math.max(1, Number(config.embedder?.batchSize) || changed.length || 1);
  const yieldAfterBatch = options.yieldAfterBatch || (() => new Promise(resolve => setImmediate(resolve)));

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const existing = store.getChunk(chunk.id);
    const existingEmbedding = existing?.embeddings?.find(item => item.embedder_id === embedder.id());
    if (existing && existing.hash === chunk.hash && existingEmbedding?.vector) {
      vectors[index] = [existingEmbedding.vector];
      continue;
    }
    changed.push(chunk.text);
    changedIndexes.push(index);
  }

  for (let start = 0; start < changed.length; start += batchSize) {
    const batch = changed.slice(start, start + batchSize);
    const embedded = await embedder.embed(batch, 'passage');
    for (let i = 0; i < embedded.length; i += 1) {
      vectors[changedIndexes[start + i]] = [embedded[i]];
    }
    if (start + batchSize < changed.length) await yieldAfterBatch();
  }

  return vectors;
}

export async function queryIndex(config, query, options = {}) {
  const embedder = options.embedder || createEmbedder(config.embedder);
  const store = options.store || new ChunkStore(config.indexPath);
  const closeStore = !options.store;
  try {
    store.initialize(embedder);
    const [vector] = await embedder.embed([query], 'query');
    return store.search(vector, { topK: options.topK || config.retrieval.topK });
  } finally {
    if (closeStore) store.close();
  }
}
