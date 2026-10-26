import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { runInTransaction } from '../../src/utils/runInTransaction.js';
import { ApiError } from '../../src/utils/ApiError.js';

// Stand-ins for the real ClassOffering (the anchor) and Mark (the protected write).
const Anchor = mongoose.model(
  'AnchorStandIn',
  new mongoose.Schema({
    teacherId: { type: String, required: true },
    lockVersion: { type: Number, default: 0 },
    counter: { type: Number, default: 0 },
  }),
  'x1_anchor',
);
const Note = mongoose.model(
  'AnchorNoteStandIn',
  new mongoose.Schema({ label: { type: String, required: true } }),
  'x1_anchor_note',
);

const sessions = [];

// Open a session with a transaction already started. Cleaned up after every test.
async function openTransaction() {
  const session = await mongoose.connection.startSession();
  sessions.push(session);
  session.startTransaction();
  return session;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

let anchor;

beforeAll(async () => {
  await connectTestDb(); // refuses to continue unless the database name ends with _test
  await Anchor.init();
  await Note.init();
});

afterAll(async () => {
  await Anchor.deleteMany({});
  await Note.deleteMany({});
  await disconnectTestDb();
});

beforeEach(async () => {
  await Anchor.deleteMany({});
  await Note.deleteMany({});
  anchor = await Anchor.create({ teacherId: 'T1' });
});

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    try {
      if (session.inTransaction()) await session.abortTransaction();
    } catch {
      // Already aborted by the server after a conflict. Nothing to do.
    }
    await session.endSession();
  }
});

describe('anchor premise: why reads alone are not enough', () => {
  it('two transactions that only READ the same document do not conflict', async () => {
    const a = await openTransaction();
    const b = await openTransaction();
    await Anchor.findById(anchor._id).session(a);
    await Anchor.findById(anchor._id).session(b);
    await a.commitTransaction();
    await b.commitTransaction(); // no error
    expect(true).toBe(true);
  });

  it('a save that only READS the teacher still commits after a reassignment commits (the hazard)', async () => {
    const save = await openTransaction();
    const reassign = await openTransaction();

    const seen = await Anchor.findById(anchor._id).session(save); // the "is this the teacher?" read
    expect(seen.teacherId).toBe('T1');

    await Anchor.updateOne(
      { _id: anchor._id },
      { $set: { teacherId: 'T2' }, $inc: { lockVersion: 1 } },
      { session: reassign },
    );
    await reassign.commitTransaction();

    await Note.create([{ label: 'mark-by-old-teacher' }], { session: save });
    await save.commitTransaction(); // succeeds, which is the problem the anchor write fixes

    expect(await Note.countDocuments({ label: 'mark-by-old-teacher' })).toBe(1);
    expect((await Anchor.findById(anchor._id)).teacherId).toBe('T2');
  });
});

describe('anchor write: a real write conflict', () => {
  it('conflicts while the other transaction is still open, with the retryable label', async () => {
    const save = await openTransaction();
    const reassign = await openTransaction();

    const saved = await Anchor.updateOne(
      { _id: anchor._id, teacherId: 'T1' },
      { $inc: { lockVersion: 1 } },
      { session: save },
    );
    expect(saved.matchedCount).toBe(1);

    const err = await rejection(
      Anchor.updateOne(
        { _id: anchor._id },
        { $set: { teacherId: 'T2' }, $inc: { lockVersion: 1 } },
        { session: reassign },
      ),
    );
    expect(err.hasErrorLabel('TransientTransactionError')).toBe(true);
    expect(err.codeName).toBe('WriteConflict');

    await save.commitTransaction();
    const after = await Anchor.findById(anchor._id);
    expect(after.teacherId).toBe('T1'); // the reassignment did not apply
    expect(after.lockVersion).toBe(1);
  });

  it('conflicts when the other transaction committed AFTER this one took its snapshot', async () => {
    const reassign = await openTransaction();
    const save = await openTransaction();

    await Anchor.findById(anchor._id).session(save); // the snapshot is taken here

    await Anchor.updateOne(
      { _id: anchor._id },
      { $set: { teacherId: 'T2' }, $inc: { lockVersion: 1 } },
      { session: reassign },
    );
    await reassign.commitTransaction();

    const err = await rejection(
      Anchor.updateOne(
        { _id: anchor._id, teacherId: 'T1' },
        { $inc: { lockVersion: 1 } },
        { session: save },
      ),
    );
    expect(err.hasErrorLabel('TransientTransactionError')).toBe(true);
    expect(err.codeName).toBe('WriteConflict');

    const after = await Anchor.findById(anchor._id);
    expect(after.teacherId).toBe('T2');
    expect(after.lockVersion).toBe(1);
  });

  it('matches zero documents when the reassignment committed first (the "not the teacher" path)', async () => {
    await Anchor.updateOne(
      { _id: anchor._id },
      { $set: { teacherId: 'T2' }, $inc: { lockVersion: 1 } },
    );
    const save = await openTransaction();
    const result = await Anchor.updateOne(
      { _id: anchor._id, teacherId: 'T1' },
      { $inc: { lockVersion: 1 } },
      { session: save },
    );
    expect(result.matchedCount).toBe(0);
  });
});

describe('concurrent runInTransaction calls on one document (a sample, not a proof)', () => {
  it('keeps the books balanced: the counter equals the number of successful calls', async () => {
    const parallel = 4;
    const results = await Promise.allSettled(
      Array.from({ length: parallel }, () =>
        runInTransaction(async (session) => {
          await Anchor.updateOne({ _id: anchor._id }, { $inc: { counter: 1 } }, { session });
          return 'ok';
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected');
    const after = await Anchor.findById(anchor._id);

    console.log('concurrent counter trial:', {
      fulfilled,
      rejected: rejected.length,
      counter: after.counter,
    });

    expect(fulfilled).toBeGreaterThanOrEqual(1);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ApiError);
      expect(r.reason.code).toBe('TRANSACTION_RETRY_EXHAUSTED');
    }
    expect(after.counter).toBe(fulfilled);
  });
});