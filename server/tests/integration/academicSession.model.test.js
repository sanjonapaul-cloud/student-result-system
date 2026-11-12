import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connectTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { AcademicSession } from '../../src/models/AcademicSession.js';

// RULE: the "one active session" index is global in srms_test, so ONLY THIS FILE may create a
// session with isActive: true. Other test files must create sessions inactive (the default).
//
// Every session made here goes through makeSession(), which records its id and uses a name
// with a fixed prefix. beforeAll removes leftovers with that prefix from a crashed earlier
// run, so a stray active session cannot break this run. Cleanup deletes only recorded ids.
const NAME_PREFIX = 'ZZ-TEST-SESSION';
const runTag = randomUUID().slice(0, 6).toUpperCase();
const createdIds = [];
let counter = 0;

const START = new Date('2026-07-01');
const END = new Date('2027-06-30');

function nextName() {
  counter += 1;
  return `${NAME_PREFIX} ${runTag} ${counter}`; // 25 characters
}

async function makeSession(overrides = {}) {
  const doc = await AcademicSession.create({
    name: nextName(),
    startDate: START,
    endDate: END,
    ...overrides,
  });
  createdIds.push(doc._id);
  return doc;
}

const stored = (id) => AcademicSession.findById(id).lean();

// Returns the field names that failed validation. Any other kind of error is rethrown.
async function invalidPaths(data) {
  try {
    await new AcademicSession(data).validate();
    return [];
  } catch (error) {
    if (error.name !== 'ValidationError') throw error;
    return Object.keys(error.errors);
  }
}

describe('AcademicSession model', () => {
  beforeAll(async () => {
    await connectTestDb();
    await AcademicSession.deleteMany({ name: { $regex: `^${NAME_PREFIX}` } });
    await AcademicSession.init(); // wait for the collation index and the partial index to build
  });

    // Delete each test's sessions as soon as it ends. A test that creates an active session
  // must not leave it behind for the next test, because only one session can be active.
  afterEach(async () => {
    await AcademicSession.deleteMany({ _id: { $in: createdIds } });
    createdIds.length = 0;
  });

  afterAll(async () => {
    await AcademicSession.deleteMany({ _id: { $in: createdIds } });
    await disconnectTestDb();
  });

  describe('validation (no database writes)', () => {
    it('accepts a valid session and defaults isActive to false', async () => {
      const doc = new AcademicSession({ name: '2026-27', startDate: START, endDate: END });
      await doc.validate(); // throws if invalid
      expect(doc.isActive).toBe(false);
    });

    it('trims the name', async () => {
      const doc = new AcademicSession({ name: '  2026-27  ', startDate: START, endDate: END });
      expect(doc.name).toBe('2026-27');
      await doc.validate();
    });

    it('rejects bad names', async () => {
      const cases = [
        ['missing', undefined],
        ['only spaces', '   '],
        ['2 characters', 'AB'],
        ['51 characters', 'a'.repeat(51)],
      ];
      for (const [label, name] of cases) {
        expect(await invalidPaths({ name, startDate: START, endDate: END }), label).toContain('name');
      }
    });

    it('accepts the name length limits', async () => {
      for (const name of ['ABC', 'a'.repeat(50)]) {
        expect(await invalidPaths({ name, startDate: START, endDate: END }), String(name.length)).toEqual([]);
      }
    });

    it('rejects missing or unreadable dates', async () => {
      const cases = [
        ['missing startDate', { endDate: END }, 'startDate'],
        ['missing endDate', { startDate: START }, 'endDate'],
        ['unreadable startDate', { startDate: 'not a date', endDate: END }, 'startDate'],
        ['unreadable endDate', { startDate: START, endDate: 'not a date' }, 'endDate'],
      ];
      for (const [label, dates, path] of cases) {
        expect(await invalidPaths({ name: '2026-27', ...dates }), label).toContain(path);
      }
    });

    it('rejects an end date before the start date, or equal to it', async () => {
      const cases = [
        ['end before start', { startDate: START, endDate: new Date('2026-06-30') }],
        ['end equal to start', { startDate: START, endDate: START }],
      ];
      for (const [label, dates] of cases) {
        expect(await invalidPaths({ name: '2026-27', ...dates }), label).toContain('endDate');
      }
    });

    it('accepts an end date one day after the start date', async () => {
      expect(
        await invalidPaths({ name: '2026-27', startDate: START, endDate: new Date('2026-07-02') }),
      ).toEqual([]);
    });

    it("rejects an unknown field (strict: 'throw')", async () => {
      await expect(
        (async () => {
          const doc = new AcademicSession({
            name: '2026-27',
            startDate: START,
            endDate: END,
            nickname: 'x',
          });
          await doc.validate();
        })(),
      ).rejects.toThrow();
    });
  });

  describe('storage, indexes and editing', () => {
    it('saves a session, trims the name, defaults isActive to false and adds timestamps', async () => {
      const name = nextName();
      const created = await makeSession({ name: `  ${name}  ` });

      const doc = await stored(created._id);
      expect(doc.name).toBe(name);
      expect(doc.isActive).toBe(false);
      expect(doc.createdAt).toBeInstanceOf(Date);
      expect(doc.updatedAt).toBeInstanceOf(Date);
    });

    it('rejects a duplicate name, even in a different letter case (code 11000)', async () => {
      const first = await makeSession();
      await expect(
        AcademicSession.create({ name: first.name.toLowerCase(), startDate: START, endDate: END }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('allows many inactive sessions at the same time', async () => {
      const a = await makeSession();
      const b = await makeSession();
      const c = await makeSession();
      expect(await AcademicSession.countDocuments({ _id: { $in: [a._id, b._id, c._id] } })).toBe(3);
    });

    it('rejects a second active session (code 11000) and creates nothing', async () => {
      await makeSession({ isActive: true });
      const name = nextName();
      await expect(
        AcademicSession.create({ name, startDate: START, endDate: END, isActive: true }),
      ).rejects.toMatchObject({ code: 11000 });
      expect(await AcademicSession.countDocuments({ name })).toBe(0);
    });

    it('rejects activating a second session while another is active (code 11000)', async () => {
      await makeSession({ isActive: true });
      const second = await makeSession();
      await expect(
        AcademicSession.updateOne({ _id: second._id }, { $set: { isActive: true } }).exec(),
      ).rejects.toMatchObject({ code: 11000 });
      expect((await stored(second._id)).isActive).toBe(false);
    });

    it('allows moving the active flag once the first session is deactivated', async () => {
      const first = await makeSession({ isActive: true });
      const second = await makeSession();

      await AcademicSession.updateOne({ _id: first._id }, { $set: { isActive: false } });
      await AcademicSession.updateOne({ _id: second._id }, { $set: { isActive: true } });

      expect((await stored(first._id)).isActive).toBe(false);
      expect((await stored(second._id)).isActive).toBe(true);
      expect(
        await AcademicSession.countDocuments({ _id: { $in: [first._id, second._id] }, isActive: true }),
      ).toBe(1);
    });

    it('allows changing the name and both dates to new valid values', async () => {
      const created = await makeSession();
      const nextNameValue = nextName();
      await AcademicSession.updateOne(
        { _id: created._id },
        {
          $set: {
            name: nextNameValue,
            startDate: new Date('2027-07-01'),
            endDate: new Date('2028-06-30'),
          },
        },
      );

      const doc = await stored(created._id);
      expect(doc.name).toBe(nextNameValue);
      expect(doc.startDate.getTime()).toBe(new Date('2027-07-01').getTime());
      expect(doc.endDate.getTime()).toBe(new Date('2028-06-30').getTime());
    });

    it('allows changing only the end date to a later valid value', async () => {
      const created = await makeSession();
      await AcademicSession.updateOne(
        { _id: created._id },
        { $set: { endDate: new Date('2027-12-31') } },
      );
      expect((await stored(created._id)).endDate.getTime()).toBe(new Date('2027-12-31').getTime());
    });

    it('rejects changing the name to one that is taken in a different letter case (code 11000)', async () => {
      const a = await makeSession();
      const b = await makeSession();
      await expect(
        AcademicSession.updateOne({ _id: b._id }, { $set: { name: a.name.toLowerCase() } }).exec(),
      ).rejects.toMatchObject({ code: 11000 });
      expect((await stored(b._id)).name).toBe(b.name);
    });

    it('rejects updates that set an invalid name, and leaves the stored name unchanged', async () => {
      const created = await makeSession();
      const runs = [
        ['updateOne', () =>
          AcademicSession.updateOne({ _id: created._id }, { $set: { name: 'A' } }).exec()],
        ['findOneAndUpdate', () =>
          AcademicSession.findOneAndUpdate({ _id: created._id }, { $set: { name: 'A' } }).exec()],
        ['updateMany', () =>
          AcademicSession.updateMany({ _id: created._id }, { $set: { name: 'A' } }).exec()],
      ];
      for (const [label, run] of runs) {
        await expect(run(), label).rejects.toMatchObject({ name: 'ValidationError' });
      }
      expect((await stored(created._id)).name).toBe(created.name);
    });

    it('rejects save() when the start date is moved after the end date', async () => {
      const created = await makeSession();
      const doc = await AcademicSession.findById(created._id);
      doc.startDate = new Date('2028-01-01');

      await expect(doc.save()).rejects.toMatchObject({ name: 'ValidationError' });
      expect((await stored(created._id)).startDate.getTime()).toBe(START.getTime());
    });

    it('rejects save() when the end date is moved before the start date', async () => {
      const created = await makeSession();
      const doc = await AcademicSession.findById(created._id);
      doc.endDate = new Date('2026-01-01');

      await expect(doc.save()).rejects.toMatchObject({ name: 'ValidationError' });
      expect((await stored(created._id)).endDate.getTime()).toBe(END.getTime());
    });

    it('RECORDS whether updateOne checks date order (a probe, not a requirement)', async () => {
      const created = await makeSession();
      let outcome;
      try {
        await AcademicSession.updateOne(
          { _id: created._id },
          { $set: { endDate: new Date('2026-01-01') } },
        );
        const doc = await stored(created._id);
        outcome = `updateOne ACCEPTED an end date before the start date; stored endDate is now ${doc.endDate.toISOString()}`;
      } catch (error) {
        outcome = `updateOne REJECTED it (${error.name})`;
      }
      console.log('PROBE updateOne with an end date before the start date:', outcome);
      expect(typeof outcome).toBe('string');
    });
  });

  describe('bulkWrite and replaces are refused, inserts stay validated', () => {
    it('refuses bulkWrite updateOne on name and changes nothing', async () => {
      const created = await makeSession();
      await expect(
        AcademicSession.bulkWrite([
          { updateOne: { filter: { _id: created._id }, update: { $set: { name: nextName() } } } },
        ]),
      ).rejects.toMatchObject({ code: 'BULK_UPDATE_NOT_ALLOWED' });
      expect((await stored(created._id)).name).toBe(created.name);
    });

    it('still validates a bulkWrite insertOne (end before start rejected, nothing inserted)', async () => {
      const name = nextName();
      await expect(
        AcademicSession.bulkWrite([
          { insertOne: { document: { name, startDate: END, endDate: START } } },
        ]),
      ).rejects.toMatchObject({ name: 'ValidationError' });
      expect(await AcademicSession.countDocuments({ name })).toBe(0);
    });

    const routes = [
      ['replaceOne', (id, replacement) =>
        AcademicSession.replaceOne({ _id: id }, replacement).exec()],
      ['findOneAndReplace', (id, replacement) =>
        AcademicSession.findOneAndReplace({ _id: id }, replacement).exec()],
      ['bulkWrite replaceOne', (id, replacement) =>
        AcademicSession.bulkWrite([{ replaceOne: { filter: { _id: id }, replacement } }])],
    ];

    it.each(routes)('%s is refused with REPLACE_NOT_ALLOWED and the stored document is unchanged', async (_label, run) => {
      const created = await makeSession();
      await expect(
        run(created._id, { name: nextName(), startDate: START, endDate: END }),
      ).rejects.toMatchObject({ code: 'REPLACE_NOT_ALLOWED' });
      expect((await stored(created._id)).name).toBe(created.name);
    });
  });
});