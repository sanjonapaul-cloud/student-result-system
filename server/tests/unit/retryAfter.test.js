import { describe, it, expect } from 'vitest';
import { ApiError } from '../../src/utils/ApiError.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { runInTransaction } from '../../src/utils/runInTransaction.js';

function fakeRes() {
  const res = { headersSent: false, headers: {}, statusCode: undefined, body: undefined };
  res.set = (extra) => {
    Object.assign(res.headers, extra);
    return res;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

function mongoLikeError(message, labels = [], extra = {}) {
  const err = new Error(message);
  err.errorLabels = labels;
  err.hasErrorLabel = (label) => labels.includes(label);
  return Object.assign(err, extra);
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

describe('ApiError headers', () => {
  it('has no headers unless given', () => {
    expect(new ApiError(400, 'X', 'm').headers).toBeUndefined();
  });
});

describe('errorHandler headers', () => {
  it('sets the extra headers carried by an ApiError', () => {
    const res = fakeRes();
    errorHandler(new ApiError(503, 'X', 'm', undefined, { 'Retry-After': '1' }), {}, res, () => {});
    expect(res.statusCode).toBe(503);
    expect(res.headers).toEqual({ 'Retry-After': '1' });
  });

  it('sets no extra headers when the error carries none', () => {
    const res = fakeRes();
    errorHandler(new ApiError(404, 'X', 'm'), {}, res, () => {});
    expect(res.headers).toEqual({});
  });
});

describe('runInTransaction headers', () => {
  it('adds Retry-After: 1 to TRANSACTION_RETRY_EXHAUSTED', async () => {
    const runner = async () => {
      throw mongoLikeError('write conflict', ['TransientTransactionError']);
    };
    const err = await rejection(runInTransaction(async () => 'x', { runner }));
    expect(err.code).toBe('TRANSACTION_RETRY_EXHAUSTED');
    expect(err.headers).toEqual({ 'Retry-After': '1' });
  });

  it('does not add Retry-After to COMMIT_STATUS_UNKNOWN (the client must reload, not resubmit)', async () => {
    const runner = async () => {
      throw mongoLikeError('unknown', ['UnknownTransactionCommitResult']);
    };
    const err = await rejection(runInTransaction(async () => 'x', { runner }));
    expect(err.code).toBe('COMMIT_STATUS_UNKNOWN');
    expect(err.headers).toBeUndefined();
  });

  it('does not add Retry-After to TRANSACTIONS_UNAVAILABLE', async () => {
    const runner = async () => {
      throw mongoLikeError('Transaction numbers are only allowed on a replica set member', [], { code: 20 });
    };
    const err = await rejection(runInTransaction(async () => 'x', { runner }));
    expect(err.code).toBe('TRANSACTIONS_UNAVAILABLE');
    expect(err.headers).toBeUndefined();
  });
});