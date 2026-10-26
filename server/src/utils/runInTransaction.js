import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { ApiError } from './ApiError.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;

const EXHAUSTED_MESSAGE =
  'A conflicting update was in progress and nothing was saved. Please try again.';
const UNKNOWN_MESSAGE =
  'The save could not be confirmed. Reload to check the current state before trying again.';
const UNAVAILABLE_MESSAGE =
  'Database transactions are unavailable. Contact the administrator.';

// Thrown by our own attempt counter. It is deliberately NOT a MongoDB error,
// so the driver aborts the transaction and passes it straight back instead of retrying.
class RetryLimitReached extends Error {
  constructor(maxAttempts) {
    super(`Transaction retry limit reached (${maxAttempts} attempts)`);
    this.name = 'RetryLimitReached';
  }
}

function hasLabel(err, label) {
  return typeof err?.hasErrorLabel === 'function' && err.hasErrorLabel(label);
}

function labelsOf(err) {
  return Array.isArray(err?.errorLabels) ? err.errorLabels : [];
}

// Unverified assumption: the driver's timeout error reports this name.
function isTimeout(err) {
  return err?.name === 'MongoOperationTimeoutError';
}

// Unverified assumption: a server without transaction support answers with code 20.
function isTransactionsUnavailable(err) {
  return err?.code === 20 && /transaction/i.test(err?.message ?? '');
}

// Decide what the caller should see. Returns the SAME error object when it
// should pass through unchanged (business errors, duplicate keys, bugs).
function translate(err) {
  if (err instanceof ApiError) return err;

  if (err instanceof RetryLimitReached) {
    return new ApiError(503, 'TRANSACTION_RETRY_EXHAUSTED', EXHAUSTED_MESSAGE, undefined, { 'Retry-After': '1' });
  }
  // Checked before "transient" on purpose: when unsure, assume the write may have happened.
  if (hasLabel(err, 'UnknownTransactionCommitResult')) {
    return new ApiError(503, 'COMMIT_STATUS_UNKNOWN', UNKNOWN_MESSAGE);
  }
  if (hasLabel(err, 'TransientTransactionError')) {
    return new ApiError(503, 'TRANSACTION_RETRY_EXHAUSTED', EXHAUSTED_MESSAGE, undefined, { 'Retry-After': '1' });
  }
  // A timeout with no label: we cannot prove nothing was committed, so say so.
  if (isTimeout(err)) {
    return new ApiError(503, 'COMMIT_STATUS_UNKNOWN', UNKNOWN_MESSAGE);
  }
  if (isTransactionsUnavailable(err)) {
    return new ApiError(503, 'TRANSACTIONS_UNAVAILABLE', UNAVAILABLE_MESSAGE);
  }
  return err;
}

// Default runner: Mongoose's helper, which wraps the driver's withTransaction.
const defaultRunner = (fn, options) => mongoose.connection.transaction(fn, options);

/**
 * Run `work(session)` as one all-or-nothing transaction.
 *
 * Rules for `work`:
 *  - Pass `{ session }` to EVERY database call inside it, or that call is not part of the transaction.
 *  - It may run more than once, so re-read all state inside it and do nothing outside the database.
 *  - Do not catch and rewrap MongoDB errors: their labels decide whether a retry happens.
 */
export async function runInTransaction(work, options = {}) {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    timeoutMS = DEFAULT_TIMEOUT_MS,
    runner = defaultRunner, // replaced by a fake in unit tests
  } = options;

  let attempts = 0;
  let lastError = null;

  const attempt = async (session) => {
    attempts += 1;
    if (attempts > maxAttempts) throw new RetryLimitReached(maxAttempts);
    try {
      return await work(session);
    } catch (err) {
      lastError = err; // remembered for the log only, then rethrown unchanged
      throw err;
    }
  };

  try {
    return await runner(attempt, { timeoutMS });
  } catch (err) {
    const translated = translate(err);
    if (translated !== err && !env.isTest) {
      const labels = labelsOf(err).concat(labelsOf(lastError));
      console.warn(
        `Transaction failed: code=${translated.code} attempts=${attempts} labels=[${[...new Set(labels)].join(',')}]`,
      );
    }
    throw translated;
  }
}