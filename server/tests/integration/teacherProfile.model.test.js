import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { TeacherProfile } from '../../src/models/TeacherProfile.js';

// Every profile made here goes through makeProfile(), which records its id.
// Cleanup deletes only those ids, so other test files sharing srms_test are never disturbed.
const runTag = randomUUID().slice(0, 8).toUpperCase();
const createdIds = [];
let counter = 0;

function nextEmployeeId() {
  counter += 1;
  return `E${runTag}-${counter}`; // at most 12 characters, matches the employee id pattern
}

const newId = () => new mongoose.Types.ObjectId();

async function makeProfile(overrides = {}) {
  const doc = await TeacherProfile.create({
    userId: newId(),
    employeeId: nextEmployeeId(),
    ...overrides,
  });
  createdIds.push(doc._id);
  return doc;
}

const stored = (id) => TeacherProfile.findById(id).lean();

// Returns the field names that failed validation. Any other kind of error is rethrown.
async function invalidPaths(data) {
  try {
    await new TeacherProfile(data).validate();
    return [];
  } catch (error) {
    if (error.name !== 'ValidationError') throw error;
    return Object.keys(error.errors);
  }
}

describe('TeacherProfile model', () => {
  beforeAll(async () => {
    await connectTestDb();
    await TeacherProfile.init(); // wait for both unique indexes to finish building
  });

  afterAll(async () => {
    await TeacherProfile.deleteMany({ _id: { $in: createdIds } });
    await disconnectTestDb();
  });

  describe('validation (no database writes)', () => {
    it('accepts a valid profile', async () => {
      expect(await invalidPaths({ userId: newId(), employeeId: 'EMP-014' })).toEqual([]);
    });

    it('trims and uppercases employeeId', async () => {
      const doc = new TeacherProfile({ userId: newId(), employeeId: '  emp-014  ' });
      expect(doc.employeeId).toBe('EMP-014');
      expect(await invalidPaths({ userId: newId(), employeeId: '  emp-014  ' })).toEqual([]);
    });

    it('rejects bad employee ids', async () => {
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
      for (const [label, employeeId] of cases) {
        expect(await invalidPaths({ userId: newId(), employeeId }), label).toContain('employeeId');
      }
    });

    it('accepts the length limits and the allowed characters', async () => {
      const accepted = ['ABC', 'A'.repeat(20), 'EMP-014', 'EMP/2026/01', '1A2'];
      for (const employeeId of accepted) {
        expect(await invalidPaths({ userId: newId(), employeeId }), employeeId).toEqual([]);
      }
    });

    it('rejects a missing userId', async () => {
      expect(await invalidPaths({ employeeId: 'EMP-014' })).toContain('userId');
    });

    it('rejects a userId that is not an ObjectId', async () => {
      expect(await invalidPaths({ userId: 'not-an-id', employeeId: 'EMP-014' })).toContain('userId');
    });

    it("rejects an unknown field (strict: 'throw')", async () => {
      await expect(
        (async () => {
          const doc = new TeacherProfile({ userId: newId(), employeeId: 'EMP-014', nickname: 'x' });
          await doc.validate();
        })(),
      ).rejects.toThrow();
    });
  });

  describe('storage, indexes and editing', () => {
    it('saves a profile, stores employeeId in uppercase and adds timestamps', async () => {
      const expected = nextEmployeeId();
      const created = await makeProfile({ employeeId: expected.toLowerCase() });

      const doc = await stored(created._id);
      expect(doc.employeeId).toBe(expected);
      expect(doc.createdAt).toBeInstanceOf(Date);
      expect(doc.updatedAt).toBeInstanceOf(Date);
    });

    it('rejects a second profile for the same userId (code 11000)', async () => {
      const first = await makeProfile();
      await expect(
        TeacherProfile.create({ userId: first.userId, employeeId: nextEmployeeId() }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('rejects a duplicate employeeId, even in a different letter case (code 11000)', async () => {
      const first = await makeProfile();
      await expect(
        TeacherProfile.create({ userId: newId(), employeeId: first.employeeId.toLowerCase() }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('allows two profiles with different users and employee ids', async () => {
      const a = await makeProfile();
      const b = await makeProfile();
      expect(await TeacherProfile.countDocuments({ _id: { $in: [a._id, b._id] } })).toBe(2);
    });

    it('allows changing employeeId to a new valid value, and uppercases it', async () => {
      const created = await makeProfile();
      const next = nextEmployeeId();
      await TeacherProfile.updateOne(
        { _id: created._id },
        { $set: { employeeId: next.toLowerCase() } },
      );
      expect((await stored(created._id)).employeeId).toBe(next);
    });

    it('rejects changing employeeId to one that is already taken (code 11000)', async () => {
      const a = await makeProfile();
      const b = await makeProfile();
      await expect(
        TeacherProfile.updateOne({ _id: b._id }, { $set: { employeeId: a.employeeId } }).exec(),
      ).rejects.toMatchObject({ code: 11000 });
      expect((await stored(b._id)).employeeId).toBe(b.employeeId);
    });

    it('rejects updates that set an invalid employeeId, and leaves the stored value unchanged', async () => {
      const created = await makeProfile();
      const runs = [
        ['updateOne', () =>
          TeacherProfile.updateOne({ _id: created._id }, { $set: { employeeId: 'bad value!' } }).exec()],
        ['findOneAndUpdate', () =>
          TeacherProfile.findOneAndUpdate(
            { _id: created._id },
            { $set: { employeeId: 'bad value!' } },
          ).exec()],
        ['updateMany', () =>
          TeacherProfile.updateMany(
            { _id: created._id },
            { $set: { employeeId: 'bad value!' } },
          ).exec()],
      ];
      for (const [label, run] of runs) {
        await expect(run(), label).rejects.toMatchObject({ name: 'ValidationError' });
      }
      expect((await stored(created._id)).employeeId).toBe(created.employeeId);
    });

    it('finds a profile by a lowercase employeeId in a query filter (filters are uppercased)', async () => {
      const created = await makeProfile();
      const found = await TeacherProfile.findOne({
        employeeId: created.employeeId.toLowerCase(),
      }).lean();
      expect(found).not.toBeNull();
      expect(String(found._id)).toBe(String(created._id));
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

  describe('bulkWrite (updates are refused, inserts are allowed)', () => {
    it('refuses bulkWrite updateOne on employeeId and changes nothing', async () => {
      const created = await makeProfile();
      await expect(
        TeacherProfile.bulkWrite([
          {
            updateOne: {
              filter: { _id: created._id },
              update: { $set: { employeeId: nextEmployeeId() } },
            },
          },
        ]),
      ).rejects.toMatchObject({ code: 'BULK_UPDATE_NOT_ALLOWED' });
      expect((await stored(created._id)).employeeId).toBe(created.employeeId);
    });

    it('still validates a bulkWrite insertOne (invalid employeeId rejected)', async () => {
      const userId = newId();
      await expect(
        TeacherProfile.bulkWrite([{ insertOne: { document: { userId, employeeId: 'bad value!' } } }]),
      ).rejects.toMatchObject({ name: 'ValidationError' });
      expect(await TeacherProfile.countDocuments({ userId })).toBe(0);
    });
  });

  describe('userId is immutable', () => {
    it('save() with a changed userId fails and the stored userId is unchanged', async () => {
      const created = await makeProfile();
      const doc = await TeacherProfile.findById(created._id);

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
        TeacherProfile.updateOne({ _id: id }, { $set: { userId: newId() } }).exec()],
      ['findOneAndUpdate with $set', (id) =>
        TeacherProfile.findOneAndUpdate({ _id: id }, { $set: { userId: newId() } }).exec()],
      ['updateOne with $unset', (id) =>
        TeacherProfile.updateOne({ _id: id }, { $unset: { userId: 1 } }).exec()],
      ['updateOne with $rename away from the field', (id) =>
        TeacherProfile.updateOne({ _id: id }, { $rename: { userId: 'oldUserId' } }).exec()],
      ['updateOne changing userId and an invalid employeeId together', (id) =>
        TeacherProfile.updateOne(
          { _id: id },
          { $set: { userId: newId(), employeeId: 'bad value!' } },
        ).exec()],
    ];

    it.each(queryUpdates)('rejects %s with IMMUTABLE_FIELD and leaves the stored userId unchanged', async (_label, run) => {
      const created = await makeProfile();
      await expect(run(created._id)).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      expect(String((await stored(created._id)).userId)).toBe(String(created.userId));
    });

    it('rejects replaceOne and leaves the stored userId unchanged', async () => {
      const created = await makeProfile();
      await expect(
        TeacherProfile.replaceOne(
          { _id: created._id },
          { userId: newId(), employeeId: nextEmployeeId() },
        ).exec(),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      expect(String((await stored(created._id)).userId)).toBe(String(created.userId));
    });

    it('rejects findOneAndReplace and leaves the stored userId unchanged', async () => {
      const created = await makeProfile();
      await expect(
        TeacherProfile.findOneAndReplace(
          { _id: created._id },
          { userId: newId(), employeeId: nextEmployeeId() },
        ).exec(),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      expect(String((await stored(created._id)).userId)).toBe(String(created.userId));
    });

    it('rejects bulkWrite replaceOne and leaves the stored userId unchanged', async () => {
      const created = await makeProfile();
      await expect(
        TeacherProfile.bulkWrite([
          {
            replaceOne: {
              filter: { _id: created._id },
              replacement: { userId: newId(), employeeId: nextEmployeeId() },
            },
          },
        ]),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      expect(String((await stored(created._id)).userId)).toBe(String(created.userId));
    });

    it('doc.updateOne() never changes the stored userId (an error or a silent ignore is acceptable)', async () => {
      const created = await makeProfile();
      const doc = await TeacherProfile.findById(created._id);

      let outcome = 'no error (change silently ignored)';
      try {
        await doc.updateOne({ $set: { userId: newId() } });
      } catch (error) {
        outcome = `threw ${error.code ?? error.name}`;
      }
      console.log('TeacherProfile doc.updateOne outcome:', outcome);

      expect(String((await stored(created._id)).userId)).toBe(String(created.userId));
    });
  });
});