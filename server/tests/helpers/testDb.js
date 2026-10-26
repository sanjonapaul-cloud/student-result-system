import dns from 'node:dns';
import mongoose from 'mongoose';
import { env } from '../../src/config/env.js';

// Connect Mongoose's default connection to the TEST database.
// This must never run against development data, so the name is checked again after connecting.
export async function connectTestDb() {
  if (!env.mongodbUriTest) {
    throw new Error(
      'MONGODB_URI_TEST is not set in server/.env. See .env.example. The database name must end with _test.',
    );
  }
  if (env.dnsServers.length > 0) {
    dns.setServers(env.dnsServers);
  }

  await mongoose.connect(env.mongodbUriTest, { serverSelectionTimeoutMS: 10000 });

  const name = mongoose.connection.name;
  if (!name.endsWith('_test')) {
    await mongoose.disconnect();
    throw new Error(`Refusing to run tests on database "${name}": the name must end with _test.`);
  }
  return mongoose.connection;
}

export async function disconnectTestDb() {
  await mongoose.disconnect();
}