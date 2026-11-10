import mongoose from 'mongoose';

const { Schema } = mongoose;

export const USER_ROLES = Object.freeze(['admin', 'teacher', 'student']);

// A real bcrypt hash at cost 12 is "$2b$12$" followed by 53 characters (60 in total).
// This stops a plaintext password from being stored by mistake.
const BCRYPT_COST_12_HASH = /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Thrown when code tries to change a field that must never change.
// This is a programming error, not bad client input, so it is not an ApiError.
class ImmutableFieldError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImmutableFieldError';
    this.code = 'IMMUTABLE_FIELD';
  }
}

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

// ---- Protect `role` on every update route that the probe showed to be silent or open ----

const PROTECTED_FIELD = 'role';

function updateTouchesRole(update) {
  // Pipeline updates ([ { $set: ... } ]) are too hard to inspect, so they are not allowed on User.
  if (Array.isArray(update)) return true;
  if (!update || typeof update !== 'object') return false;

  for (const [key, value] of Object.entries(update)) {
    // An update with no operator, e.g. { role: 'admin' }
    if (key === PROTECTED_FIELD) return true;
    if (key.startsWith('$') && value && typeof value === 'object') {
      // $set, $unset, $setOnInsert, and so on
      if (Object.hasOwn(value, PROTECTED_FIELD)) return true;
      // $rename: { something: 'role' } would overwrite role
      if (key === '$rename' && Object.values(value).includes(PROTECTED_FIELD)) return true;
    }
  }
  return false;
}

userSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], async function () {
  if (updateTouchesRole(this.getUpdate())) {
    throw new ImmutableFieldError('User.role is immutable and cannot be changed by an update.');
  }
});

// The probe showed replaceOne changes role even with immutable: true, so it is blocked outright.
userSchema.pre(['replaceOne', 'findOneAndReplace'], async function () {
  throw new ImmutableFieldError(
    'Users cannot be replaced as a whole. Use a targeted update (User.role is immutable).',
  );
});

// Model.bulkWrite() skips the query hooks above, and the tests showed that a bulkWrite
// replaceOne really did change role. So every operation is inspected before it runs.
// Mongoose 9's exact hook arguments are not confirmed, so this finds the operations list
// among the arguments and refuses the whole call if it cannot find one (fail closed).
userSchema.pre('bulkWrite', async function (...args) {
  const operations = args.find(Array.isArray);
  if (!operations) {
    throw new ImmutableFieldError(
      'Cannot inspect the bulkWrite operations on User, so the call is refused.',
    );
  }

  for (const operation of operations) {
    if (operation.replaceOne) {
      throw new ImmutableFieldError(
        'Users cannot be replaced as a whole (User.role is immutable).',
      );
    }
    for (const kind of ['updateOne', 'updateMany']) {
      if (operation[kind] && updateTouchesRole(operation[kind].update)) {
        throw new ImmutableFieldError(
          'User.role is immutable and cannot be changed by a bulkWrite.',
        );
      }
    }
  }
});

export const User = mongoose.model('User', userSchema);