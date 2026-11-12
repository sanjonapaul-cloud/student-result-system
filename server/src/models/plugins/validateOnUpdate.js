// Mongoose plugin: runs schema validators on update operations, and refuses bulk updates.
//
// Mongoose validates on create() and save(), but NOT on updateOne / updateMany /
// findOneAndUpdate unless runValidators is set on every query. A probe on Mongoose 9.11.4
// showed that without it an update can store an invalid value ('BAD VALUE!' in a field
// with a pattern check, a negative number, or no value at all in a required field).
//
// Use it on a schema:  schema.plugin(validateOnUpdate);
// When a model also uses immutableFields, register immutableFields FIRST, so a change to a
// protected field is reported as IMMUTABLE_FIELD and not as a validation error.
//
// What it does:
//   - Forces runValidators on for updateOne, updateMany and findOneAndUpdate.
//   - Refuses bulkWrite updateOne and updateMany (BULK_UPDATE_NOT_ALLOWED). The same probe
//     showed they skip validators, even with a per-operation runValidators flag.
//     bulkWrite insertOne is still allowed, because Mongoose validates inserts.
//
// Limits (shown by probes on Mongoose 9.11.4):
//   - Update validators only check the fields named in the update. A required field is
//     checked only when the update tries to unset it.
//   - $inc is NOT validated: a probe stored tokenVersion -5 through $inc. Code that uses
//     $inc must guard its own amounts.
//   - replaceOne is not covered here. Models with immutable fields refuse it outright
//     through the immutableFields plugin, which a model without protected fields would lack.

// Thrown when code tries a bulkWrite update on a model that must not allow it.
// This is a programming error, not bad client input, so it is not an ApiError.
export class BulkUpdateNotAllowedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BulkUpdateNotAllowedError';
    this.code = 'BULK_UPDATE_NOT_ALLOWED';
  }
}

export function validateOnUpdate(schema) {
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
    // Forced on, so a caller cannot turn it off with { runValidators: false }.
    this.setOptions({ runValidators: true });
  });

  // bulkWrite updates skip validators, so they are refused (fail closed). Mongoose 9's hook
  // arguments are not documented here, so this finds the operations list among the arguments
  // and refuses the call if it cannot find one, as the immutableFields plugin does.
  schema.pre('bulkWrite', async function (...args) {
    const operations = args.find(Array.isArray);
    if (!operations) {
      throw new BulkUpdateNotAllowedError(
        'Cannot inspect the bulkWrite operations, so the call is refused',
      );
    }
    if (operations.some((operation) => operation?.updateOne || operation?.updateMany)) {
      throw new BulkUpdateNotAllowedError(
        'bulkWrite updateOne/updateMany skip validation and are not allowed on this model. ' +
          'Use updateOne, updateMany or findOneAndUpdate instead.',
      );
    }
  });
}