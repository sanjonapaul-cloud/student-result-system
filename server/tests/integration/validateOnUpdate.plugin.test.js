import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { immutableFields } from '../../src/models/plugins/immutableFields.js';
import { validateOnUpdate } from '../../src/models/plugins/validateOnUpdate.js';

// A throwaway model in its own collection. Real models are never used here.
// The collection is dropped when the file finishes.
const thingSchema = new mongoose.Schema(
  {
    code: { type: String, trim: true, uppercase: true, match: /^[A-Z]{3}$/ },
    count: {
      type: Number,
      min: 0,
      validate: { validator: Number.isInteger, message: 'count must be a whole number' },
    },
    req: { type: String, required: true },
    kind: { type: String, required: true, immutable: true },
  },
  { strict: 'throw', collection: 'plugintest_validate_on_update' },
);
thingSchema.plugin(immutableFields, { fields: ['kind'] });
thingSchema.plugin(validateOnUpdate);
const Thing = mongoose.model('ValidateOnUpdateThing', thingSchema);

async function makeThing() {
  return Thing.create({ code: 'abc', count: 1, req: 'x', kind: 'k' });
}

async function expectUnchanged(id) {
  const doc = await Thing.findById(id).lean();
  expect(doc).toMatchObject({ code: 'ABC', count: 1, req: 'x', kind: 'k' });
}

describe('validateOnUpdate plugin on a throwaway model', () => {
  beforeAll(async () => {
    await connectTestDb();
  });

  afterAll(async () => {
    try {
      await Thing.collection.drop();
    } catch {
      // The collection may not exist. Nothing to clean up.
    }
    await disconnectTestDb();
  });

  const invalidUpdates = [
    ['updateOne: invalid code', (id) =>
      Thing.updateOne({ _id: id }, { $set: { code: 'bad value!' } }).exec()],
    ['updateOne: negative count', (id) =>
      Thing.updateOne({ _id: id }, { $set: { count: -5 } }).exec()],
    ['updateOne: fractional count', (id) =>
      Thing.updateOne({ _id: id }, { $set: { count: 1.5 } }).exec()],
    ['updateOne: $unset of a required field', (id) =>
      Thing.updateOne({ _id: id }, { $unset: { req: 1 } }).exec()],
    ['findOneAndUpdate: invalid code', (id) =>
      Thing.findOneAndUpdate({ _id: id }, { $set: { code: 'bad value!' } }).exec()],
    ['updateMany: invalid code', (id) =>
      Thing.updateMany({ _id: id }, { $set: { code: 'bad value!' } }).exec()],
  ];

  it.each(invalidUpdates)('rejects %s and leaves the stored document unchanged', async (_label, run) => {
    const created = await makeThing();
    await expect(run(created._id)).rejects.toMatchObject({ name: 'ValidationError' });
    await expectUnchanged(created._id);
  });

  it('still accepts a valid update, and the uppercase setter still runs', async () => {
    const created = await makeThing();
    await Thing.updateOne({ _id: created._id }, { $set: { code: 'xyz' } });

    const doc = await Thing.findById(created._id).lean();
    expect(doc.code).toBe('XYZ');
    expect(doc.req).toBe('x');
  });

  it('accepts a boundary value, and does not re-check required fields the update does not touch', async () => {
    const created = await makeThing();
    await Thing.updateOne({ _id: created._id }, { $set: { count: 0 } });

    const doc = await Thing.findById(created._id).lean();
    expect(doc.count).toBe(0);
    expect(doc.req).toBe('x');
  });

  it('cannot be switched off by passing runValidators: false', async () => {
    const created = await makeThing();
    await expect(
      Thing.updateOne(
        { _id: created._id },
        { $set: { code: 'bad value!' } },
        { runValidators: false },
      ).exec(),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    await expectUnchanged(created._id);
  });

  it('reports the immutable-field error, not a validation error, when an update has both problems', async () => {
    const created = await makeThing();
    await expect(
      Thing.updateOne({ _id: created._id }, { $set: { kind: 'other', code: 'bad value!' } }).exec(),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
    await expectUnchanged(created._id);
  });

  it('rejects an upsert with an invalid value and creates no document', async () => {
    await expect(
      Thing.updateOne(
        { req: 'upsert-marker' },
        { $set: { code: 'bad value!' } },
        { upsert: true },
      ).exec(),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    expect(await Thing.countDocuments({ req: 'upsert-marker' })).toBe(0);
  });
});
