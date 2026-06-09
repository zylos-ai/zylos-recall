import { env, LogLevel, pipeline } from '@huggingface/transformers';

const MODE_PREFIX = Object.freeze({
  query: 'query: ',
  passage: 'passage: '
});

export function prefixForMode(mode) {
  if (!MODE_PREFIX[mode]) {
    throw new Error(`Unsupported embedding mode: ${mode}`);
  }
  return MODE_PREFIX[mode];
}

export class LocalOnnxEmbedder {
  constructor(config) {
    this.config = config;
    this.extractor = null;
    env.logLevel = LogLevel.ERROR;
  }

  id() {
    return `local-onnx:${this.config.model}@${this.dimension()}`;
  }

  dimension() {
    return this.config.dimension;
  }

  async load() {
    if (!this.extractor) {
      this.extractor = await pipeline('feature-extraction', this.config.model, {
        cache_dir: this.config.cacheDir
      });
    }
    return this.extractor;
  }

  async embed(texts, mode) {
    if (!Array.isArray(texts)) {
      throw new Error('embed(texts, mode) expects texts to be an array');
    }
    const prefix = prefixForMode(mode);
    const extractor = await this.load();
    const vectors = [];
    const batchSize = this.config.batchSize || 16;

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map(text => `${prefix}${text}`);
      const output = await extractor(batch, { pooling: 'mean', normalize: true });
      const rows = output.tolist();
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== this.dimension()) {
          throw new Error(`Embedder returned dimension ${row?.length ?? 'unknown'}, expected ${this.dimension()}`);
        }
        vectors.push(row.map(Number));
      }
    }

    return vectors;
  }
}
