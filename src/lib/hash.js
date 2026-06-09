import crypto from 'node:crypto';

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function shortHash(value, length = 16) {
  return sha256(value).slice(0, length);
}
