import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { runInTransaction } from '../../src/utils/runInTransaction.js';
import { ApiError } from '../../src/utils/ApiError.js';

// Two throwaway collections that exist only for this test, in the _test database.
const probeSchema = new mongoose.Schema({ label: { type: String, required: true } });
const ProbeA = mongoose.model('X1ProbeA', probeSchema, 'x1_probe_a');
const ProbeB = mongoose.model('X1ProbeB', probeSchema, 'x1_probe_b');

// A real driver error carrying the real label, so the REAL driver decides what to do with it.
function transientError(message = 'simulated write conflict') {
  const err = new mongoose.mongo.MongoError(message);
  err.addErrorLabel('TransientTransactionError');
  return err;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

beforeAll(async () => {
  await connectTestDb(); // refuses to continue unless the database name ends with _test
  await ProbeA.init(); // makes sure the collections exist before any transaction uses them
  await ProbeB.init();
});

afterAll(async () => {
  await ProbeA.deleteMany({});
  await ProbeB.deleteMany({});
  await disconnectTestDb();
});

beforeEach(async () => {
  await ProbeA.deleteMany({});
  await ProbeB.deleteMany({});
});

describe('X1: real transactions on the test database', () => {
  it('commits: every write persists and the callback value is returned', async () => {
    const result = await runInTransaction(async (session) => {
      await ProbeA.create([{ label: 'a1' }], { session });
      await ProbeB.create([{ label: 'b1' }], { session });
      return 'marker-value';
    });
    expect(result).toBe('marker-value');
    expect(await ProbeA.countDocuments({ label: 'a1' })).toBe(1);
    expect(await ProbeB.countDocuments({ label: 'b1' })).toBe(1);
  });

  it('rolls back when the callback throws a business error, and rethrows that same error', async () => {
    const business = new ApiError(409, 'CLASS_PUBLISHED', 'Class already published');
    let runs = 0;
    const err = await rejection(
      runInTransaction(async (session) => {
        runs += 1;
        await ProbeA.create([{ label: 'should-vanish' }], { session });
        throw business;
      }),
    );
    expect(err).toBe(business);
    expect(runs).toBe(1);
    expect(await ProbeA.countDocuments({})).toBe(0);
  });

  it('rolls back writes to TWO collections when a failure is injected after both writes', async () => {
    const err = await rejection(
      runInTransaction(async (session) => {
        await ProbeA.create([{ label: 'a-vanish' }], { session });
        await ProbeB.create([{ label: 'b-vanish' }], { session });
        throw new ApiError(500, 'INJECTED_FAILURE', 'failure injected after both writes');
      }),
    );
    expect(err.code).toBe('INJECTED_FAILURE');
    expect(await ProbeA.countDocuments({})).toBe(0);
    expect(await ProbeB.countDocuments({})).toBe(0);
  });

  it('does NOT roll back a write made without the session (documents the pitfall)', async () => {
    await rejection(
      runInTransaction(async (session) => {
        await ProbeA.create([{ label: 'outside-session' }]); // BUG ON PURPOSE: no { session }
        await ProbeB.create([{ label: 'inside-session' }], { session });
        throw new ApiError(500, 'INJECTED_FAILURE', 'fail after both writes');
      }),
    );
    expect(await ProbeA.countDocuments({ label: 'outside-session' })).toBe(1); // survived
    expect(await ProbeB.countDocuments({ label: 'inside-session' })).toBe(0); // rolled back
  });

  it('a transient failure reruns the callback, and the first attempt is rolled back', async () => {
    let runs = 0;
    const result = await runInTransaction(async (session) => {
      runs += 1;
      await ProbeA.create([{ label: `attempt-${runs}` }], { session });
      if (runs === 1) throw transientError();
      return 'recovered';
    });
    expect(result).toBe('recovered');
    expect(runs).toBe(2);
    expect(await ProbeA.countDocuments({ label: 'attempt-1' })).toBe(0);
    expect(await ProbeA.countDocuments({ label: 'attempt-2' })).toBe(1);
  });

  it('gives up after 3 runs with TRANSACTION_RETRY_EXHAUSTED and leaves nothing behind', async () => {
    let runs = 0;
    const err = await rejection(
      runInTransaction(async (session) => {
        runs += 1;
        await ProbeA.create([{ label: `run-${runs}` }], { session });
        throw transientError();
      }),
    );
    expect(runs).toBe(3);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('TRANSACTION_RETRY_EXHAUSTED');
    expect(err.headers).toEqual({ 'Retry-After': '1' });
    expect(await ProbeA.countDocuments({})).toBe(0);
  });

  it('does not retry a duplicate-key error, and passes it through unchanged', async () => {
    const id = new mongoose.Types.ObjectId();
    let runs = 0;
    const err = await rejection(
      runInTransaction(async (session) => {
        runs += 1;
        await ProbeA.create([{ _id: id, label: 'dup' }], { session });
        await ProbeA.create([{ _id: id, label: 'dup' }], { session }); // same _id twice
      }),
    );
    expect(runs).toBe(1);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(err.code).toBe(11000);
    expect(await ProbeA.countDocuments({})).toBe(0);
  });
});

describe('X1: real driver timeout behaviour', () => {
  it('turns an expired deadline on a transient error into TRANSACTION_RETRY_EXHAUSTED', async () => {
    // Capture the raw error the real driver throws, before our wrapper translates it.
    let raw;
    const runner = async (fn, options) => {
      try {
        return await mongoose.connection.transaction(fn, options);
      } catch (err) {
        raw = err;
        throw err;
      }
    };

    const started = Date.now();
    const err = await rejection(
      runInTransaction(
        async () => {
          throw transientError(); // never succeeds, so only the deadline can stop the driver
        },
        { runner, maxAttempts: 1000, timeoutMS: 1500 },
      ),
    );
    const elapsed = Date.now() - started;

    expect(raw?.name).toBe('MongoOperationTimeoutError');
    expect(raw.hasErrorLabel('TransientTransactionError')).toBe(true);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('TRANSACTION_RETRY_EXHAUSTED');
    expect(elapsed).toBeLessThan(6000);
  });
});