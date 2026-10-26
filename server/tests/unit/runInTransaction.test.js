import { describe, it, expect } from 'vitest';
import { runInTransaction } from '../../src/utils/runInTransaction.js';
import { ApiError } from '../../src/utils/ApiError.js';

const SESSION = { fake: 'session' };

// An error that looks like a MongoDB driver error: it carries labels.
function mongoLikeError(message, labels = [], extra = {}) {
  const err = new Error(message);
  err.errorLabels = labels;
  err.hasErrorLabel = (label) => labels.includes(label);
  return Object.assign(err, extra);
}

const transientError = () => mongoLikeError('write conflict', ['TransientTransactionError']);

// Imitates what we read in the driver source (sessions.js, withTransaction):
// rerun the callback when it throws a TransientTransactionError, rethrow anything else.
// This is a stand-in. The REAL driver is exercised by the database tests in 2.10d and 2.10e.
function fakeDriver() {
  const seen = [];
  const runner = async (fn, options) => {
    seen.push(options);
    for (let run = 0; run < 50; run += 1) {
      try {
        return await fn(SESSION);
      } catch (err) {
        if (typeof err?.hasErrorLabel === 'function' && err.hasErrorLabel('TransientTransactionError')) {
          continue;
        }
        throw err;
      }
    }
    throw new Error('fake driver safety stop: the callback was rerun 50 times');
  };
  return { runner, seen };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

describe('runInTransaction: success paths', () => {
  it('returns the callback value after one run', async () => {
    const { runner } = fakeDriver();
    let runs = 0;
    const result = await runInTransaction(async () => {
      runs += 1;
      return 'done';
    }, { runner });
    expect(result).toBe('done');
    expect(runs).toBe(1);
  });

  it('passes the session to the callback', async () => {
    const { runner } = fakeDriver();
    let received;
    await runInTransaction(async (session) => {
      received = session;
    }, { runner });
    expect(received).toBe(SESSION);
  });

  it('passes the default 10 second timeout to the runner', async () => {
    const { runner, seen } = fakeDriver();
    await runInTransaction(async () => 'x', { runner });
    expect(seen).toEqual([{ timeoutMS: 10000 }]);
  });

  it('passes a custom timeout to the runner', async () => {
    const { runner, seen } = fakeDriver();
    await runInTransaction(async () => 'x', { runner, timeoutMS: 2500 });
    expect(seen).toEqual([{ timeoutMS: 2500 }]);
  });

  it('succeeds on attempt 2 after one transient failure', async () => {
    const { runner } = fakeDriver();
    let runs = 0;
    const result = await runInTransaction(async () => {
      runs += 1;
      if (runs === 1) throw transientError();
      return 'recovered';
    }, { runner });
    expect(result).toBe('recovered');
    expect(runs).toBe(2);
  });

  it('starts a fresh attempt count for every call', async () => {
    const { runner } = fakeDriver();
    let runs = 0;
    const work = async () => {
      runs += 1;
      if (runs % 2 === 1) throw transientError();
      return 'ok';
    };
    expect(await runInTransaction(work, { runner, maxAttempts: 2 })).toBe('ok');
    expect(await runInTransaction(work, { runner, maxAttempts: 2 })).toBe('ok');
  });
});

describe('runInTransaction: bounded retries', () => {
  it('stops after 3 runs of the callback and reports TRANSACTION_RETRY_EXHAUSTED', async () => {
    const { runner } = fakeDriver();
    let runs = 0;
    const err = await rejection(
      runInTransaction(async () => {
        runs += 1;
        throw transientError();
      }, { runner }),
    );
    expect(runs).toBe(3);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('TRANSACTION_RETRY_EXHAUSTED');
    expect(err.message).toBe(
      'A conflicting update was in progress and nothing was saved. Please try again.',
    );
  });

  it('also counts reruns caused by a failed commit', async () => {
    // Pretend every commit fails transiently, so the driver keeps rerunning the callback.
    const runner = async (fn) => {
      for (let run = 0; run < 50; run += 1) {
        await fn(SESSION);
      }
      throw new Error('fake driver safety stop');
    };
    let runs = 0;
    const err = await rejection(
      runInTransaction(async () => {
        runs += 1;
      }, { runner }),
    );
    expect(runs).toBe(3);
    expect(err.code).toBe('TRANSACTION_RETRY_EXHAUSTED');
  });

  it('respects a custom maxAttempts', async () => {
    const { runner } = fakeDriver();
    let runs = 0;
    const err = await rejection(
      runInTransaction(async () => {
        runs += 1;
        throw transientError();
      }, { runner, maxAttempts: 1 }),
    );
    expect(runs).toBe(1);
    expect(err.code).toBe('TRANSACTION_RETRY_EXHAUSTED');
  });
});

describe('runInTransaction: errors that must not be retried or rewritten', () => {
  it('rethrows a business ApiError unchanged after one run', async () => {
    const { runner } = fakeDriver();
    const business = new ApiError(409, 'CLASS_PUBLISHED', 'Class already published');
    let runs = 0;
    const err = await rejection(
      runInTransaction(async () => {
        runs += 1;
        throw business;
      }, { runner }),
    );
    expect(runs).toBe(1);
    expect(err).toBe(business);
  });

  it('rethrows a duplicate-key style error unchanged after one run', async () => {
    const { runner } = fakeDriver();
    const duplicate = mongoLikeError('E11000 duplicate key', [], { code: 11000 });
    let runs = 0;
    const err = await rejection(
      runInTransaction(async () => {
        runs += 1;
        throw duplicate;
      }, { runner }),
    );
    expect(runs).toBe(1);
    expect(err).toBe(duplicate);
  });

  it('rethrows an ordinary programming error unchanged', async () => {
    const { runner } = fakeDriver();
    const bug = new TypeError('oops');
    const err = await rejection(runInTransaction(async () => { throw bug; }, { runner }));
    expect(err).toBe(bug);
  });
});

describe('runInTransaction: uncertain and unavailable outcomes', () => {
  it('reports COMMIT_STATUS_UNKNOWN when the commit result is unknown, without rerunning the callback', async () => {
    let runs = 0;
    const runner = async (fn) => {
      await fn(SESSION);
      throw mongoLikeError('commit result unknown', ['UnknownTransactionCommitResult']);
    };
    const err = await rejection(
      runInTransaction(async () => {
        runs += 1;
      }, { runner }),
    );
    expect(runs).toBe(1);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('COMMIT_STATUS_UNKNOWN');
    expect(err.message).toBe(
      'The save could not be confirmed. Reload to check the current state before trying again.',
    );
  });

  it('maps a timeout that carries a transient label to TRANSACTION_RETRY_EXHAUSTED', async () => {
    const runner = async () => {
      throw mongoLikeError('Timed out during withTransaction', ['TransientTransactionError'], {
        name: 'MongoOperationTimeoutError',
      });
    };
    const err = await rejection(runInTransaction(async () => 'x', { runner }));
    expect(err.code).toBe('TRANSACTION_RETRY_EXHAUSTED');
  });

  it('maps a timeout that carries an unknown-commit label to COMMIT_STATUS_UNKNOWN', async () => {
    const runner = async () => {
      throw mongoLikeError('Timed out during withTransaction', ['UnknownTransactionCommitResult'], {
        name: 'MongoOperationTimeoutError',
      });
    };
    const err = await rejection(runInTransaction(async () => 'x', { runner }));
    expect(err.code).toBe('COMMIT_STATUS_UNKNOWN');
  });

  it('treats a timeout with no label as COMMIT_STATUS_UNKNOWN (cannot prove nothing was saved)', async () => {
    const runner = async () => {
      throw mongoLikeError('Timed out', [], { name: 'MongoOperationTimeoutError' });
    };
    const err = await rejection(runInTransaction(async () => 'x', { runner }));
    expect(err.code).toBe('COMMIT_STATUS_UNKNOWN');
  });

  it('reports TRANSACTIONS_UNAVAILABLE when the server has no transaction support', async () => {
    const runner = async () => {
      throw mongoLikeError(
        'Transaction numbers are only allowed on a replica set member or mongos',
        [],
        { code: 20 },
      );
    };
    const err = await rejection(runInTransaction(async () => 'x', { runner }));
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('TRANSACTIONS_UNAVAILABLE');
    expect(err.message).toBe('Database transactions are unavailable. Contact the administrator.');
  });
});