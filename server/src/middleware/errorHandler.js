import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

// Turn errors we recognise into an ApiError. Return null for anything else.
function toApiError(err) {
  if (err instanceof ApiError) return err;

  // Errors raised by Express's JSON body parser (we add the parser in Task 2.5).
  if (err?.type === 'entity.parse.failed') {
    return new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  }
  if (err?.type === 'entity.too.large') {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  }
  return null;
}

// Express treats a function with exactly FOUR parameters as an error handler,
// so `next` must stay in the signature even though we rarely use it.
export function errorHandler(err, req, res, next) {
  // If a response is already partly sent, we can't replace it. Let Express close it.
  if (res.headersSent) return next(err);

  const known = toApiError(err);
  if (known) {
    return res.status(known.statusCode).json({
      success: false,
      error: { code: known.code, message: known.message, details: known.details },
    });
  }

  // Unexpected error: log the full error on the SERVER only (quiet during tests),
  // and send the client a generic message with no stack trace or internal detail.
  if (!env.isTest) console.error('Unhandled error:', err);
  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Something went wrong on the server.',
    },
  });
}