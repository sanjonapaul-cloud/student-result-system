import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { StudentProfile } from '../../src/models/StudentProfile.js';

// Every profile made here goes through makeProfile(), which records its id.
// Cleanup deletes only those ids, so other test files sharing srms_test are never disturbed.
const runTag = randomUUID().slice(0, 8).toUpperCase();
const createdIds = [];
let counter = 0;

function nextRollNo() {
  counter += 1;
  return `T${runTag}-${counter}`; // at most 12 characters, matches the roll number pattern
}

const newId = () => new mongoose.Types.ObjectId();

async function makeProfile(overrides = {}) {
  const doc = await StudentProfile.create({ userId: newId(), rollNo: nextRollNo(), ...overrides });
  createdIds.push(doc._id);
  return doc;
}

async function stored(id) {
  return StudentProfile.findById(id).lean();
}

// Returns the field names that failed validation. Any other kind of error is rethrown.
async function invalidPaths(data) {
  try {
    await new StudentProfile(data).validate();
    return [];
  } catch (error) {
    if (error.name !== 'ValidationError') throw error;
    return Object.keys(error.errors);
  }
}

describe('StudentProfile model', () => {
  beforeAll(async () => {
    await connectTestDb();
    await StudentProfile.init(); // wait for both unique indexes to finish building
  });

  afterAll(async () => {
    await StudentProfile.deleteMany({ _id: { $in: createdIds } });
    await disconnectTestDb();
  });

  describe('validation (no database writes)', () => {
    it('accepts a valid profile', async () => {
      expect(await invalidPaths({ userId: newId(), rollNo: 'CS2026-001' })).toEqual([]);
    });

    it('trims and uppercases rollNo', async () => {
      const doc = new StudentProfile({ userId: newId(), rollNo: '  cs2026-001  ' });
      expect(doc.rollNo).toBe('CS2026-001');
      expect(await invalidPaths({ userId: newId(), rollNo: '  cs2026-001  ' })).toEqual([]);
    });

    it('rejects bad roll numbers', async () => {
      const cases = [
        ['missing', undefined],
        ['only spaces', '   '],
        ['2 characters', 'AB'],
        ['21 characters', 'A'.repeat(21)],
        ['starts with a hyphen', '-ABC'],
        ['starts with a slash', '/ABC'],
        ['contains a space', 'AB C1'],
        ['contains an underscore', 'AB_C1'],
        ['contains a dot', 'AB.C1'],
      ];
      for (const [label, rollNo] of cases) {
        expect(await invalidPaths({ userId: newId(), rollNo }), label).toContain('rollNo');
      }
    });

    it('accepts the length limits and the allowed characters', async () => {
      const accepted = ['ABC', 'A'.repeat(20), 'CS2026-001', 'CS/2026/01', '1A2'];
      for (const rollNo of accepted) {
        expect(await invalidPaths({ userId: newId(), rollNo }), rollNo).toEqual([]);
      }
    });

    it('rejects a missing userId', async () => {
      expect(await invalidPaths({ rollNo: 'CS2026-001' })).toContain('userId');
    });

    it('rejects a userId that is not an ObjectId', async () => {
      expect(await invalidPaths({ userId: 'not-an-id', rollNo: 'CS2026-001' })).toContain('userId');
    });

    it("rejects an unknown field (strict: 'throw')", async () => {
      await expect(
        (async () => {
          const doc = new StudentProfile({ userId: newId(), rollNo: 'CS2026-001', nickname: 'x' });
          await doc.validate();
        })(),
      ).rejects.toThrow();
    });
  });

  describe('storage, indexes and editing', () => {
    it('saves a profile, stores rollNo in uppercase and adds timestamps', async () => {
      const expected = nextRollNo();
      const created = await makeProfile({ rollNo: expected.toLowerCase() });

      const doc = await stored(created._id);
      expect(doc.rollNo).toBe(expected);
      expect(doc.createdAt).toBeInstanceOf(Date);
      expect(doc.updatedAt).toBeInstanceOf(Date);
    });

    it('rejects a second profile for the same userId (code 11000)', async () => {
      const first = await makeProfile();
      await expect(
        StudentProfile.create({ userId: first.userId, rollNo: nextRollNo() }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('rejects a duplicate rollNo, even in a different letter case (code 11000)', async () => {
      const first = await makeProfile();
      await expect(
        StudentProfile.create({ userId: newId(), rollNo: first.rollNo.toLowerCase() }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('allows two profiles with different users and roll numbers', async () => {
      const a = await makeProfile();
      const b = await makeProfile();
      expect(await StudentProfile.countDocuments({ _id: { $in: [a._id, b._id] } })).toBe(2);
    });

    it('allows changing rollNo to a new valid value', async () => {
      const created = await makeProfile();
      const next = nextRollNo();
      await StudentProfile.updateOne({ _id: created._id }, { $set: { rollNo: next } });
      expect((await stored(created._id)).rollNo).toBe(next);
    });

    it('rejects changing rollNo to one that is already taken (code 11000)', async () => {
      const a = await makeProfile();
      const b = await makeProfile();
      await expect(
        StudentProfile.updateOne({ _id: b._id }, { $set: { rollNo: a.rollNo } }).exec(),
      ).rejects.toMatchObject({ code: 11000 });
      expect((await stored(b._id)).rollNo).toBe(b.rollNo);
    });

       it('rejects an updateOne that sets an invalid rollNo and leaves the stored value unchanged', async () => {
      const created = await makeProfile();
      await expect(
        StudentProfile.updateOne({ _id: created._id }, { $set: { rollNo: 'bad value!' } }).exec(),
      ).rejects.toMatchObject({ name: 'ValidationError' });
      expect((await stored(created._id)).rollNo).toBe(created.rollNo);
    });

    it('RECORDS whether a lowercase rollNo is uppercased in a query filter (a probe)', async () => {
      const created = await makeProfile();
      const found = await StudentProfile.findOne({ rollNo: created.rollNo.toLowerCase() }).lean();
      console.log(
        'PROBE findOne with a lowercase rollNo:',
        found ? 'FOUND the profile (filter was uppercased)' : 'NOT found (callers must uppercase)',
      );
      expect(typeof created.rollNo).toBe('string');
    });

    it('DOCUMENTS the limit: a profile can point at a userId that has no User', async () => {
      const created = await makeProfile();
      const matchingUsers = await mongoose.connection.db
        .collection('users')
        .countDocuments({ _id: created.userId });
      expect(matchingUsers).toBe(0);
      expect(await stored(created._id)).not.toBeNull();
    });
  });

  describe('userId is immutable', () => {
    it('save() with a changed userId fails and the stored userId is unchanged', async () => {
      const created = await makeProfile();
      const doc = await StudentProfile.findById(created._id);

      await expect(
        (async () => {
          doc.userId = newId();
          await doc.save();
        })(),
      ).rejects.toMatchObject({ name: 'ValidationError' });

      expect(String((await stored(created._id)).userId)).toBe(String(created.userId));
    });

    const queryUpdates = [
      ['updateOne with $set', (id) =>
        StudentProfile.updateOne({ _id: id }, { $set: { userId: newId() } }).exec()],
      ['findOneAndUpdate with $set', (id) =>
        StudentProfile.findOneAndUpdate({ _id: id }, { $set: { userId: newId() } }).exec()],
      ['updateOne with $unset', (id) =>
        StudentProfile.updateOne({ _id: id }, { $unset: { userId: 1 } }).exec()],
      ['updateOne with $rename away from the field', (id) =>
        StudentProfile.updateOne({ _id: id }, { $rename: { userId: 'oldUserId' } }).exec()],
    ];

    it.each(queryUpdates)('rejects %s and leaves the stored userId unchanged', async (_label, run) => {
      const created = await makeProfile();
      await expect(run(created._id)).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      expect(String((await stored(created._id)).userId)).toBe(String(created.userId));
    });

    it('rejects replaceOne and leaves the stored userId unchanged', async () => {
      const created = await makeProfile();
      await expect(
        StudentProfile.replaceOne(
          { _id: created._id },
          { userId: newId(), rollNo: nextRollNo() },
        ).exec(),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      expect(String((await stored(created._id)).userId)).toBe(String(created.userId));
    });

    it('rejects findOneAndReplace and leaves the stored userId unchanged', async () => {
      const created = await makeProfile();
      await expect(
        StudentProfile.findOneAndReplace(
          { _id: created._id },
          { userId: newId(), rollNo: nextRollNo() },
        ).exec(),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      expect(String((await stored(created._id)).userId)).toBe(String(created.userId));
    });

    it('rejects bulkWrite updateOne on userId and leaves it unchanged', async () => {
      const created = await makeProfile();
      await expect(
        StudentProfile.bulkWrite([
          { updateOne: { filter: { _id: created._id }, update: { $set: { userId: newId() } } } },
        ]),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      expect(String((await stored(created._id)).userId)).toBe(String(created.userId));
    });

    it('rejects bulkWrite replaceOne and leaves the stored userId unchanged', async () => {
      const created = await makeProfile();
      await expect(
        StudentProfile.bulkWrite([
          {
            replaceOne: {
              filter: { _id: created._id },
              replacement: { userId: newId(), rollNo: nextRollNo() },
            },
          },
        ]),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      expect(String((await stored(created._id)).userId)).toBe(String(created.userId));
    });

    it('doc.updateOne() never changes the stored userId (an error or a silent ignore is acceptable)', async () => {
      const created = await makeProfile();
      const doc = await StudentProfile.findById(created._id);

      let outcome = 'no error (change silently ignored)';
      try {
        await doc.updateOne({ $set: { userId: newId() } });
      } catch (error) {
        outcome = `threw ${error.code ?? error.name}`;
      }
      console.log('doc.updateOne outcome:', outcome);

      expect(String((await stored(created._id)).userId)).toBe(String(created.userId));
    });
  });
});