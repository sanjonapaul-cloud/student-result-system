import mongoose from 'mongoose';
import { validateOnUpdate } from './plugins/validateOnUpdate.js';

const { Schema } = mongoose;

// Date order is checked by a validator on each date, so moving EITHER date on a loaded
// document is caught when it is saved (Mongoose only validates fields that changed).
//
// On create() and save(), `this` is the document and both dates are readable.
// On update operations (updateOne and similar) a validator cannot read the other field, so
// these checks quietly pass there. The Phase 6 service must check date order on updates.
function endIsAfterStart(value) {
  const start = this?.startDate;
  if (!(start instanceof Date) || !(value instanceof Date)) return true;
  return value.getTime() > start.getTime();
}

function startIsBeforeEnd(value) {
  const end = this?.endDate;
  if (!(end instanceof Date) || !(value instanceof Date)) return true;
  return value.getTime() < end.getTime();
}

const academicSessionSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'name is required'],
      trim: true,
      minlength: [3, 'name must be at least 3 characters'],
      maxlength: [50, 'name must be at most 50 characters'],
    },
    startDate: {
      type: Date,
      required: [true, 'startDate is required'],
      validate: { validator: startIsBeforeEnd, message: 'startDate must be before endDate' },
    },
    endDate: {
      type: Date,
      required: [true, 'endDate is required'],
      validate: { validator: endIsAfterStart, message: 'endDate must be after startDate' },
    },
    isActive: { type: Boolean, default: false },
  },
  { timestamps: true, strict: 'throw' },
);

// Case-insensitive uniqueness: "2026-27" and "2026-27 " (trimmed) cannot both exist.
academicSessionSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

// At most ONE active session. Inactive sessions are not in this index, so there can be many.
// Activating a second session while one is active fails with duplicate-key error 11000, so
// the Phase 6 service must deactivate the old one and activate the new one in one transaction.
academicSessionSchema.index(
  { isActive: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);

// Runs the field validators on update operations too, and refuses bulk updates and replaces.
// There is no immutableFields plugin here: AcademicSession has no immutable field.
academicSessionSchema.plugin(validateOnUpdate);

export const AcademicSession = mongoose.model('AcademicSession', academicSessionSchema);