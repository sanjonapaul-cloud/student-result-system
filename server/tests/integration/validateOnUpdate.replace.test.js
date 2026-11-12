import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { immutableFields } from '../../src/models/plugins/immutableFields.js';
import { validateOnUpdate } from '../../src/models/plugins/validateOnUpdate.js';

// Two throwaway models in their own collections. Real models are never used here.
// Both collections are dropped when the file finishes.
//
// Plain: validateOnUpdate ONLY, so the replace refusal is tested by itself.
// Both:  immutableFields first, then validateOnUpdate, the order the real models use.

const plainSchema = new mongoose.Schema(
  {
    code: { type: String, trim: true, uppercase: true, match: /^[A-Z]{3}$/ },
    req: { type: String, required: true },
  },
  { strict: 'throw', collection: 'plugintest_replace_plain' },
);
plainSchema.plugin(validateOnUpdate);
const Plain = mongoose.model('ReplacePluginPlain', plainSchema);

const bothSchema = new mongoose.Schema(
  {
    code: { type: String, trim: true, uppercase: true, match: /^[A-Z]{3}$/ },
    kind: { type: String, required: true, immutable: true },
  },
  { strict: 'throw', collection: 'plugintest_replace_both' },
);
bothSchema.plugin(immutableFields, { fields: ['kind'] });
bothSchema.plugin(validateOnUpdate);
const Both = mongoose.model('ReplacePluginBoth', bothSchema);

const makePlain = () => Plain.create({ code: 'abc', req: 'x' });
const makeBoth = () => Both.create({ code: 'abc', kind: 'k' });
const marker = () => `marker-${new mongoose.Types.ObjectId()}`;

async function expectPlainUnchanged(id) {
  expect(await Plain.findById(id).lean()).toMatchObject({ code: 'ABC', req: 'x' });
}

async function expectBothUnchanged(id) {
  expect(await Both.findById(id).lean()).toMatchObject({ code: 'ABC', kind: 'k' });
}

describe('validateOnUpdate plugin: replace routes', () => {
  beforeAll(async () => {
    await connectTestDb();
  });

  afterAll(async () => {
    for (const Model of [Plain, Both]) {
      try {
        await Model.collection.drop();
      } catch {
        // The collection may not exist. Nothing to clean up.
      }
    }
    await disconnectTestDb();
  });

  describe('model with validateOnUpdate only', () => {
    it('refuses replaceOne, even with a valid replacement, and changes nothing', async () => {
      const created = await makePlain();
      await expect(
        Plain.replaceOne({ _id: created._id }, { code: 'xyz', req: 'y' }).exec(),
      ).rejects.toMatchObject({ code: 'REPLACE_NOT_ALLOWED', name: 'ReplaceNotAllowedError' });
      await expectPlainUnchanged(created._id);
    });

    it('refuses findOneAndReplace, even with a valid replacement, and changes nothing', async () => {
      const created = await makePlain();
      await expect(
        Plain.findOneAndReplace({ _id: created._id }, { code: 'xyz', req: 'y' }).exec(),
      ).rejects.toMatchObject({ code: 'REPLACE_NOT_ALLOWED' });
      await expectPlainUnchanged(created._id);
    });

    it('refuses bulkWrite replaceOne, even with a valid replacement, and changes nothing', async () => {
      const created = await makePlain();
      await expect(
        Plain.bulkWrite([
          {
            replaceOne: {
              filter: { _id: created._id },
              replacement: { code: 'xyz', req: 'y' },
            },
          },
        ]),
      ).rejects.toMatchObject({ code: 'REPLACE_NOT_ALLOWED' });
      await expectPlainUnchanged(created._id);
    });

    it('refuses a mixed bulkWrite as a whole: the insert does not happen either', async () => {
      const created = await makePlain();
      const req = marker();
      await expect(
        Plain.bulkWrite([
          { insertOne: { document: { code: 'abc', req } } },
          {
            replaceOne: {
              filter: { _id: created._id },
              replacement: { code: 'xyz', req: 'y' },
            },
          },
        ]),
      ).rejects.toMatchObject({ code: 'REPLACE_NOT_ALLOWED' });
      expect(await Plain.countDocuments({ req })).toBe(0);
      await expectPlainUnchanged(created._id);
    });

    it('still allows a valid bulkWrite insertOne', async () => {
      const req = marker();
      await Plain.bulkWrite([{ insertOne: { document: { code: 'abc', req } } }]);
      expect(await Plain.countDocuments({ req })).toBe(1);
    });

    it('still refuses bulkWrite updateOne with its own error code (behaviour unchanged)', async () => {
      const created = await makePlain();
      await expect(
        Plain.bulkWrite([
          { updateOne: { filter: { _id: created._id }, update: { $set: { code: 'xyz' } } } },
        ]),
      ).rejects.toMatchObject({ code: 'BULK_UPDATE_NOT_ALLOWED' });
      await expectPlainUnchanged(created._id);
    });

    it('still allows a valid updateOne (the field-level route is not affected)', async () => {
      const created = await makePlain();
      await Plain.updateOne({ _id: created._id }, { $set: { code: 'xyz' } });
      expect(await Plain.findById(created._id).lean()).toMatchObject({ code: 'XYZ', req: 'x' });
    });
  });

  describe('model with immutableFields first, then validateOnUpdate (hook order)', () => {
    it('replaceOne reports IMMUTABLE_FIELD, not REPLACE_NOT_ALLOWED', async () => {
      const created = await makeBoth();
      await expect(
        Both.replaceOne({ _id: created._id }, { code: 'xyz', kind: 'other' }).exec(),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      await expectBothUnchanged(created._id);
    });

    it('findOneAndReplace reports IMMUTABLE_FIELD, not REPLACE_NOT_ALLOWED', async () => {
      const created = await makeBoth();
      await expect(
        Both.findOneAndReplace({ _id: created._id }, { code: 'xyz', kind: 'other' }).exec(),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      await expectBothUnchanged(created._id);
    });

    it('bulkWrite replaceOne reports IMMUTABLE_FIELD, not REPLACE_NOT_ALLOWED', async () => {
      const created = await makeBoth();
      await expect(
        Both.bulkWrite([
          {
            replaceOne: {
              filter: { _id: created._id },
              replacement: { code: 'xyz', kind: 'other' },
            },
          },
        ]),
      ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
      await expectBothUnchanged(created._id);
    });
  });
});