import mongoose from 'mongoose';
import { immutableFields } from './plugins/immutableFields.js';
import { validateOnUpdate } from './plugins/validateOnUpdate.js';

const { Schema } = mongoose;

// 3 to 20 characters: uppercase letters, digits, "-" and "/", starting with a letter or digit.
// Input is trimmed and uppercased before this check runs.
export const ROLL_NO_FORMAT = /^[A-Z0-9][A-Z0-9\-/]{2,19}$/;

const studentProfileSchema = new Schema(
  {
    // One profile per user. The link can never be moved to a different user.
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
      immutable: true,
    },
    rollNo: {
      type: String,
      required: [true, 'rollNo is required'],
      trim: true,
      uppercase: true,
      match: [ROLL_NO_FORMAT, 'rollNo must be 3 to 20 characters: A-Z, 0-9, "-" or "/"'],
    },
  },
  { timestamps: true, strict: 'throw' },
);

studentProfileSchema.index({ userId: 1 }, { unique: true });
studentProfileSchema.index({ rollNo: 1 }, { unique: true });

// Blocks every update, replace and bulkWrite route that could change userId.
studentProfileSchema.plugin(immutableFields, { fields: ['userId'] });

// Runs the field validators on update operations too. It must come AFTER immutableFields.
studentProfileSchema.plugin(validateOnUpdate);

export const StudentProfile = mongoose.model('StudentProfile', studentProfileSchema);