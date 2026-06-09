import { LocalOnnxEmbedder } from './local-onnx.js';

export function createEmbedder(config) {
  if (config.provider === 'local-onnx') {
    return new LocalOnnxEmbedder(config);
  }
  throw new Error(`Unsupported embedder provider for R1: ${config.provider}`);
}
