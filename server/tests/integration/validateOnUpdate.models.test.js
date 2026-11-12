import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { User } from '../../src/models/User.js';
import { StudentProfile } from '../../src/models/StudentProfile.js';

// Every record made here is tagged with this run, and cleanup removes only those.
// Test files share srms_test, so nothing else is ever deleted.
const runId = randomUUID().slice(0, 8);
const runTag = runId.toUpperCase();
const FAKE_HASH = '$2b$12$' + 'a'.repeat(53); // right shape, not a real password hash
const profileIds = [];
let counter = 0;

function userData(overrides = {}) {
  counter += 1;
  return {
    name: 'Test User',
    email: `vou${counter}-${runId}@example.test`,
    passwordHash: FAKE_HASH,
    role: 'student',
    ...overrides,
  };
}

const makeUser = () => User.create(userData());
const storedUser = (id) => User.findById(id).select('+passwordHash').lean();

function nextRollNo() {
  counter += 1;
  return `V${runTag}-${counter}`; // at most 12 characters, matches the roll number pattern
}

async function makeProfile() {
  const doc = await StudentProfile.create({
    userId: new mongoose.Types.ObjectId(),
    rollNo: nextRollNo(),
  });
  profileIds.push(doc._id);
  return doc;
}

const storedProfile = (id) => StudentProfile.findById(id).lean();

describe('update validation on the real models', () => {
  beforeAll(async () => {
    await connectTestDb();
    await User.init();
    await StudentProfile.init();
  });

  afterAll(async () => {
    await User.deleteMany({ email: { $regex: `-${runId}@example\\.test$` } });
    await StudentProfile.deleteMany({ _id: { $in: profileIds } });
    await disconnectTestDb();
  });

  describe('User', () => {
    it('rejects an update that sets an invalid name', async () => {
      const user = await makeUser();
      await expect(
        User.updateOne({ _id: user._id }, { $set: { name: 'A' } }).exec(),
      ).rejects.toMatchObject({ name: 'ValidationError' });
      expect((await storedUser(user._id)).name).toBe('Test User');
    });

    it('rejects an update that sets an invalid email', async () => {
      const user = await makeUser();
      for (const email of ['no-at-sign.test', 'has space@example.test']) {
        await expect(
          User.updateOne({ _id: user._id }, { $set: { email } }).exec(),
          email,
        ).rejects.toMatchObject({ name: 'ValidationError' });
      }
      expect((await storedUser(user._id)).email).toBe(user.email);
    });

    it('rejects an update that sets a plaintext or wrong-cost passwordHash', async () => {
      const user = await makeUser();
      for (const passwordHash of ['Secret123!', '$2b$10$' + 'a'.repeat(53)]) {
        await expect(
          User.updateOne({ _id: user._id }, { $set: { passwordHash } }).exec(),
          passwordHash,
        ).rejects.toMatchObject({ name: 'ValidationError' });
      }
      expect((await storedUser(user._id)).passwordHash).toBe(FAKE_HASH);
    });

    it('rejects an update that sets a negative or fractional tokenVersion', async () => {
      const user = await makeUser();
      for (const tokenVersion of [-1, 1.5]) {
        await expect(
          User.updateOne({ _id: user._id }, { $set: { tokenVersion } }).exec(),
          String(tokenVersion),
        ).rejects.toMatchObject({ name: 'ValidationError' });
      }
      expect((await storedUser(user._id)).tokenVersion).toBe(0);
    });

    it('still lowercases and trims an email set by an update', async () => {
      const user = await makeUser();
      await User.updateOne(
        { _id: user._id },
        { $set: { email: `  Changed-${runId}@Example.TEST ` } },
      );
      expect((await storedUser(user._id)).email).toBe(`changed-${runId}@example.test`);
    });

    it('accepts a valid update of several fields at once', async () => {
      const user = await makeUser();
      await User.updateOne(
        { _id: user._id },
        { $set: { name: 'Renamed Person', tokenVersion: 3, isActive: false } },
      );
      const doc = await storedUser(user._id);
      expect(doc.name).toBe('Renamed Person');
      expect(doc.tokenVersion).toBe(3);
      expect(doc.isActive).toBe(false);
      expect(doc.role).toBe('student');
    });

    it('RECORDS whether $inc is validated (a probe, not a requirement)', async () => {
      const user = await makeUser();
      let outcome;
      try {
        await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: -5 } });
        outcome = `ACCEPTED; stored tokenVersion is now ${(await storedUser(user._id)).tokenVersion}`;
      } catch (error) {
        outcome = `REJECTED (${error.name})`;
      }
      console.log('PROBE $inc that takes tokenVersion below 0:', outcome);
      expect(typeof outcome).toBe('string');
    });

    it('reports IMMUTABLE_FIELD, not a validation error, when an update has both problems', async () => {
      const user = await makeUser();
      await expect(
        User.updateOne({ _id: user._id }, { $set: { role: 'admin', name: 'A' } }).exec(),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      const doc = await storedUser(user._id);
      expect(doc.role).toBe('student');
      expect(doc.name).toBe('Test User');
    });

    it('still rejects an update to an email that is already taken (code 11000)', async () => {
      const first = await makeUser();
      const second = await makeUser();
      await expect(
        User.updateOne({ _id: second._id }, { $set: { email: first.email } }).exec(),
      ).rejects.toMatchObject({ code: 11000 });
      expect((await storedUser(second._id)).email).toBe(second.email);
    });
  });

  describe('StudentProfile', () => {
    it('rejects updateOne with an invalid rollNo', async () => {
      const created = await makeProfile();
      const invalid = ['AB', '-ABC', 'A'.repeat(21), 'AB C1'];
      for (const rollNo of invalid) {
        await expect(
          StudentProfile.updateOne({ _id: created._id }, { $set: { rollNo } }).exec(),
          rollNo,
        ).rejects.toMatchObject({ name: 'ValidationError' });
      }
      expect((await storedProfile(created._id)).rollNo).toBe(created.rollNo);
    });

    it('rejects findOneAndUpdate with an invalid rollNo', async () => {
      const created = await makeProfile();
      await expect(
        StudentProfile.findOneAndUpdate(
          { _id: created._id },
          { $set: { rollNo: 'bad value!' } },
        ).exec(),
      ).rejects.toMatchObject({ name: 'ValidationError' });
      expect((await storedProfile(created._id)).rollNo).toBe(created.rollNo);
    });

    it('rejects updateMany with an invalid rollNo', async () => {
      const created = await makeProfile();
      await expect(
        StudentProfile.updateMany({ _id: created._id }, { $set: { rollNo: 'bad value!' } }).exec(),
      ).rejects.toMatchObject({ name: 'ValidationError' });
      expect((await storedProfile(created._id)).rollNo).toBe(created.rollNo);
    });

    it('still uppercases a valid rollNo set by an update', async () => {
      const created = await makeProfile();
      const next = nextRollNo();
      await StudentProfile.updateOne(
        { _id: created._id },
        { $set: { rollNo: next.toLowerCase() } },
      );
            expect((await storedProfile(created._id)).rollNo).toBe(next);
    });
  });

  describe('bulkWrite (updates are refused, inserts are allowed)', () => {
    it('User: refuses bulkWrite updateOne and changes nothing', async () => {
      const user = await makeUser();
      await expect(
        User.bulkWrite([
          { updateOne: { filter: { _id: user._id }, update: { $set: { name: 'Bulk Renamed' } } } },
        ]),
      ).rejects.toMatchObject({ code: 'BULK_UPDATE_NOT_ALLOWED' });
      expect((await storedUser(user._id)).name).toBe('Test User');
    });

    it('User: refuses bulkWrite updateMany and changes nothing', async () => {
      const user = await makeUser();
      await expect(
        User.bulkWrite([
          { updateMany: { filter: { _id: user._id }, update: { $set: { name: 'Bulk Renamed' } } } },
        ]),
      ).rejects.toMatchObject({ code: 'BULK_UPDATE_NOT_ALLOWED' });
      expect((await storedUser(user._id)).name).toBe('Test User');
    });

    it('User: still allows a valid bulkWrite insertOne', async () => {
      const data = userData();
      await User.bulkWrite([{ insertOne: { document: data } }]);

      const doc = await User.findOne({ email: data.email }).lean();
      expect(doc).not.toBeNull();
      expect(doc.role).toBe('student');
    });

    it('StudentProfile: refuses bulkWrite updateOne on rollNo and changes nothing', async () => {
      const created = await makeProfile();
      await expect(
        StudentProfile.bulkWrite([
          {
            updateOne: {
              filter: { _id: created._id },
              update: { $set: { rollNo: nextRollNo() } },
            },
          },
        ]),
      ).rejects.toMatchObject({ code: 'BULK_UPDATE_NOT_ALLOWED' });
      expect((await storedProfile(created._id)).rollNo).toBe(created.rollNo);
    });

    it('StudentProfile: still validates a bulkWrite insertOne (invalid rollNo rejected)', async () => {
      const userId = new mongoose.Types.ObjectId();
      await expect(
        StudentProfile.bulkWrite([{ insertOne: { document: { userId, rollNo: 'bad value!' } } }]),
      ).rejects.toMatchObject({ name: 'ValidationError' });
      expect(await StudentProfile.countDocuments({ userId })).toBe(0);
    });
  });
});