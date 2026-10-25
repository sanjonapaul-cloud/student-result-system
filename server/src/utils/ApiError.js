// An error we throw on purpose, carrying everything the client needs.
export class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode; // HTTP status, e.g. 404
    this.code = code; // stable machine-readable text, e.g. 'NOT_FOUND'
    this.details = details; // optional extra info, e.g. validation problems
  }
}