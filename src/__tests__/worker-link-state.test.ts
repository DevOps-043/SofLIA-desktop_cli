import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getWorkerStartMessage,
  getWorkerStatusMessage,
  isWorkerLinkRequiredError,
  WORKER_LINK_REQUIRED_MESSAGE,
} from '../worker-link-state.js';

describe('worker link state classification', () => {
  it('treats missing local config as a link-required state', () => {
    const error = new Error('Config incompleta. Vincula este equipo desde la app.');

    assert.equal(isWorkerLinkRequiredError(error), true);
    assert.equal(getWorkerStatusMessage(error), undefined);
    assert.equal(getWorkerStartMessage(error), WORKER_LINK_REQUIRED_MESSAGE);
  });

  it('treats revoked worker tokens as a link-required state instead of a UI error', () => {
    const error = new Error('HTTP 401: {"error":"Invalid or revoked worker token"}');

    assert.equal(isWorkerLinkRequiredError(error), true);
    assert.equal(getWorkerStatusMessage(error), undefined);
    assert.equal(getWorkerStartMessage(error), WORKER_LINK_REQUIRED_MESSAGE);
  });

  it('keeps non-auth failures visible for diagnostics', () => {
    const error = new Error('HTTP 500: {"error":"database unavailable"}');

    assert.equal(isWorkerLinkRequiredError(error), false);
    assert.match(getWorkerStatusMessage(error) || '', /HTTP 500/);
    assert.match(getWorkerStartMessage(error), /HTTP 500/);
  });
});
