import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { immutableFields } from '../../src/models/plugins/immutableFields.js';

// A throwaway model with two protected fields, in its own collection in the test database.
// Real models are never used here. The collection is dropped when the file finishes.
const runId = randomUUID().slice(0, 8);
let counter = 0;

const thingSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    note: String,
    role: { type: String, required: true, immutable: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  },
  { strict: 'throw', collection: 'plugintest_immutable_fields' },
);
thingSchema.plugin(immutableFields, { fields: ['role', 'ownerId'] });
const Thing = mongoose.model('ImmutablePluginThing', thingSchema);

async function makeThing() {
  counter += 1;
  return Thing.create({
    label: `thing${counter}-${runId}`,
    role: 'student',
    ownerId: new mongoose.Types.ObjectId(),
  });
}

async function stored(id) {
  return Thing.findById(id).lean();
}

describe('immutableFields plugin on a throwaway model', () => {
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

  it('save() with a changed protected field fails and the stored value is unchanged', async () => {
    const created = await makeThing();
    const doc = await Thing.findById(created._id);
    await expect(
      (async () => {
        doc.role = 'admin';
        await doc.save();
      })(),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    expect((await stored(created._id)).role).toBe('student');
  });

  const queryUpdates = [
    ['updateOne with $set', (id) => Thing.updateOne({ _id: id }, { $set: { role: 'admin' } }).exec()],
    ['updateOne without an operator', (id) => Thing.updateOne({ _id: id }, { role: 'admin' }).exec()],
    ['updateMany with $set', (id) => Thing.updateMany({ _id: id }, { $set: { role: 'admin' } }).exec()],
    ['findOneAndUpdate with $set', (id) =>
      Thing.findOneAndUpdate({ _id: id }, { $set: { role: 'admin' } }).exec()],
    ['updateOne with $unset', (id) => Thing.updateOne({ _id: id }, { $unset: { role: 1 } }).exec()],
    ['updateOne with $setOnInsert', (id) =>
      Thing.updateOne({ _id: id }, { $setOnInsert: { role: 'admin' } }).exec()],
    ['updateOne with $rename away from the field', (id) =>
      Thing.updateOne({ _id: id }, { $rename: { role: 'oldRole' } }).exec()],
    ['updateOne with $rename onto the field', (id) =>
      Thing.updateOne({ _id: id }, { $rename: { note: 'role' } }).exec()],
    ['updateOne with a pipeline (updatePipeline on)', (id) =>
      Thing.updateOne({ _id: id }, [{ $set: { role: 'admin' } }], { updatePipeline: true }).exec()],
  ];

  it.each(queryUpdates)('rejects %s and leaves the stored value unchanged', async (_label, run) => {
    const created = await makeThing();
    await expect(run(created._id)).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
    expect((await stored(created._id)).role).toBe('student');
  });

  it('rejects an upsert that sets a protected field, and creates no document', async () => {
    const label = `upsert-${runId}`;
    await expect(
      Thing.updateOne({ label }, { $set: { role: 'admin' } }, { upsert: true }).exec(),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
    expect(await Thing.countDocuments({ label })).toBe(0);
  });

  it('rejects replaceOne and leaves the stored value unchanged', async () => {
    const created = await makeThing();
    await expect(
      Thing.replaceOne(
        { _id: created._id },
        { label: 'replaced', role: 'admin', ownerId: new mongoose.Types.ObjectId() },
      ).exec(),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
    expect((await stored(created._id)).role).toBe('student');
  });

  it('rejects findOneAndReplace and leaves the stored value unchanged', async () => {
    const created = await makeThing();
    await expect(
      Thing.findOneAndReplace(
        { _id: created._id },
        { label: 'replaced', role: 'admin', ownerId: new mongoose.Types.ObjectId() },
      ).exec(),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
    expect((await stored(created._id)).role).toBe('student');
  });

  it('rejects bulkWrite updateOne on a protected field', async () => {
    const created = await makeThing();
    await expect(
      Thing.bulkWrite([
        { updateOne: { filter: { _id: created._id }, update: { $set: { role: 'admin' } } } },
      ]),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
    expect((await stored(created._id)).role).toBe('student');
  });

  it('rejects bulkWrite updateMany on a protected field', async () => {
    const created = await makeThing();
    await expect(
      Thing.bulkWrite([
        { updateMany: { filter: { _id: created._id }, update: { $set: { role: 'admin' } } } },
      ]),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
    expect((await stored(created._id)).role).toBe('student');
  });

  it('rejects bulkWrite replaceOne', async () => {
    const created = await makeThing();
    await expect(
      Thing.bulkWrite([
        {
          replaceOne: {
            filter: { _id: created._id },
            replacement: { label: 'replaced', role: 'admin', ownerId: new mongoose.Types.ObjectId() },
          },
        },
      ]),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });
    expect((await stored(created._id)).role).toBe('student');
  });

  it('doc.updateOne() never changes the stored value (an error or a silent ignore is acceptable)', async () => {
    const created = await makeThing();
    const doc = await Thing.findById(created._id);

    let outcome = 'no error (change silently ignored)';
    try {
      await doc.updateOne({ $set: { role: 'admin' } });
    } catch (error) {
      outcome = `threw ${error.code ?? error.name}`;
    }
    console.log('doc.updateOne outcome:', outcome);

    expect((await stored(created._id)).role).toBe('student');
  });

  it('protects the second listed field as well', async () => {
    const created = await makeThing();
    const originalOwner = String((await stored(created._id)).ownerId);

    await expect(
      Thing.updateOne({ _id: created._id }, { $set: { ownerId: new mongoose.Types.ObjectId() } }).exec(),
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD' });

    expect(String((await stored(created._id)).ownerId)).toBe(originalOwner);
  });

  it('still allows updating an unprotected field', async () => {
    const created = await makeThing();
    await Thing.updateOne({ _id: created._id }, { $set: { note: 'changed' } });

    const doc = await stored(created._id);
    expect(doc.note).toBe('changed');
    expect(doc.role).toBe('student');
  });

  it('still allows a bulkWrite that changes only an unprotected field', async () => {
    const created = await makeThing();
    await Thing.bulkWrite([
      { updateOne: { filter: { _id: created._id }, update: { $set: { note: 'bulk changed' } } } },
    ]);

    const doc = await stored(created._id);
    expect(doc.note).toBe('bulk changed');
    expect(doc.role).toBe('student');
  });
});