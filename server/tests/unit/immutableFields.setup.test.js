import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { immutableFields } from '../../src/models/plugins/immutableFields.js';

// No database is used here. These tests only check that a bad setup fails at startup.

function schemaWith(roleOptions) {
  return new mongoose.Schema({ role: roleOptions, note: String });
}

describe('immutableFields plugin: setup checks', () => {
  it('rejects a missing, empty or malformed field list', () => {
    const cases = [
      ['no options', undefined],
      ['no fields key', {}],
      ['empty array', { fields: [] }],
      ['not an array', { fields: 'role' }],
      ['non-string entry', { fields: ['role', 42] }],
      ['empty string entry', { fields: [''] }],
    ];
    for (const [label, options] of cases) {
      const schema = schemaWith({ type: String, immutable: true });
      expect(() => schema.plugin(immutableFields, options), label).toThrow(/non-empty array/);
    }
  });

  it('rejects a field that is not in the schema', () => {
    const schema = schemaWith({ type: String, immutable: true });
    expect(() => schema.plugin(immutableFields, { fields: ['rolee'] })).toThrow(/not a path/);
  });

  it('rejects a field that is not declared immutable: true', () => {
    const schema = schemaWith({ type: String });
    expect(() => schema.plugin(immutableFields, { fields: ['role'] })).toThrow(/immutable: true/);
  });

  it('accepts a valid setup', () => {
    const schema = schemaWith({ type: String, immutable: true });
    expect(() => schema.plugin(immutableFields, { fields: ['role'] })).not.toThrow();
  });
});