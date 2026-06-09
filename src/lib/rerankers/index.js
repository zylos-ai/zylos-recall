import { LocalOnnxReranker } from './local-onnx.js';

export function createReranker(config) {
  if (!config || config.provider === 'none') return null;
  if (config.provider === 'rerank') return new LocalOnnxReranker(config);
  throw new Error(`Unsupported filter provider: ${config.provider}`);
}
