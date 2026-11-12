import mongoose from 'mongoose';
import { validateOnUpdate } from './plugins/validateOnUpdate.js';

const { Schema } = mongoose;

// 2 to 12 characters: uppercase letters, digits, "-" and "/", starting with a letter or digit.
// Input is trimmed and uppercased before this check runs.
export const PROGRAM_CODE_FORMAT = /^[A-Z0-9][A-Z0-9\-/]{1,11}$/;

const programSchema = new Schema(
  {
    code: {
      type: String,
      required: [true, 'code is required'],
      trim: true,
      uppercase: true,
      match: [PROGRAM_CODE_FORMAT, 'code must be 2 to 12 characters: A-Z, 0-9, "-" or "/"'],
    },
    name: {
      type: String,
      required: [true, 'name is required'],
      trim: true,
      minlength: [2, 'name must be at least 2 characters'],
      maxlength: [100, 'name must be at most 100 characters'],
    },
  },
  { timestamps: true, strict: 'throw' },
);

programSchema.index({ code: 1 }, { unique: true });
// Case-insensitive uniqueness: "Computer Science" and "computer science" cannot both exist.
// strength 2 ignores letter case but still tells accented letters apart.
programSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

// Runs the field validators on update operations too, and refuses bulkWrite updates.
// There is no immutableFields plugin here: Program has no immutable field.
programSchema.plugin(validateOnUpdate);

export const Program = mongoose.model('Program', programSchema);