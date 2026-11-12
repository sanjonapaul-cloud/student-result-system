import mongoose from 'mongoose';
import { immutableFields } from './plugins/immutableFields.js';
import { validateOnUpdate } from './plugins/validateOnUpdate.js';

const { Schema } = mongoose;

export const USER_ROLES = Object.freeze(['admin', 'teacher', 'student']);

// A real bcrypt hash at cost 12 is "$2b$12$" followed by 53 characters (60 in total).
// This stops a plaintext password from being stored by mistake.
const BCRYPT_COST_12_HASH = /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function removePasswordHash(_doc, ret) {
  delete ret.passwordHash;
  return ret;
}

const userSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [100, 'Name must be at most 100 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      trim: true,
      lowercase: true,
      maxlength: [254, 'Email must be at most 254 characters'],
      match: [EMAIL_FORMAT, 'Email format is invalid'],
    },
    passwordHash: {
      type: String,
      required: [true, 'Password hash is required'],
      select: false,
      validate: {
        validator: (value) => BCRYPT_COST_12_HASH.test(value),
        message: 'passwordHash must be a bcrypt hash (cost 12)',
      },
    },
    role: {
      type: String,
      enum: { values: USER_ROLES, message: 'Role must be admin, teacher or student' },
      required: [true, 'Role is required'],
      immutable: true,
    },
    isActive: { type: Boolean, default: true },
    tokenVersion: {
      type: Number,
      default: 0,
      min: [0, 'tokenVersion cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: 'tokenVersion must be a whole number',
      },
    },
    mustChangePassword: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    strict: 'throw',
    toJSON: { transform: removePasswordHash },
    toObject: { transform: removePasswordHash },
  },
);

userSchema.index({ email: 1 }, { unique: true });

// Blocks every update, replace and bulkWrite route that could change role.
// The plugin is tested on its own in tests/integration/immutableFields.plugin.test.js.
userSchema.plugin(immutableFields, { fields: ['role'] });

// Runs the field validators on update operations too. It must come AFTER immutableFields,
// so a change to a protected field is reported as IMMUTABLE_FIELD, not as a validation error.
userSchema.plugin(validateOnUpdate);

export const User = mongoose.model('User', userSchema);