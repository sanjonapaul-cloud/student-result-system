import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connectTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { Program } from '../../src/models/Program.js';

// Every program made here goes through makeProgram(), which records its id.
// Cleanup deletes only those ids, so other test files sharing srms_test are never disturbed.
const runTag = randomUUID().slice(0, 6).toUpperCase();
const createdIds = [];
let counter = 0;

function nextCode() {
  counter += 1;
  return `P${runTag}-${counter}`; // at most 10 characters, matches the program code pattern
}

function nextName() {
  counter += 1;
  return `Program ${runTag} ${counter}`;
}

async function makeProgram(overrides = {}) {
  const doc = await Program.create({ code: nextCode(), name: nextName(), ...overrides });
  createdIds.push(doc._id);
  return doc;
}

const stored = (id) => Program.findById(id).lean();

// Returns the field names that failed validation. Any other kind of error is rethrown.
async function invalidPaths(data) {
  try {
    await new Program(data).validate();
    return [];
  } catch (error) {
    if (error.name !== 'ValidationError') throw error;
    return Object.keys(error.errors);
  }
}

describe('Program model', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Program.init(); // wait for both unique indexes (one with a collation) to build
  });

  afterAll(async () => {
    await Program.deleteMany({ _id: { $in: createdIds } });
    await disconnectTestDb();
  });

  describe('validation (no database writes)', () => {
    it('accepts a valid program', async () => {
      expect(await invalidPaths({ code: 'BCA', name: 'Bachelor of Computer Applications' })).toEqual([]);
    });

    it('trims and uppercases code, and trims name', async () => {
      const doc = new Program({ code: '  bca  ', name: '  Computer Applications  ' });
      expect(doc.code).toBe('BCA');
      expect(doc.name).toBe('Computer Applications');
      expect(await invalidPaths({ code: '  bca  ', name: '  Computer Applications  ' })).toEqual([]);
    });

    it('rejects bad codes', async () => {
      const cases = [
        ['missing', undefined],
        ['only spaces', '   '],
        ['1 character', 'A'],
        ['13 characters', 'A'.repeat(13)],
        ['starts with a hyphen', '-AB'],
        ['starts with a slash', '/AB'],
        ['contains a space', 'AB C'],
        ['contains an underscore', 'AB_C'],
        ['contains a dot', 'AB.C'],
      ];
      for (const [label, code] of cases) {
        expect(await invalidPaths({ code, name: 'Valid Name' }), label).toContain('code');
      }
    });

    it('accepts the code length limits and the allowed characters', async () => {
      const accepted = ['AB', 'A'.repeat(12), 'BCA', 'B-TECH', 'CS/01', '1A'];
      for (const code of accepted) {
        expect(await invalidPaths({ code, name: 'Valid Name' }), code).toEqual([]);
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
        expect(await invalidPaths({ code: 'BCA', name }), label).toContain('name');
      }
    });

    it('accepts the name length limits', async () => {
      for (const name of ['AB', 'a'.repeat(100)]) {
        expect(await invalidPaths({ code: 'BCA', name }), String(name.length)).toEqual([]);
      }
    });

    it("rejects an unknown field (strict: 'throw')", async () => {
      await expect(
        (async () => {
          const doc = new Program({ code: 'BCA', name: 'Valid Name', nickname: 'x' });
          await doc.validate();
        })(),
      ).rejects.toThrow();
    });
  });

  describe('storage, indexes and editing', () => {
    it('saves a program, stores code in uppercase and adds timestamps', async () => {
      const expected = nextCode();
      const created = await makeProgram({ code: expected.toLowerCase() });

      const doc = await stored(created._id);
      expect(doc.code).toBe(expected);
      expect(doc.createdAt).toBeInstanceOf(Date);
      expect(doc.updatedAt).toBeInstanceOf(Date);
    });

    it('rejects a duplicate code, even in a different letter case (code 11000)', async () => {
      const first = await makeProgram();
      await expect(
        Program.create({ code: first.code.toLowerCase(), name: nextName() }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('rejects a duplicate name, even in a different letter case (code 11000)', async () => {
      const first = await makeProgram();
      await expect(
        Program.create({ code: nextCode(), name: first.name.toLowerCase() }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('allows two programs with different codes and names', async () => {
      const a = await makeProgram();
      const b = await makeProgram();
      expect(await Program.countDocuments({ _id: { $in: [a._id, b._id] } })).toBe(2);
    });

    it('allows changing code and name to new valid values, and uppercases the code', async () => {
      const created = await makeProgram();
      const nextCodeValue = nextCode();
      const nextNameValue = nextName();
      await Program.updateOne(
        { _id: created._id },
        { $set: { code: nextCodeValue.toLowerCase(), name: nextNameValue } },
      );

      const doc = await stored(created._id);
      expect(doc.code).toBe(nextCodeValue);
      expect(doc.name).toBe(nextNameValue);
    });

    it('rejects changing code to one that is already taken (code 11000)', async () => {
      const a = await makeProgram();
      const b = await makeProgram();
      await expect(
        Program.updateOne({ _id: b._id }, { $set: { code: a.code } }).exec(),
      ).rejects.toMatchObject({ code: 11000 });
      expect((await stored(b._id)).code).toBe(b.code);
    });

    it('rejects changing name to one that is taken in a different letter case (code 11000)', async () => {
      const a = await makeProgram();
      const b = await makeProgram();
      await expect(
        Program.updateOne({ _id: b._id }, { $set: { name: a.name.toLowerCase() } }).exec(),
      ).rejects.toMatchObject({ code: 11000 });
      expect((await stored(b._id)).name).toBe(b.name);
    });

    it('rejects updates that set an invalid code or name, and leaves the stored values unchanged', async () => {
      const created = await makeProgram();
      const runs = [
        ['updateOne invalid code', () =>
          Program.updateOne({ _id: created._id }, { $set: { code: 'bad value!' } }).exec()],
        ['updateOne invalid name', () =>
          Program.updateOne({ _id: created._id }, { $set: { name: 'A' } }).exec()],
        ['findOneAndUpdate invalid code', () =>
          Program.findOneAndUpdate({ _id: created._id }, { $set: { code: 'bad value!' } }).exec()],
        ['updateMany invalid name', () =>
          Program.updateMany({ _id: created._id }, { $set: { name: 'A' } }).exec()],
      ];
      for (const [label, run] of runs) {
        await expect(run(), label).rejects.toMatchObject({ name: 'ValidationError' });
      }

      const doc = await stored(created._id);
      expect(doc.code).toBe(created.code);
      expect(doc.name).toBe(created.name);
    });

    it('finds a program by a lowercase code in a query filter (filters are uppercased)', async () => {
      const created = await makeProgram();
      const found = await Program.findOne({ code: created.code.toLowerCase() }).lean();
      expect(found).not.toBeNull();
      expect(String(found._id)).toBe(String(created._id));
    });
  });

  describe('bulkWrite (updates are refused, inserts are allowed)', () => {
    it('refuses bulkWrite updateOne on name and changes nothing', async () => {
      const created = await makeProgram();
      await expect(
        Program.bulkWrite([
          { updateOne: { filter: { _id: created._id }, update: { $set: { name: nextName() } } } },
        ]),
      ).rejects.toMatchObject({ code: 'BULK_UPDATE_NOT_ALLOWED' });
      expect((await stored(created._id)).name).toBe(created.name);
    });

    it('still validates a bulkWrite insertOne (invalid code rejected, nothing inserted)', async () => {
      const name = nextName();
      await expect(
        Program.bulkWrite([{ insertOne: { document: { code: 'bad value!', name } } }]),
      ).rejects.toMatchObject({ name: 'ValidationError' });
      expect(await Program.countDocuments({ name })).toBe(0);
    });
  });

    describe('replacing a whole document is refused', () => {
    // The same invalid replacement the probe used. It is refused before validation matters.
    const replacement = { code: 'bad value!', name: `Replaced ${runTag}` };

    const routes = [
      ['replaceOne', (id) => Program.replaceOne({ _id: id }, replacement).exec()],
      ['findOneAndReplace', (id) => Program.findOneAndReplace({ _id: id }, replacement).exec()],
      ['bulkWrite replaceOne', (id) =>
        Program.bulkWrite([{ replaceOne: { filter: { _id: id }, replacement } }])],
    ];

    it.each(routes)('%s is refused with REPLACE_NOT_ALLOWED and the stored document is unchanged', async (_label, run) => {
      const created = await makeProgram();
      await expect(run(created._id)).rejects.toMatchObject({ code: 'REPLACE_NOT_ALLOWED' });

      const doc = await stored(created._id);
      expect(doc.code).toBe(created.code);
      expect(doc.name).toBe(created.name);
    });
  });
});