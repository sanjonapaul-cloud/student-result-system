import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { Semester } from '../../src/models/Semester.js';

// sessionId values are plain new ObjectIds: the model does not check references, and these
// tests stay independent of the AcademicSession tests. Every test uses a fresh sessionId,
// so tests cannot collide with each other or with leftovers from an earlier run.
//
// Cleanup removes only what this file created: documents by id, and bulkWrite/cast-test
// documents by their sessionId.
const createdIds = [];
const trackedSessionIds = [];

const newId = () => new mongoose.Types.ObjectId();

async function makeSemester(overrides = {}) {
  const sessionId = overrides.sessionId ?? newId();
  trackedSessionIds.push(sessionId);
  const doc = await Semester.create({ sessionId, number: 3, ...overrides });
  createdIds.push(doc._id);
  return doc;
}

const stored = (id) => Semester.findById(id).lean();

async function expectUnchanged(created) {
  const doc = await stored(created._id);
  expect(String(doc.sessionId)).toBe(String(created.sessionId));
  expect(doc.number).toBe(created.number);
}

// Returns the field names that failed validation. Any other kind of error is rethrown.
async function invalidPaths(data) {
  try {
    await new Semester(data).validate();
    return [];
  } catch (error) {
    if (error.name !== 'ValidationError') throw error;
    return Object.keys(error.errors);
  }
}

describe('Semester model', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Semester.init(); // wait for the compound unique index to finish building
  });

  afterAll(async () => {
    await Semester.deleteMany({
      $or: [{ _id: { $in: createdIds } }, { sessionId: { $in: trackedSessionIds } }],
    });
    await disconnectTestDb();
  });

  describe('validation (no database writes)', () => {
    it('accepts a valid semester', async () => {
      expect(await invalidPaths({ sessionId: newId(), number: 3 })).toEqual([]);
    });

    it('accepts every number from 1 to 12', async () => {
      for (let number = 1; number <= 12; number += 1) {
        expect(await invalidPaths({ sessionId: newId(), number }), String(number)).toEqual([]);
      }
    });

    it('rejects bad numbers', async () => {
      const cases = [
        ['missing', undefined],
        ['zero', 0],
        ['13', 13],
        ['negative', -1],
        ['fractional', 1.5],
        ['not a number', 'abc'],
        ['a numeric string with a fraction', '3.5'],
      ];
      for (const [label, number] of cases) {
        expect(await invalidPaths({ sessionId: newId(), number }), label).toContain('number');
      }
    });

    it('rejects a missing sessionId', async () => {
      expect(await invalidPaths({ number: 3 })).toContain('sessionId');
    });

    it('rejects a sessionId that is not an ObjectId', async () => {
      expect(await invalidPaths({ sessionId: 'not-an-id', number: 3 })).toContain('sessionId');
    });

    it("rejects an unknown field (strict: 'throw')", async () => {
      await expect(
        (async () => {
          const doc = new Semester({ sessionId: newId(), number: 3, label: 'x' });
          await doc.validate();
        })(),
      ).rejects.toThrow();
    });
  });

  describe('casting', () => {
    it("never stores the numeric string '3' as a string (the probe records cast or reject)", async () => {
      const sessionId = newId();
      trackedSessionIds.push(sessionId);

      let error = null;
      try {
        await Semester.create({ sessionId, number: '3' });
      } catch (caught) {
        error = caught;
      }

      if (error) {
        console.log(`SEMESTER CAST PROBE number '3': REJECTED (${error.name})`);
        expect(error.name).toBe('ValidationError');
      } else {
        // Read with the raw driver so Mongoose cannot hide what is really stored.
        const raw = await Semester.collection.findOne({ sessionId });
        console.log(
          `SEMESTER CAST PROBE number '3': ACCEPTED, stored ${JSON.stringify(raw.number)} of type ${typeof raw.number}`,
        );
        expect(typeof raw.number).toBe('number');
        expect(raw.number).toBe(3);
      }
    });
  });

  describe('storage and indexes', () => {
    it('saves a semester and adds timestamps', async () => {
      const created = await makeSemester({ number: 5 });
      const doc = await stored(created._id);
      expect(doc.number).toBe(5);
      expect(doc.createdAt).toBeInstanceOf(Date);
      expect(doc.updatedAt).toBeInstanceOf(Date);
    });

    it('rejects a second semester with the same session and number (code 11000)', async () => {
      const first = await makeSemester();
      await expect(
        Semester.create({ sessionId: first.sessionId, number: first.number }),
      ).rejects.toMatchObject({ code: 11000 });
      expect(await Semester.countDocuments({ sessionId: first.sessionId })).toBe(1);
    });

    it('allows the same number in different sessions', async () => {
      const a = await makeSemester({ number: 2 });
      const b = await makeSemester({ number: 2 });
      expect(await Semester.countDocuments({ _id: { $in: [a._id, b._id] } })).toBe(2);
    });

    it('allows different numbers in the same session', async () => {
      const sessionId = newId();
      await makeSemester({ sessionId, number: 1 });
      await makeSemester({ sessionId, number: 2 });
      await makeSemester({ sessionId, number: 3 });
      expect(await Semester.countDocuments({ sessionId })).toBe(3);
    });

    it('lets an unchanged document be saved again', async () => {
      const created = await makeSemester();
      const doc = await Semester.findById(created._id);
      await doc.save();
      await expectUnchanged(created);
    });

    it('DOCUMENTS the limit: a semester can point at a sessionId that has no AcademicSession', async () => {
      const created = await makeSemester();
      const matchingSessions = await mongoose.connection.db
        .collection('academicsessions')
        .countDocuments({ _id: created.sessionId });
      expect(matchingSessions).toBe(0);
      expect(await stored(created._id)).not.toBeNull();
    });
  });

  describe('sessionId and number are immutable', () => {
    for (const field of ['number', 'sessionId']) {
      it(`save() with a changed ${field} fails and the stored document is unchanged`, async () => {
        const created = await makeSemester();
        const doc = await Semester.findById(created._id);

        await expect(
          (async () => {
            doc[field] = field === 'number' ? 7 : newId();
            await doc.save();
          })(),
        ).rejects.toMatchObject({ name: 'ValidationError' });

        await expectUnchanged(created);
      });
    }

    // The seeded document has number 3, so the new value 7 is always a real change.
    const newValueFor = { number: () => 7, sessionId: () => newId() };
    const updateRoutes = [
      ['updateOne with $set', (field, id) =>
        Semester.updateOne({ _id: id }, { $set: { [field]: newValueFor[field]() } }).exec()],
      ['updateOne without an operator', (field, id) =>
        Semester.updateOne({ _id: id }, { [field]: newValueFor[field]() }).exec()],
      ['updateMany with $set', (field, id) =>
        Semester.updateMany({ _id: id }, { $set: { [field]: newValueFor[field]() } }).exec()],
      ['findOneAndUpdate with $set', (field, id) =>
        Semester.findOneAndUpdate({ _id: id }, { $set: { [field]: newValueFor[field]() } }).exec()],
      ['updateOne with $unset', (field, id) =>
        Semester.updateOne({ _id: id }, { $unset: { [field]: 1 } }).exec()],
      ['updateOne with $rename away from the field', (field, id) =>
        Semester.updateOne({ _id: id }, { $rename: { [field]: `old_${field}` } }).exec()],
    ];

    for (const field of ['number', 'sessionId']) {
      for (const [label, run] of updateRoutes) {
        it(`rejects ${label} on ${field} and leaves the stored document unchanged`, async () => {
          const created = await makeSemester();
          await expect(run(field, created._id)).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
          await expectUnchanged(created);
        });
      }
    }

    it('rejects $inc on number (Mongoose does not validate $inc, so the immutable hook must catch it)', async () => {
      const created = await makeSemester();
      await expect(
        Semester.updateOne({ _id: created._id }, { $inc: { number: 1 } }).exec(),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      await expectUnchanged(created);
    });

    const replacement = () => ({ sessionId: newId(), number: 8 });
    const replaceRoutes = [
      ['replaceOne', (id) => Semester.replaceOne({ _id: id }, replacement()).exec()],
      ['findOneAndReplace', (id) => Semester.findOneAndReplace({ _id: id }, replacement()).exec()],
      ['bulkWrite replaceOne', (id) =>
        Semester.bulkWrite([{ replaceOne: { filter: { _id: id }, replacement: replacement() } }])],
    ];

    for (const [label, run] of replaceRoutes) {
      it(`${label} is rejected with IMMUTABLE_FIELD and the stored document is unchanged`, async () => {
        const created = await makeSemester();
        await expect(run(created._id)).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
        await expectUnchanged(created);
      });
    }

    it('rejects bulkWrite updateOne on number with IMMUTABLE_FIELD and changes nothing', async () => {
      const created = await makeSemester();
      await expect(
        Semester.bulkWrite([
          { updateOne: { filter: { _id: created._id }, update: { $set: { number: 7 } } } },
        ]),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      await expectUnchanged(created);
    });

    it('rejects bulkWrite updateMany on sessionId with IMMUTABLE_FIELD and changes nothing', async () => {
      const created = await makeSemester();
      await expect(
        Semester.bulkWrite([
          { updateMany: { filter: { _id: created._id }, update: { $set: { sessionId: newId() } } } },
        ]),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      await expectUnchanged(created);
    });

    it('still allows a valid bulkWrite insertOne', async () => {
      const sessionId = newId();
      trackedSessionIds.push(sessionId);
      await Semester.bulkWrite([{ insertOne: { document: { sessionId, number: 4 } } }]);
      expect(await Semester.countDocuments({ sessionId })).toBe(1);
    });

    it('still validates a bulkWrite insertOne (number 13 rejected, nothing inserted)', async () => {
      const sessionId = newId();
      trackedSessionIds.push(sessionId);
      await expect(
        Semester.bulkWrite([{ insertOne: { document: { sessionId, number: 13 } } }]),
      ).rejects.toMatchObject({ name: 'ValidationError' });
      expect(await Semester.countDocuments({ sessionId })).toBe(0);
    });

    it('doc.updateOne() never changes the stored document (an error or a silent ignore is acceptable)', async () => {
      const created = await makeSemester();
      const doc = await Semester.findById(created._id);

      let outcome = 'no error (change silently ignored)';
      try {
        await doc.updateOne({ $set: { number: 7 } });
      } catch (error) {
        outcome = `threw ${error.code ?? error.name}`;
      }
      console.log('Semester doc.updateOne outcome:', outcome);

      await expectUnchanged(created);
    });

    it('reports IMMUTABLE_FIELD, not a validation error, when an update sets number to an invalid value', async () => {
      const created = await makeSemester();
      await expect(
        Semester.updateOne({ _id: created._id }, { $set: { number: 13 } }).exec(),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      await expectUnchanged(created);
    });
  });
});