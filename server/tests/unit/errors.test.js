import { describe, it, expect } from 'vitest';
import { ApiError } from '../../src/utils/ApiError.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { notFound } from '../../src/middleware/notFound.js';
import { env } from '../../src/config/env.js';

// A stand-in for Express's response object that records what was sent.
function fakeRes() {
  const res = { headersSent: false, statusCode: undefined, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

describe('test environment', () => {
  it('runs with NODE_ENV=test, so expected errors do not spam the log', () => {
    expect(env.isTest).toBe(true);
  });
});

describe('ApiError', () => {
  it('carries status, code, message and details, and is a real Error', () => {
    const err = new ApiError(404, 'NOT_FOUND', 'x', [{ field: 'a' }]);
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('x');
    expect(err.details).toEqual([{ field: 'a' }]);
  });
});

describe('errorHandler', () => {
  it('formats an ApiError in the agreed error format', () => {
    const res = fakeRes();
    errorHandler(new ApiError(422, 'VALIDATION_ERROR', 'bad', [{ field: 'a' }]), {}, res, () => {});
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'bad', details: [{ field: 'a' }] },
    });
  });

  it('hides internal details of unexpected errors', () => {
    const res = fakeRes();
    errorHandler(new Error('secret internal detail'), {}, res, () => {});
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(res.body.error.message).toBe('Something went wrong on the server.');
    expect(JSON.stringify(res.body)).not.toContain('secret internal detail');
  });

  it('turns a JSON parse failure into INVALID_JSON (400) with the exact message', () => {
    const res = fakeRes();
    errorHandler({ type: 'entity.parse.failed' }, {}, res, () => {});
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
    expect(res.body.error.message).toBe('Request body is not valid JSON.');
  });

  it('turns an oversized body into PAYLOAD_TOO_LARGE (413) with the exact message', () => {
    const res = fakeRes();
    errorHandler({ type: 'entity.too.large' }, {}, res, () => {});
    expect(res.statusCode).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(res.body.error.message).toBe('Request body is too large.');
  });

  it('does not write a response if one was already started', () => {
    const res = fakeRes();
    res.headersSent = true;
    const boom = new Error('late failure');
    let passedOn;
    errorHandler(boom, {}, res, (e) => {
      passedOn = e;
    });
    expect(passedOn).toBe(boom);
    expect(res.statusCode).toBeUndefined();
    expect(res.body).toBeUndefined();
  });
});

describe('notFound', () => {
  it('passes a 404 NOT_FOUND ApiError that names the method and path', () => {
    let passedOn;
    notFound({ method: 'GET', path: '/api/v1/nope' }, {}, (e) => {
      passedOn = e;
    });
    expect(passedOn).toBeInstanceOf(ApiError);
    expect(passedOn.statusCode).toBe(404);
    expect(passedOn.code).toBe('NOT_FOUND');
    expect(passedOn.message).toBe('Route not found: GET /api/v1/nope');
  });
});