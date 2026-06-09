import { AutoModelForSequenceClassification, AutoTokenizer, env, LogLevel } from '@huggingface/transformers';

const PRETOKENIZE_CHARS_PER_TOKEN = 6;

export class LocalOnnxReranker {
  constructor(config) {
    this.config = config;
    this.tokenizer = null;
    this.model = null;
    this.loading = null;
    env.logLevel = LogLevel.ERROR;
  }

  id() {
    return `local-onnx-reranker:${this.config.model}:${this.config.dtype}`;
  }

  async load() {
    if (this.tokenizer && this.model) return { tokenizer: this.tokenizer, model: this.model };
    if (!this.loading) {
      this.loading = Promise.all([
        AutoTokenizer.from_pretrained(this.config.model, {
          cache_dir: this.config.cacheDir
        }),
        AutoModelForSequenceClassification.from_pretrained(this.config.model, {
          cache_dir: this.config.cacheDir,
          dtype: this.config.dtype
        })
      ]).then(([tokenizer, model]) => {
        this.tokenizer = tokenizer;
        this.model = model;
        return { tokenizer, model };
      }).finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  async warmup() {
    await this.rerank('warmup query', ['warmup passage']);
  }

  async rerank(query, passages) {
    if (!Array.isArray(passages)) {
      throw new Error('rerank(query, passages) expects passages to be an array');
    }
    if (!passages.length) return [];
    const { tokenizer, model } = await this.load();
    const queries = passages.map(() => String(query || ''));
    const inputs = tokenizer(queries, {
      text_pair: passages.map(passage => preSlicePassageForTokenizer(passage, this.config.maxPassageTokens)),
      padding: true,
      truncation: true,
      max_length: this.config.maxPassageTokens
    });
    const outputs = await model(inputs);
    return scoresFromLogits(outputs.logits);
  }
}

export function scoresFromLogits(logits) {
  const rows = logits.tolist();
  return rows.map(row => sigmoid(Array.isArray(row) ? row[row.length - 1] : row));
}

export function preSlicePassageForTokenizer(passage, maxPassageTokens) {
  const text = String(passage || '');
  const maxChars = maxPassageTokens * PRETOKENIZE_CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-Number(value)));
}
