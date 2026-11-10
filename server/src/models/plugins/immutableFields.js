// Mongoose plugin: stops listed top-level fields from being changed after a document exists.
//
// Use it AFTER the fields are defined, and declare each field with `immutable: true`:
//   schema.plugin(immutableFields, { fields: ['role'] });
//
// What it blocks (all with an ImmutableFieldError, code 'IMMUTABLE_FIELD'):
//   - updateOne / updateMany / findOneAndUpdate whose update touches a listed field
//     ($set, $unset, $setOnInsert, $rename, a bare field name, or any pipeline update)
//   - replaceOne / findOneAndReplace (always, because a replacement rewrites every field)
//   - bulkWrite operations that replace, or update a listed field
//
// Limits: top-level field names only (no dotted paths). Raw driver access
// (Model.collection) bypasses Mongoose and is out of scope.

// Thrown when code tries to change a field that must never change.
// This is a programming error, not bad client input, so it is not an ApiError.
export class ImmutableFieldError extends Error {
  constructor(message, fields = []) {
    super(message);
    this.name = 'ImmutableFieldError';
    this.code = 'IMMUTABLE_FIELD';
    this.fields = fields;
  }
}

function updateTouchesProtectedField(update, fields) {
  // Pipeline updates ([ { $set: ... } ]) are too hard to inspect, so they are refused.
  if (Array.isArray(update)) return true;
  if (!update || typeof update !== 'object') return false;

  for (const [key, value] of Object.entries(update)) {
    // An update with no operator, e.g. { role: 'admin' }
    if (fields.includes(key)) return true;
    if (key.startsWith('$') && value && typeof value === 'object') {
      // $set, $unset, $setOnInsert, $rename (renaming a field away), and so on
      if (fields.some((field) => Object.hasOwn(value, field))) return true;
      // $rename: { something: 'role' } would overwrite role
      if (key === '$rename' && Object.values(value).some((target) => fields.includes(target))) {
        return true;
      }
    }
  }
  return false;
}

export function immutableFields(schema, options = {}) {
  const { fields } = options;

  if (
    !Array.isArray(fields) ||
    fields.length === 0 ||
    fields.some((field) => typeof field !== 'string' || field === '')
  ) {
    throw new TypeError('immutableFields needs options.fields: a non-empty array of field names');
  }

  for (const field of fields) {
    const schemaPath = schema.path(field);
    if (!schemaPath) {
      throw new Error(`immutableFields: "${field}" is not a path in this schema`);
    }
    if (schemaPath.options?.immutable !== true) {
      throw new Error(`immutableFields: "${field}" must be declared with immutable: true`);
    }
  }

  const protectedFields = Object.freeze([...fields]);
  const list = protectedFields.join(', ');

  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], async function () {
    if (updateTouchesProtectedField(this.getUpdate(), protectedFields)) {
      throw new ImmutableFieldError(
        `Immutable field(s) cannot be changed by an update: ${list}`,
        protectedFields,
      );
    }
  });

  // replaceOne rewrites every field. A probe on Mongoose 9.11.4 showed that
  // immutable: true does NOT stop it, so it is refused outright.
  schema.pre(['replaceOne', 'findOneAndReplace'], async function () {
    throw new ImmutableFieldError(
      `Documents with immutable fields (${list}) cannot be replaced as a whole`,
      protectedFields,
    );
  });

  // Model.bulkWrite() skips the query hooks above. Mongoose 9's exact hook arguments are not
  // documented here, so this finds the operations list among the arguments and refuses the
  // whole call if it cannot find one (fail closed).
  schema.pre('bulkWrite', async function (...args) {
    const operations = args.find(Array.isArray);
    if (!operations) {
      throw new ImmutableFieldError(
        'Cannot inspect the bulkWrite operations, so the call is refused',
        protectedFields,
      );
    }

    for (const operation of operations) {
      if (operation.replaceOne) {
        throw new ImmutableFieldError(
          `Documents with immutable fields (${list}) cannot be replaced as a whole`,
          protectedFields,
        );
      }
      for (const kind of ['updateOne', 'updateMany']) {
        if (operation[kind] && updateTouchesProtectedField(operation[kind].update, protectedFields)) {
          throw new ImmutableFieldError(
            `Immutable field(s) cannot be changed by a bulkWrite: ${list}`,
            protectedFields,
          );
        }
      }
    }
  });
}