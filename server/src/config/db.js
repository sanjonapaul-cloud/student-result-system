import dns from 'node:dns';
import mongoose from 'mongoose';
import { env } from './env.js';

// Connect once at startup. If the cluster can't be reached, fail in 10 seconds
// instead of waiting for the much longer default.
export async function connectDb() {
  // Optional workaround: on some machines Node's own DNS resolver can't look up
  // the SRV records that mongodb+srv:// needs. Setting DNS_SERVERS in .env tells
  // Node which servers to ask. Leave it unset on machines where DNS works.
  if (env.dnsServers.length > 0) {
    dns.setServers(env.dnsServers);
  }

  await mongoose.connect(env.mongodbUri, { serverSelectionTimeoutMS: 10000 });
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}