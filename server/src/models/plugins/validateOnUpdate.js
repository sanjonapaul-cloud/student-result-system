// Mongoose plugin: runs schema validators on update operations, and refuses the routes that
// skip them (bulk updates and whole-document replaces).
//
// Mongoose validates on create() and save(), but NOT on updateOne / updateMany /
// findOneAndUpdate unless runValidators is set on every query. A probe on Mongoose 9.11.4
// showed that without it an update can store an invalid value ('BAD VALUE!' in a field
// with a pattern check, a negative number, or no value at all in a required field).
//
// Use it on a schema:  schema.plugin(validateOnUpdate);
// When a model also uses immutableFields, register immutableFields FIRST, so a change to a
// protected field is reported as IMMUTABLE_FIELD and not as a replace or validation error.
//
// What it does:
//   - Forces runValidators on for updateOne, updateMany and findOneAndUpdate.
//   - Refuses bulkWrite updateOne and updateMany (BULK_UPDATE_NOT_ALLOWED). A probe showed
//     they skip validators, even with a per-operation runValidators flag.
//   - Refuses replaceOne, findOneAndReplace and bulkWrite replaceOne (REPLACE_NOT_ALLOWED).
//     A probe showed a replacement document skips the pattern validators: replaceOne stored
//     'BAD VALUE!' in a code field. Services change fields with updateOne or
//     findOneAndUpdate instead.
//   - bulkWrite insertOne is still allowed, because Mongoose validates inserts.
//
// Limits (shown by probes on Mongoose 9.11.4):
//   - Update validators only check the fields named in the update. A required field is
//     checked only when the update tries to unset it.
//   - $inc is NOT validated: a probe stored tokenVersion -5 through $inc. Code that uses
//     $inc must guard its own amounts.
//   - Raw driver access (Model.collection) bypasses Mongoose and is out of scope.

// Thrown when code tries a bulkWrite update on a model that must not allow it.
// This is a programming error, not bad client input, so it is not an ApiError.
export class BulkUpdateNotAllowedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BulkUpdateNotAllowedError';
    this.code = 'BULK_UPDATE_NOT_ALLOWED';
  }
}

// Thrown when code tries to replace a whole document on a model that must not allow it.
// Also a programming error, not bad client input.
export class ReplaceNotAllowedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReplaceNotAllowedError';
    this.code = 'REPLACE_NOT_ALLOWED';
  }
}

const REPLACE_MESSAGE =
  'Replacing a whole document skips validation and is not allowed on this model. ' +
  'Use updateOne or findOneAndUpdate instead.';

export function validateOnUpdate(schema) {
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
    // Forced on, so a caller cannot turn it off with { runValidators: false }.
    this.setOptions({ runValidators: true });
  });

  schema.pre(['replaceOne', 'findOneAndReplace'], async function () {
    throw new ReplaceNotAllowedError(REPLACE_MESSAGE);
  });

  // bulkWrite updates and replaces skip validators, so they are refused (fail closed).
  // Mongoose 9's hook arguments are not documented here, so this finds the operations list
  // among the arguments and refuses the call if it cannot find one, as immutableFields does.
  // Operations are checked in order, and the first offending one decides the error.
  schema.pre('bulkWrite', async function (...args) {
    const operations = args.find(Array.isArray);
    if (!operations) {
      throw new BulkUpdateNotAllowedError(
        'Cannot inspect the bulkWrite operations, so the call is refused',
      );
    }
    for (const operation of operations) {
      if (operation?.replaceOne) {
        throw new ReplaceNotAllowedError(REPLACE_MESSAGE);
      }
      if (operation?.updateOne || operation?.updateMany) {
        throw new BulkUpdateNotAllowedError(
          'bulkWrite updateOne/updateMany skip validation and are not allowed on this model. ' +
            'Use updateOne, updateMany or findOneAndUpdate instead.',
        );
      }
    }
  });
}