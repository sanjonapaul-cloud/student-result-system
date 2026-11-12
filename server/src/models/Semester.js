import mongoose from 'mongoose';
import { immutableFields } from './plugins/immutableFields.js';
import { validateOnUpdate } from './plugins/validateOnUpdate.js';

const { Schema } = mongoose;

export const SEMESTER_MIN = 1;
export const SEMESTER_MAX = 12;

// A Semester is "Semester <number> of <session>". Both fields are immutable: a wrong
// semester is deleted and recreated, never moved to another session or renumbered.
// There is therefore no editable field on this model.
const semesterSchema = new Schema(
  {
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: 'AcademicSession',
      required: [true, 'sessionId is required'],
      immutable: true,
    },
    number: {
      type: Number,
      required: [true, 'number is required'],
      immutable: true,
      min: [SEMESTER_MIN, `number must be at least ${SEMESTER_MIN}`],
      max: [SEMESTER_MAX, `number must be at most ${SEMESTER_MAX}`],
      validate: { validator: Number.isInteger, message: 'number must be a whole number' },
    },
  },
  { timestamps: true, strict: 'throw' },
);

// One Semester per number in a session. This index also serves lookups by sessionId.
semesterSchema.index({ sessionId: 1, number: 1 }, { unique: true });

// Blocks every update, replace and bulkWrite route that could change either field.
semesterSchema.plugin(immutableFields, { fields: ['sessionId', 'number'] });

// Runs the field validators on update operations too, and refuses bulkWrite updates and
// replaces. It must come AFTER immutableFields, so a change to a protected field is reported
// as IMMUTABLE_FIELD and not as a validation or replace error.
semesterSchema.plugin(validateOnUpdate);

export const Semester = mongoose.model('Semester', semesterSchema);