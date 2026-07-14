import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeLog } from '../logging.js';

describe('sanitizeLog', () => {
  it('redacts worker tokens and signed URL tokens', () => {
    const sanitized = sanitizeLog('Bearer swk_secret123 SLIA-482913 https://x.test/file?token=abc&expires=123');

    assert.equal(sanitized.includes('swk_secret123'), false);
    assert.equal(sanitized.includes('SLIA-482913'), false);
    assert.equal(sanitized.includes('token=abc'), false);
    assert.equal(sanitized.includes('[redacted]'), true);
  });
});
