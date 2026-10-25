import { ApiError } from '../utils/ApiError.js';

// Runs only when no earlier route matched the request.
export function notFound(req, res, next) {
  next(new ApiError(404, 'NOT_FOUND', `Route not found: ${req.method} ${req.path}`));
}