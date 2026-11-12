import mongoose from 'mongoose';
import { immutableFields } from './plugins/immutableFields.js';
import { validateOnUpdate } from './plugins/validateOnUpdate.js';

const { Schema } = mongoose;

// 3 to 20 characters: uppercase letters, digits, "-" and "/", starting with a letter or digit.
// Input is trimmed and uppercased before this check runs.
// This is the same format as StudentProfile's rollNo. Keep the two in step if one changes.
export const EMPLOYEE_ID_FORMAT = /^[A-Z0-9][A-Z0-9\-/]{2,19}$/;

const teacherProfileSchema = new Schema(
  {
    // One profile per user. The link can never be moved to a different user.
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
      immutable: true,
    },
    employeeId: {
      type: String,
      required: [true, 'employeeId is required'],
      trim: true,
      uppercase: true,
      match: [EMPLOYEE_ID_FORMAT, 'employeeId must be 3 to 20 characters: A-Z, 0-9, "-" or "/"'],
    },
  },
  { timestamps: true, strict: 'throw' },
);

teacherProfileSchema.index({ userId: 1 }, { unique: true });
teacherProfileSchema.index({ employeeId: 1 }, { unique: true });

// Blocks every update, replace and bulkWrite route that could change userId.
teacherProfileSchema.plugin(immutableFields, { fields: ['userId'] });

// Runs the field validators on update operations too, and refuses bulkWrite updates.
// It must come AFTER immutableFields, so a change to a protected field is reported as
// IMMUTABLE_FIELD and not as a validation error.
teacherProfileSchema.plugin(validateOnUpdate);

export const TeacherProfile = mongoose.model('TeacherProfile', teacherProfileSchema);