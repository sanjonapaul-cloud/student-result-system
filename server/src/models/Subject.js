import mongoose from 'mongoose';
import { immutableFields } from './plugins/immutableFields.js';
import { validateOnUpdate } from './plugins/validateOnUpdate.js';

const { Schema } = mongoose;

// 3 to 20 characters: uppercase letters, digits, "-" and "/", starting with a letter or digit.
// Input is trimmed and uppercased before this check runs.
// This is the same format as StudentProfile's rollNo and TeacherProfile's employeeId.
// Keep the three in step if one changes.
export const SUBJECT_CODE_FORMAT = /^[A-Z0-9][A-Z0-9\-/]{2,19}$/;

export const CREDITS_MIN = 0;
export const CREDITS_MAX = 20;

// A Subject belongs to exactly one Program for good: a Class offers only its Program's
// subjects. A subject filed under the wrong program is deleted and recreated.
const subjectSchema = new Schema(
  {
    programId: {
      type: Schema.Types.ObjectId,
      ref: 'Program',
      required: [true, 'programId is required'],
      immutable: true,
    },
    code: {
      type: String,
      required: [true, 'code is required'],
      trim: true,
      uppercase: true,
      match: [SUBJECT_CODE_FORMAT, 'code must be 3 to 20 characters: A-Z, 0-9, "-" or "/"'],
    },
    // Names are NOT unique: two subjects may share a name. Codes identify subjects.
    name: {
      type: String,
      required: [true, 'name is required'],
      trim: true,
      minlength: [2, 'name must be at least 2 characters'],
      maxlength: [100, 'name must be at most 100 characters'],
    },
    // Display only. No grading rule reads credits (there is no GPA in the blueprint).
    credits: {
      type: Number,
      required: [true, 'credits is required'],
      min: [CREDITS_MIN, `credits must be at least ${CREDITS_MIN}`],
      max: [CREDITS_MAX, `credits must be at most ${CREDITS_MAX}`],
      validate: { validator: Number.isInteger, message: 'credits must be a whole number' },
    },
  },
  { timestamps: true, strict: 'throw' },
);

// Codes are unique across the whole system, not per program.
subjectSchema.index({ code: 1 }, { unique: true });

// Blocks every update, replace and bulkWrite route that could change programId.
subjectSchema.plugin(immutableFields, { fields: ['programId'] });

// Runs the field validators on update operations too, and refuses bulkWrite updates and
// replaces. It must come AFTER immutableFields, so a change to a protected field is reported
// as IMMUTABLE_FIELD and not as a validation or replace error.
// LIMIT: $inc is not validated, so $inc on credits can store an out-of-range value.
subjectSchema.plugin(validateOnUpdate);

export const Subject = mongoose.model('Subject', subjectSchema);