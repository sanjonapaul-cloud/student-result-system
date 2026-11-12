import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connectTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { User } from '../../src/models/User.js';

// Every record made here has an email ending in this run id, and cleanup deletes only those.
// That way other test files sharing the srms_test database are never disturbed.
const runId = randomUUID().slice(0, 8);
const FAKE_HASH = '$2b$12$' + 'a'.repeat(53); // right shape, not a real password hash
let counter = 0;

function userData(overrides = {}) {
  counter += 1;
  return {
    name: 'Test User',
    email: `user${counter}-${runId}@example.test`,
    passwordHash: FAKE_HASH,
    role: 'student',
    ...overrides,
  };
}

// Returns the field names that failed validation. Any other kind of error is rethrown.
async function invalidPaths(data) {
  try {
    await new User(data).validate();
    return [];
  } catch (error) {
    if (error.name !== 'ValidationError') throw error;
    return Object.keys(error.errors);
  }
}

async function storedRole(id) {
  const doc = await User.findById(id).lean();
  return doc ? doc.role : '(missing)';
}

describe('User model', () => {
  beforeAll(async () => {
    await connectTestDb();
    await User.init(); // wait for the unique email index to finish building
  });

  afterAll(async () => {
    await User.deleteMany({ email: { $regex: `-${runId}@example\\.test$` } });
    await disconnectTestDb();
  });

  describe('validation (no database writes)', () => {
    it('accepts a valid user and applies the defaults', async () => {
      const doc = new User(userData());
      await doc.validate(); // throws if invalid
      expect(doc.isActive).toBe(true);
      expect(doc.tokenVersion).toBe(0);
      expect(doc.mustChangePassword).toBe(false);
    });

    it('trims the name and trims and lowercases the email', async () => {
      const doc = new User(userData({ name: '  Ann Lee  ', email: '  Ann.Lee@Example.TEST ' }));
      expect(doc.name).toBe('Ann Lee');
      expect(doc.email).toBe('ann.lee@example.test');
      await doc.validate();
    });

    it('rejects bad names', async () => {
      const cases = [
        ['missing', undefined],
        ['one character', 'A'],
        ['101 characters', 'a'.repeat(101)],
        ['only spaces', '   '],
      ];
      for (const [label, name] of cases) {
        expect(await invalidPaths(userData({ name })), label).toContain('name');
      }
    });

    it('rejects bad emails', async () => {
      const cases = [
        ['missing', undefined],
        ['no @', 'no-at-sign.test'],
        ['contains a space', 'has space@example.test'],
        ['no dot in the domain', 'missing@dot'],
        ['255 characters', 'a'.repeat(242) + '@example.test'],
      ];
      for (const [label, email] of cases) {
        expect(await invalidPaths(userData({ email })), label).toContain('email');
      }
    });

    it('rejects bad password hashes', async () => {
      const cases = [
        ['missing', undefined],
        ['plaintext password', 'Secret123!'],
        ['wrong cost (10)', '$2b$10$' + 'a'.repeat(53)],
        ['too short', '$2b$12$' + 'a'.repeat(52)],
        ['invalid characters', '$2b$12$' + '!'.repeat(53)],
      ];
      for (const [label, passwordHash] of cases) {
        expect(await invalidPaths(userData({ passwordHash })), label).toContain('passwordHash');
      }
    });

    it('rejects bad roles', async () => {
      const cases = [
        ['missing', undefined],
        ['unknown role', 'superadmin'],
        ['wrong case', 'Admin'],
      ];
      for (const [label, role] of cases) {
        expect(await invalidPaths(userData({ role })), label).toContain('role');
      }
    });

    it('rejects a negative or fractional tokenVersion', async () => {
      for (const tokenVersion of [-1, 1.5]) {
        expect(await invalidPaths(userData({ tokenVersion })), String(tokenVersion)).toContain(
          'tokenVersion',
        );
      }
    });
  });

  describe('storage, indexes and hidden hash', () => {
    it('saves a user, lowercases the stored email and adds timestamps', async () => {
      const data = userData();
      await User.create({ ...data, email: data.email.toUpperCase() });

      const stored = await User.findOne({ email: data.email }).lean();
      expect(stored).not.toBeNull();
      expect(stored.email).toBe(data.email);
      expect(stored.role).toBe('student');
      expect(stored.createdAt).toBeInstanceOf(Date);
      expect(stored.updatedAt).toBeInstanceOf(Date);
    });

    it('rejects a duplicate email, even in a different letter case (code 11000)', async () => {
      const data = userData();
      await User.create(data);
      await expect(
        User.create({ ...data, email: data.email.toUpperCase() }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('hides passwordHash from normal queries and shows it only when asked', async () => {
      const created = await User.create(userData());

      const normal = await User.findById(created._id);
      expect(normal.passwordHash).toBeUndefined();

      const withHash = await User.findById(created._id).select('+passwordHash');
      expect(withHash.passwordHash).toBe(FAKE_HASH);
    });

    it('never puts passwordHash into JSON or toObject output', async () => {
      const created = await User.create(userData());
      expect(created.passwordHash).toBe(FAKE_HASH); // still in memory, which is why the transform matters

      const json = JSON.stringify(created);
      expect(json).not.toContain('passwordHash');
      expect(json).not.toContain(FAKE_HASH);
      expect(created.toObject()).not.toHaveProperty('passwordHash');
    });
  });

  describe('role is immutable', () => {
    it('save() with a changed role fails and the stored role is unchanged', async () => {
      const created = await User.create(userData());
      const doc = await User.findById(created._id);

      await expect(
        (async () => {
          doc.role = 'admin';
          await doc.save();
        })(),
      ).rejects.toMatchObject({ name: 'ValidationError' });

      expect(await storedRole(created._id)).toBe('student');
    });

    const queryUpdates = [
      ['updateOne with $set', (id) => User.updateOne({ _id: id }, { $set: { role: 'admin' } }).exec()],
      ['updateOne without an operator', (id) => User.updateOne({ _id: id }, { role: 'admin' }).exec()],
      ['updateMany with $set', (id) => User.updateMany({ _id: id }, { $set: { role: 'admin' } }).exec()],
      ['findOneAndUpdate with $set', (id) =>
        User.findOneAndUpdate({ _id: id }, { $set: { role: 'admin' } }).exec()],
      ['updateOne with $unset', (id) => User.updateOne({ _id: id }, { $unset: { role: 1 } }).exec()],
    ];

    it.each(queryUpdates)('rejects %s and leaves the stored role unchanged', async (_label, run) => {
      const created = await User.create(userData());
      await expect(run(created._id)).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      expect(await storedRole(created._id)).toBe('student');
    });

        it('refuses a pipeline update by default, because Mongoose itself rejects arrays', async () => {
      const created = await User.create(userData());
      // Mongoose throws synchronously here, before any query exists, so the call is
      // wrapped in an async function to catch it the same way as a rejected promise.
      await expect(
        (async () => User.updateOne({ _id: created._id }, [{ $set: { role: 'admin' } }]).exec())(),
      ).rejects.toThrow(/updatePipeline/);
      expect(await storedRole(created._id)).toBe('student');
    });

    it('rejects a pipeline update even when updatePipeline is switched on', async () => {
      const created = await User.create(userData());
      await expect(
        User.updateOne({ _id: created._id }, [{ $set: { role: 'admin' } }], {
          updatePipeline: true,
        }).exec(),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      expect(await storedRole(created._id)).toBe('student');
    });

    it('rejects replaceOne and leaves the stored role unchanged', async () => {
      const created = await User.create(userData());
      await expect(
        User.replaceOne({ _id: created._id }, userData({ role: 'admin' })).exec(),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      expect(await storedRole(created._id)).toBe('student');
    });

    it('rejects findOneAndReplace and leaves the stored role unchanged', async () => {
      const created = await User.create(userData());
      await expect(
        User.findOneAndReplace({ _id: created._id }, userData({ role: 'admin' })).exec(),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      expect(await storedRole(created._id)).toBe('student');
    });

    it('rejects bulkWrite updateOne on role and leaves the stored role unchanged', async () => {
      const created = await User.create(userData());
      await expect(
        User.bulkWrite([
          { updateOne: { filter: { _id: created._id }, update: { $set: { role: 'admin' } } } },
        ]),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      expect(await storedRole(created._id)).toBe('student');
    });

    it('rejects bulkWrite replaceOne and leaves the stored role unchanged', async () => {
      const created = await User.create(userData());
      await expect(
        User.bulkWrite([
          { replaceOne: { filter: { _id: created._id }, replacement: userData({ role: 'admin' }) } },
        ]),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      expect(await storedRole(created._id)).toBe('student');
    });

    it('still allows updating an unprotected field such as name', async () => {
      const created = await User.create(userData());
      await User.updateOne({ _id: created._id }, { $set: { name: 'Renamed Person' } });

      const stored = await User.findById(created._id).lean();
      expect(stored.name).toBe('Renamed Person');
      expect(stored.role).toBe('student');
    });

        it('refuses a bulkWrite update even when it changes only an unprotected field', async () => {
      const created = await User.create(userData());
      await expect(
        User.bulkWrite([
          { updateOne: { filter: { _id: created._id }, update: { $set: { name: 'Bulk Renamed' } } } },
        ]),
      ).rejects.toMatchObject({ code: 'BULK_UPDATE_NOT_ALLOWED' });

      const stored = await User.findById(created._id).lean();
      expect(stored.name).toBe('Test User');
      expect(stored.role).toBe('student');
    });
  });
});