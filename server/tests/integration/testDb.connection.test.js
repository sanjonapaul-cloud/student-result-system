import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectTestDb, disconnectTestDb } from '../helpers/testDb.js';

describe('test database connection', () => {
  let connection;

  beforeAll(async () => {
    connection = await connectTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('is connected to a database whose name ends with _test', () => {
    expect(connection.readyState).toBe(1);
    expect(connection.name.endsWith('_test')).toBe(true);
  });

  it('answers a ping', async () => {
    const result = await connection.db.admin().command({ ping: 1 });
    expect(result.ok).toBe(1);
  });

  it('reports a replica set member (a hint only, not proof that transactions work)', async () => {
    const hello = await connection.db.admin().command({ hello: 1 });
    expect(Boolean(hello.setName)).toBe(true);
  });
});