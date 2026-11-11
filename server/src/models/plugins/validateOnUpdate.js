// Mongoose plugin: runs schema validators on update operations.
//
// Mongoose validates on create() and save(), but NOT on updateOne / updateMany /
// findOneAndUpdate unless runValidators is set on every query. A probe on Mongoose 9.11.4
// showed that without it an update can store an invalid value ('BAD VALUE!' in a field
// with a pattern check, a negative number, or no value at all in a required field).
//
// Use it on a schema:  schema.plugin(validateOnUpdate);
//
// Limits (all shown by the probe or by Mongoose's design):
//   - Update validators only check the fields named in the update. A required field is
//     checked only when the update tries to unset it.
//   - bulkWrite updateOne / updateMany skip validators, and an operation-level
//     runValidators flag does not help. They are NOT covered by this plugin.
//   - replaceOne is not covered. Models with immutable fields refuse it outright
//     through the immutableFields plugin.

export function validateOnUpdate(schema) {
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
    // Forced on, so a caller cannot turn it off with { runValidators: false }.
    this.setOptions({ runValidators: true });
  });
}