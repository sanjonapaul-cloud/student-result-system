import mongoose from 'mongoose';
import { immutableFields } from './plugins/immutableFields.js';
import { validateOnUpdate } from './plugins/validateOnUpdate.js';

const { Schema } = mongoose;

// 1 to 5 characters, A-Z and 0-9 only. Input is trimmed and uppercased before this check
// runs, so 'a' is stored as 'A'.
export const SECTION_FORMAT = /^[A-Z0-9]{1,5}$/;

// A Class is "Program + Semester + Section", for example "BCA, Semester 3, section A".
// Its session comes from its Semester and is not copied here.
// programId and semesterId are immutable: a class filed under the wrong program or
// semester is deleted and recreated. section is editable.
const classSchema = new Schema(
  {
    programId: {
      type: Schema.Types.ObjectId,
      ref: 'Program',
      required: [true, 'programId is required'],
      immutable: true,
    },
    semesterId: {
      type: Schema.Types.ObjectId,
      ref: 'Semester',
      required: [true, 'semesterId is required'],
      immutable: true,
    },
    section: {
      type: String,
      required: [true, 'section is required'],
      trim: true,
      uppercase: true,
      match: [SECTION_FORMAT, 'section must be 1 to 5 characters: A-Z or 0-9'],
    },

    // Write-conflict anchors from Blueprint v3. Only services change these two fields.
    // The model cannot stop other code from changing them.
    // inputRevision goes up whenever marks, assessments, enrollments, offerings or
    // exclusions change. LIMIT: $inc is not validated (probes on User.tokenVersion and
    // Subject.credits), so a negative or fractional $inc on inputRevision would be accepted.
    inputRevision: {
      type: Number,
      default: 0,
      min: [0, 'inputRevision cannot be negative'],
      validate: { validator: Number.isInteger, message: 'inputRevision must be a whole number' },
    },
    // null until results are published for the class.
    resultsPublishedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: 'throw' },
);

// One class per program, semester and section.
classSchema.index({ programId: 1, semesterId: 1, section: 1 }, { unique: true });

// Blocks every update, replace and bulkWrite route that could change programId or semesterId.
classSchema.plugin(immutableFields, { fields: ['programId', 'semesterId'] });

// Runs the field validators on update operations too, and refuses bulkWrite updates and
// replaces. It must come AFTER immutableFields, so a change to a protected field is reported
// as IMMUTABLE_FIELD and not as a validation or replace error.
classSchema.plugin(validateOnUpdate);

export const Class = mongoose.model('Class', classSchema);