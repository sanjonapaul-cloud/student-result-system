import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { Class } from '../../src/models/Class.js';

// programId and semesterId values are plain new ObjectIds: the model does not check
// references, and these tests stay independent of the other model tests. Every test uses
// fresh ids, so tests cannot collide with each other or with leftovers from an earlier run.
//
// Cleanup removes only what this file created: documents by id, and bulkWrite-created
// documents by their semesterId.
const createdIds = [];
const trackedSemesterIds = [];

const newId = () => new mongoose.Types.ObjectId();

async function makeClass(overrides = {}) {
  const semesterId = overrides.semesterId ?? newId();
  trackedSemesterIds.push(semesterId);
  const doc = await Class.create({ programId: newId(), section: 'A', ...overrides, semesterId });
  createdIds.push(doc._id);
  return doc;
}

const stored = (id) => Class.findById(id).lean();

async function expectUnchanged(created) {
  const doc = await stored(created._id);
  expect(String(doc.programId)).toBe(String(created.programId));
  expect(String(doc.semesterId)).toBe(String(created.semesterId));
  expect(doc.section).toBe(created.section);
  expect(doc.inputRevision).toBe(created.inputRevision);
}

// Returns the field names that failed validation. Any other kind of error is rethrown.
async function invalidPaths(data) {
  try {
    await new Class(data).validate();
    return [];
  } catch (error) {
    if (error.name !== 'ValidationError') throw error;
    return Object.keys(error.errors);
  }
}

const validData = () => ({ programId: newId(), semesterId: newId(), section: 'A' });

describe('Class model', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Class.init(); // wait for the compound unique index to finish building
  });

  afterAll(async () => {
    await Class.deleteMany({
      $or: [{ _id: { $in: createdIds } }, { semesterId: { $in: trackedSemesterIds } }],
    });
    await disconnectTestDb();
  });

  describe('validation (no database writes)', () => {
    it('accepts a valid class and applies the defaults', async () => {
      const doc = new Class(validData());
      await doc.validate(); // throws if invalid
      expect(doc.inputRevision).toBe(0);
      expect(doc.resultsPublishedAt).toBeNull();
    });

    it('trims and uppercases section', async () => {
      const doc = new Class({ ...validData(), section: '  ab  ' });
      expect(doc.section).toBe('AB');
      await doc.validate();
    });

    it('rejects bad sections', async () => {
      const cases = [
        ['missing', undefined],
        ['only spaces', '   '],
        ['6 characters', 'ABCDEF'],
        ['contains a hyphen', 'A-B'],
        ['contains a space', 'A B'],
        ['contains an underscore', 'A_B'],
        ['contains a slash', 'A/B'],
      ];
      for (const [label, section] of cases) {
        expect(await invalidPaths({ ...validData(), section }), label).toContain('section');
      }
    });

    it('accepts the section length limits and the allowed characters', async () => {
      for (const section of ['A', '1', 'AB12C', '12345', 'a']) {
        expect(await invalidPaths({ ...validData(), section }), section).toEqual([]);
      }
    });

    it('rejects a negative, fractional or non-numeric inputRevision', async () => {
      const cases = [
        ['negative', -1],
        ['fractional', 1.5],
        ['not a number', 'abc'],
      ];
      for (const [label, inputRevision] of cases) {
        expect(await invalidPaths({ ...validData(), inputRevision }), label).toContain(
          'inputRevision',
        );
      }
    });

    it('rejects a resultsPublishedAt that is not a date', async () => {
      expect(await invalidPaths({ ...validData(), resultsPublishedAt: 'not a date' })).toContain(
        'resultsPublishedAt',
      );
    });

    it('rejects a missing programId or semesterId', async () => {
      for (const field of ['programId', 'semesterId']) {
        const data = validData();
        delete data[field];
        expect(await invalidPaths(data), field).toContain(field);
      }
    });

    it('rejects a programId or semesterId that is not an ObjectId', async () => {
      for (const field of ['programId', 'semesterId']) {
        expect(await invalidPaths({ ...validData(), [field]: 'not-an-id' }), field).toContain(field);
      }
    });

    it("rejects an unknown field (strict: 'throw')", async () => {
      await expect(
        (async () => {
          const doc = new Class({ ...validData(), nickname: 'x' });
          await doc.validate();
        })(),
      ).rejects.toThrow();
    });
  });

  describe('storage, indexes and editing', () => {
    it('saves a class, stores the defaults and adds timestamps', async () => {
      const created = await makeClass({ section: 'b' });

      const doc = await stored(created._id);
      expect(doc.section).toBe('B');
      expect(doc.inputRevision).toBe(0);
      expect(doc.resultsPublishedAt ?? null).toBeNull();
      expect(doc.createdAt).toBeInstanceOf(Date);
      expect(doc.updatedAt).toBeInstanceOf(Date);
    });

    it('rejects a second class with the same program, semester and section (code 11000), also in lowercase', async () => {
      const first = await makeClass();
      await expect(
        Class.create({
          programId: first.programId,
          semesterId: first.semesterId,
          section: first.section,
        }),
      ).rejects.toMatchObject({ code: 11000 });
      await expect(
        Class.create({
          programId: first.programId,
          semesterId: first.semesterId,
          section: first.section.toLowerCase(),
        }),
      ).rejects.toMatchObject({ code: 11000 });
      expect(
        await Class.countDocuments({ programId: first.programId, semesterId: first.semesterId }),
      ).toBe(1);
    });

    it('allows the same section in a different semester, or in a different program', async () => {
      const a = await makeClass();
      const otherSemester = await makeClass({ programId: a.programId, section: a.section });
      const otherProgram = await makeClass({ semesterId: a.semesterId, section: a.section });
      expect(
        await Class.countDocuments({ _id: { $in: [a._id, otherSemester._id, otherProgram._id] } }),
      ).toBe(3);
    });

    it('allows different sections in the same program and semester', async () => {
      const a = await makeClass({ section: 'A' });
      const b = await makeClass({ programId: a.programId, semesterId: a.semesterId, section: 'B' });
      expect(await Class.countDocuments({ _id: { $in: [a._id, b._id] } })).toBe(2);
    });

    it('allows changing section to a new valid value, and uppercases it', async () => {
      const created = await makeClass();
      await Class.updateOne({ _id: created._id }, { $set: { section: 'c' } });

      const doc = await stored(created._id);
      expect(doc.section).toBe('C');
      expect(String(doc.programId)).toBe(String(created.programId));
      expect(String(doc.semesterId)).toBe(String(created.semesterId));
    });

    it('rejects changing section to one that already exists for the same program and semester (code 11000)', async () => {
      const a = await makeClass({ section: 'A' });
      const b = await makeClass({ programId: a.programId, semesterId: a.semesterId, section: 'B' });
      await expect(
        Class.updateOne({ _id: b._id }, { $set: { section: 'A' } }).exec(),
      ).rejects.toMatchObject({ code: 11000 });
      await expectUnchanged(b);
    });

    it('rejects updates that set an invalid section, and leaves the stored document unchanged', async () => {
      const created = await makeClass();
      const runs = [
        ['updateOne', () =>
          Class.updateOne({ _id: created._id }, { $set: { section: 'bad value!' } }).exec()],
        ['findOneAndUpdate', () =>
          Class.findOneAndUpdate({ _id: created._id }, { $set: { section: 'TOOLONG' } }).exec()],
        ['updateMany', () =>
          Class.updateMany({ _id: created._id }, { $set: { section: '' } }).exec()],
      ];
      for (const [label, run] of runs) {
        await expect(run(), label).rejects.toMatchObject({ name: 'ValidationError' });
      }
      await expectUnchanged(created);
    });

    it('finds a class by a lowercase section in a query filter (filters are uppercased)', async () => {
      const created = await makeClass();
      const found = await Class.findOne({
        semesterId: created.semesterId,
        section: created.section.toLowerCase(),
      }).lean();
      expect(found).not.toBeNull();
      expect(String(found._id)).toBe(String(created._id));
    });

    it('DOCUMENTS the limit: a class can point at a programId and semesterId that do not exist', async () => {
      const created = await makeClass();
      const matchingPrograms = await mongoose.connection.db
        .collection('programs')
        .countDocuments({ _id: created.programId });
      const matchingSemesters = await mongoose.connection.db
        .collection('semesters')
        .countDocuments({ _id: created.semesterId });
      expect(matchingPrograms).toBe(0);
      expect(matchingSemesters).toBe(0);
      expect(await stored(created._id)).not.toBeNull();
    });
  });

  describe('anchor fields (inputRevision, resultsPublishedAt)', () => {
    it('allows $inc of +1 on inputRevision, which is how a service bumps it', async () => {
      const created = await makeClass();
      await Class.updateOne({ _id: created._id }, { $inc: { inputRevision: 1 } });
      await Class.updateOne({ _id: created._id }, { $inc: { inputRevision: 1 } });
      expect((await stored(created._id)).inputRevision).toBe(2);
    });

    it('RECORDS whether $inc is validated on inputRevision (a probe, not a requirement)', async () => {
      const created = await makeClass();
      let outcome;
      try {
        await Class.updateOne({ _id: created._id }, { $inc: { inputRevision: -5 } });
        outcome = `ACCEPTED; stored inputRevision is now ${(await stored(created._id)).inputRevision}`;
      } catch (error) {
        outcome = `REJECTED (${error.code ?? error.name})`;
      }
      console.log('PROBE $inc that takes inputRevision below 0:', outcome);
      expect(typeof outcome).toBe('string');
    });

    it('rejects $set of a negative or fractional inputRevision, and leaves it unchanged', async () => {
      const created = await makeClass();
      for (const value of [-1, 1.5]) {
        await expect(
          Class.updateOne({ _id: created._id }, { $set: { inputRevision: value } }).exec(),
          String(value),
        ).rejects.toMatchObject({ name: 'ValidationError' });
      }
      await expectUnchanged(created);
    });

    it('allows resultsPublishedAt to be set to a date and cleared again', async () => {
      const created = await makeClass();
      const when = new Date('2027-05-01T10:00:00Z');

      await Class.updateOne({ _id: created._id }, { $set: { resultsPublishedAt: when } });
      expect((await stored(created._id)).resultsPublishedAt.getTime()).toBe(when.getTime());

      await Class.updateOne({ _id: created._id }, { $set: { resultsPublishedAt: null } });
      expect((await stored(created._id)).resultsPublishedAt).toBeNull();
    });
  });

  describe('bulkWrite (updates are refused, inserts are allowed)', () => {
    it('refuses bulkWrite updateOne on section and changes nothing', async () => {
      const created = await makeClass();
      await expect(
        Class.bulkWrite([
          { updateOne: { filter: { _id: created._id }, update: { $set: { section: 'Z' } } } },
        ]),
      ).rejects.toMatchObject({ code: 'BULK_UPDATE_NOT_ALLOWED' });
      await expectUnchanged(created);
    });

    it('still validates a bulkWrite insertOne (invalid section rejected, nothing inserted)', async () => {
      const semesterId = newId();
      trackedSemesterIds.push(semesterId);
      await expect(
        Class.bulkWrite([
          { insertOne: { document: { programId: newId(), semesterId, section: 'bad value!' } } },
        ]),
      ).rejects.toMatchObject({ name: 'ValidationError' });
      expect(await Class.countDocuments({ semesterId })).toBe(0);
    });

    it('still allows a valid bulkWrite insertOne', async () => {
      const semesterId = newId();
      trackedSemesterIds.push(semesterId);
      await Class.bulkWrite([
        { insertOne: { document: { programId: newId(), semesterId, section: 'A' } } },
      ]);
      expect(await Class.countDocuments({ semesterId })).toBe(1);
    });
  });

  describe('programId and semesterId are immutable', () => {
    for (const field of ['programId', 'semesterId']) {
      it(`save() with a changed ${field} fails and the stored document is unchanged`, async () => {
        const created = await makeClass();
        const doc = await Class.findById(created._id);

        await expect(
          (async () => {
            doc[field] = newId();
            await doc.save();
          })(),
        ).rejects.toMatchObject({ name: 'ValidationError' });

        await expectUnchanged(created);
      });
    }

    const updateRoutes = [
      ['updateOne with $set', (field, id) =>
        Class.updateOne({ _id: id }, { $set: { [field]: newId() } }).exec()],
      ['updateOne without an operator', (field, id) =>
        Class.updateOne({ _id: id }, { [field]: newId() }).exec()],
      ['updateMany with $set', (field, id) =>
        Class.updateMany({ _id: id }, { $set: { [field]: newId() } }).exec()],
      ['findOneAndUpdate with $set', (field, id) =>
        Class.findOneAndUpdate({ _id: id }, { $set: { [field]: newId() } }).exec()],
      ['updateOne with $unset', (field, id) =>
        Class.updateOne({ _id: id }, { $unset: { [field]: 1 } }).exec()],
      ['updateOne with $rename away from the field', (field, id) =>
        Class.updateOne({ _id: id }, { $rename: { [field]: `old_${field}` } }).exec()],
    ];

    for (const field of ['programId', 'semesterId']) {
      for (const [label, run] of updateRoutes) {
        it(`rejects ${label} on ${field} and leaves the stored document unchanged`, async () => {
          const created = await makeClass();
          await expect(run(field, created._id)).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
          await expectUnchanged(created);
        });
      }
    }

    const replacement = () => ({ programId: newId(), semesterId: newId(), section: 'B' });
    const replaceRoutes = [
      ['replaceOne', (id) => Class.replaceOne({ _id: id }, replacement()).exec()],
      ['findOneAndReplace', (id) => Class.findOneAndReplace({ _id: id }, replacement()).exec()],
      ['bulkWrite replaceOne', (id) =>
        Class.bulkWrite([{ replaceOne: { filter: { _id: id }, replacement: replacement() } }])],
    ];

    for (const [label, run] of replaceRoutes) {
      it(`${label} is rejected with IMMUTABLE_FIELD and the stored document is unchanged`, async () => {
        const created = await makeClass();
        await expect(run(created._id)).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
        await expectUnchanged(created);
      });
    }

    it('doc.updateOne() never changes the stored document (an error or a silent ignore is acceptable)', async () => {
      const created = await makeClass();
      const doc = await Class.findById(created._id);

      let outcome = 'no error (change silently ignored)';
      try {
        await doc.updateOne({ $set: { semesterId: newId() } });
      } catch (error) {
        outcome = `threw ${error.code ?? error.name}`;
      }
      console.log('Class doc.updateOne outcome:', outcome);

      await expectUnchanged(created);
    });

    it('reports IMMUTABLE_FIELD, not a validation error, when an update changes semesterId and sets an invalid section', async () => {
      const created = await makeClass();
      await expect(
        Class.updateOne(
          { _id: created._id },
          { $set: { semesterId: newId(), section: 'bad value!' } },
        ).exec(),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      await expectUnchanged(created);
    });
  });
});