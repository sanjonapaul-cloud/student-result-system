import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { Subject } from '../../src/models/Subject.js';

// programId values are plain new ObjectIds: the model does not check references, and these
// tests stay independent of the Program tests.
//
// Every subject made here has a code that starts with this run's tag. Cleanup removes only
// documents this file created, by id or by tracked code.
const runTag = randomUUID().slice(0, 6).toUpperCase();
const createdIds = [];
const trackedCodes = [];
let counter = 0;

function nextCode() {
  counter += 1;
  const code = `S${runTag}-${counter}`; // at most 11 characters, matches the subject code pattern
  trackedCodes.push(code);
  return code;
}

function nextName() {
  counter += 1;
  return `Subject ${runTag} ${counter}`;
}

const newId = () => new mongoose.Types.ObjectId();

async function makeSubject(overrides = {}) {
  const doc = await Subject.create({
    programId: newId(),
    code: nextCode(),
    name: nextName(),
    credits: 3,
    ...overrides,
  });
  createdIds.push(doc._id);
  return doc;
}

const stored = (id) => Subject.findById(id).lean();

async function expectUnchanged(created) {
  const doc = await stored(created._id);
  expect(String(doc.programId)).toBe(String(created.programId));
  expect(doc.code).toBe(created.code);
  expect(doc.name).toBe(created.name);
  expect(doc.credits).toBe(created.credits);
}

// Returns the field names that failed validation. Any other kind of error is rethrown.
async function invalidPaths(data) {
  try {
    await new Subject(data).validate();
    return [];
  } catch (error) {
    if (error.name !== 'ValidationError') throw error;
    return Object.keys(error.errors);
  }
}

const validData = () => ({ programId: newId(), code: 'CS101', name: 'Data Structures', credits: 4 });

describe('Subject model', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Subject.init(); // wait for the unique code index to finish building
  });

  afterAll(async () => {
    await Subject.deleteMany({
      $or: [{ _id: { $in: createdIds } }, { code: { $in: trackedCodes } }],
    });
    await disconnectTestDb();
  });

  describe('validation (no database writes)', () => {
    it('accepts a valid subject', async () => {
      expect(await invalidPaths(validData())).toEqual([]);
    });

    it('trims and uppercases code, and trims name', async () => {
      const doc = new Subject({ ...validData(), code: '  cs101  ', name: '  Data Structures  ' });
      expect(doc.code).toBe('CS101');
      expect(doc.name).toBe('Data Structures');
      await doc.validate();
    });

    it('rejects bad codes', async () => {
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
      for (const [label, code] of cases) {
        expect(await invalidPaths({ ...validData(), code }), label).toContain('code');
      }
    });

    it('accepts the code length limits and the allowed characters', async () => {
      const accepted = ['ABC', 'A'.repeat(20), 'CS101', 'CS/101', '1A2'];
      for (const code of accepted) {
        expect(await invalidPaths({ ...validData(), code }), code).toEqual([]);
      }
    });

    it('rejects bad names', async () => {
      const cases = [
        ['missing', undefined],
        ['only spaces', '   '],
        ['1 character', 'A'],
        ['101 characters', 'a'.repeat(101)],
      ];
      for (const [label, name] of cases) {
        expect(await invalidPaths({ ...validData(), name }), label).toContain('name');
      }
    });

    it('accepts the name length limits', async () => {
      for (const name of ['AB', 'a'.repeat(100)]) {
        expect(await invalidPaths({ ...validData(), name }), String(name.length)).toEqual([]);
      }
    });

    it('rejects bad credits', async () => {
      const cases = [
        ['missing', undefined],
        ['negative', -1],
        ['21', 21],
        ['fractional', 1.5],
        ['not a number', 'abc'],
        ['a numeric string with a fraction', '2.5'],
      ];
      for (const [label, credits] of cases) {
        expect(await invalidPaths({ ...validData(), credits }), label).toContain('credits');
      }
    });

    it('accepts credits from 0 to 20', async () => {
      for (const credits of [0, 1, 4, 20]) {
        expect(await invalidPaths({ ...validData(), credits }), String(credits)).toEqual([]);
      }
    });

    it('rejects a missing programId', async () => {
      const { programId: _omitted, ...withoutProgram } = validData();
      expect(await invalidPaths(withoutProgram)).toContain('programId');
    });

    it('rejects a programId that is not an ObjectId', async () => {
      expect(await invalidPaths({ ...validData(), programId: 'not-an-id' })).toContain('programId');
    });

    it("rejects an unknown field (strict: 'throw')", async () => {
      await expect(
        (async () => {
          const doc = new Subject({ ...validData(), nickname: 'x' });
          await doc.validate();
        })(),
      ).rejects.toThrow();
    });
  });

  describe('storage, indexes and editing', () => {
    it('saves a subject, stores code in uppercase and adds timestamps', async () => {
      const expected = nextCode();
      const created = await makeSubject({ code: expected.toLowerCase() });

      const doc = await stored(created._id);
      expect(doc.code).toBe(expected);
      expect(doc.createdAt).toBeInstanceOf(Date);
      expect(doc.updatedAt).toBeInstanceOf(Date);
    });

    it('rejects a duplicate code, even in a different letter case (code 11000)', async () => {
      const first = await makeSubject();
      await expect(
        Subject.create({ ...validData(), code: first.code.toLowerCase(), name: nextName() }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('rejects the same code in a different program (codes are unique across the system)', async () => {
      const first = await makeSubject();
      await expect(
        Subject.create({ programId: newId(), code: first.code, name: nextName(), credits: 2 }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('allows two subjects with the same name (names are not unique)', async () => {
      const programId = newId();
      const name = nextName();
      const a = await makeSubject({ programId, name });
      const b = await makeSubject({ programId, name });
      expect(await Subject.countDocuments({ _id: { $in: [a._id, b._id] } })).toBe(2);
    });

    it('allows changing code, name and credits to new valid values, and uppercases the code', async () => {
      const created = await makeSubject();
      const nextCodeValue = nextCode();
      const nextNameValue = nextName();
      await Subject.updateOne(
        { _id: created._id },
        { $set: { code: nextCodeValue.toLowerCase(), name: nextNameValue, credits: 5 } },
      );

      const doc = await stored(created._id);
      expect(doc.code).toBe(nextCodeValue);
      expect(doc.name).toBe(nextNameValue);
      expect(doc.credits).toBe(5);
      expect(String(doc.programId)).toBe(String(created.programId));
    });

    it('rejects changing code to one that is already taken (code 11000)', async () => {
      const a = await makeSubject();
      const b = await makeSubject();
      await expect(
        Subject.updateOne({ _id: b._id }, { $set: { code: a.code } }).exec(),
      ).rejects.toMatchObject({ code: 11000 });
      await expectUnchanged(b);
    });

    it('rejects updates that set an invalid value, and leaves the stored document unchanged', async () => {
      const created = await makeSubject();
      const runs = [
        ['updateOne invalid code', () =>
          Subject.updateOne({ _id: created._id }, { $set: { code: 'bad value!' } }).exec()],
        ['updateOne credits above 20', () =>
          Subject.updateOne({ _id: created._id }, { $set: { credits: 21 } }).exec()],
        ['findOneAndUpdate fractional credits', () =>
          Subject.findOneAndUpdate({ _id: created._id }, { $set: { credits: 1.5 } }).exec()],
        ['updateMany invalid name', () =>
          Subject.updateMany({ _id: created._id }, { $set: { name: 'A' } }).exec()],
      ];
      for (const [label, run] of runs) {
        await expect(run(), label).rejects.toMatchObject({ name: 'ValidationError' });
      }
      await expectUnchanged(created);
    });

    it('finds a subject by a lowercase code in a query filter (filters are uppercased)', async () => {
      const created = await makeSubject();
      const found = await Subject.findOne({ code: created.code.toLowerCase() }).lean();
      expect(found).not.toBeNull();
      expect(String(found._id)).toBe(String(created._id));
    });

    it('DOCUMENTS the limit: a subject can point at a programId that has no Program', async () => {
      const created = await makeSubject();
      const matchingPrograms = await mongoose.connection.db
        .collection('programs')
        .countDocuments({ _id: created.programId });
      expect(matchingPrograms).toBe(0);
      expect(await stored(created._id)).not.toBeNull();
    });

    it('RECORDS whether $inc on credits is validated (a probe, not a requirement)', async () => {
      const created = await makeSubject({ credits: 3 });
      let outcome;
      try {
        await Subject.updateOne({ _id: created._id }, { $inc: { credits: 100 } });
        outcome = `ACCEPTED; stored credits is now ${(await stored(created._id)).credits}`;
      } catch (error) {
        outcome = `REJECTED (${error.code ?? error.name})`;
      }
      console.log('PROBE $inc that takes credits above 20:', outcome);
      expect(typeof outcome).toBe('string');
    });
  });

  describe('bulkWrite (updates are refused, inserts are allowed)', () => {
    it('refuses bulkWrite updateOne on name and changes nothing', async () => {
      const created = await makeSubject();
      await expect(
        Subject.bulkWrite([
          { updateOne: { filter: { _id: created._id }, update: { $set: { name: nextName() } } } },
        ]),
      ).rejects.toMatchObject({ code: 'BULK_UPDATE_NOT_ALLOWED' });
      await expectUnchanged(created);
    });

    it('still validates a bulkWrite insertOne (credits 21 rejected, nothing inserted)', async () => {
      const code = nextCode();
      await expect(
        Subject.bulkWrite([
          { insertOne: { document: { programId: newId(), code, name: nextName(), credits: 21 } } },
        ]),
      ).rejects.toMatchObject({ name: 'ValidationError' });
      expect(await Subject.countDocuments({ code })).toBe(0);
    });

    it('still allows a valid bulkWrite insertOne', async () => {
      const code = nextCode();
      await Subject.bulkWrite([
        { insertOne: { document: { programId: newId(), code, name: nextName(), credits: 2 } } },
      ]);
      expect(await Subject.countDocuments({ code })).toBe(1);
    });
  });

  describe('programId is immutable', () => {
    it('save() with a changed programId fails and the stored document is unchanged', async () => {
      const created = await makeSubject();
      const doc = await Subject.findById(created._id);

      await expect(
        (async () => {
          doc.programId = newId();
          await doc.save();
        })(),
      ).rejects.toMatchObject({ name: 'ValidationError' });

      await expectUnchanged(created);
    });

    const updateRoutes = [
      ['updateOne with $set', (id) =>
        Subject.updateOne({ _id: id }, { $set: { programId: newId() } }).exec()],
      ['updateOne without an operator', (id) =>
        Subject.updateOne({ _id: id }, { programId: newId() }).exec()],
      ['updateMany with $set', (id) =>
        Subject.updateMany({ _id: id }, { $set: { programId: newId() } }).exec()],
      ['findOneAndUpdate with $set', (id) =>
        Subject.findOneAndUpdate({ _id: id }, { $set: { programId: newId() } }).exec()],
      ['updateOne with $unset', (id) =>
        Subject.updateOne({ _id: id }, { $unset: { programId: 1 } }).exec()],
      ['updateOne with $rename away from the field', (id) =>
        Subject.updateOne({ _id: id }, { $rename: { programId: 'oldProgramId' } }).exec()],
    ];

    for (const [label, run] of updateRoutes) {
      it(`rejects ${label} and leaves the stored document unchanged`, async () => {
        const created = await makeSubject();
        await expect(run(created._id)).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
        await expectUnchanged(created);
      });
    }

    const replacement = () => ({ programId: newId(), code: nextCode(), name: nextName(), credits: 2 });
    const replaceRoutes = [
      ['replaceOne', (id) => Subject.replaceOne({ _id: id }, replacement()).exec()],
      ['findOneAndReplace', (id) => Subject.findOneAndReplace({ _id: id }, replacement()).exec()],
      ['bulkWrite replaceOne', (id) =>
        Subject.bulkWrite([{ replaceOne: { filter: { _id: id }, replacement: replacement() } }])],
    ];

    for (const [label, run] of replaceRoutes) {
      it(`${label} is rejected with IMMUTABLE_FIELD and the stored document is unchanged`, async () => {
        const created = await makeSubject();
        await expect(run(created._id)).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
        await expectUnchanged(created);
      });
    }

    it('doc.updateOne() never changes the stored document (an error or a silent ignore is acceptable)', async () => {
      const created = await makeSubject();
      const doc = await Subject.findById(created._id);

      let outcome = 'no error (change silently ignored)';
      try {
        await doc.updateOne({ $set: { programId: newId() } });
      } catch (error) {
        outcome = `threw ${error.code ?? error.name}`;
      }
      console.log('Subject doc.updateOne outcome:', outcome);

      await expectUnchanged(created);
    });

    it('reports IMMUTABLE_FIELD, not a validation error, when an update changes programId and sets invalid credits', async () => {
      const created = await makeSubject();
      await expect(
        Subject.updateOne(
          { _id: created._id },
          { $set: { programId: newId(), credits: 99 } },
        ).exec(),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      await expectUnchanged(created);
    });
  });
});