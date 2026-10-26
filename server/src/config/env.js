import dotenv from 'dotenv';
import { isIP } from 'node:net';
import { z } from 'zod';

// Load server/.env into process.env (quiet: no startup banner).
dotenv.config({ quiet: true });

// Turn "8.8.8.8, 8.8.4.4" into ['8.8.8.8', '8.8.4.4'].
function splitList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// Describe what a valid configuration looks like.
const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  // Environment variables are always text, so coerce converts "5000" to 5000.
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  // Comma-separated list of browser origins allowed to call this API (used later for CORS).
  CLIENT_ORIGINS: z.string().default('http://localhost:5173'),
  // Contains a password. Required, and checked only for its general shape.
  MONGODB_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
  // Optional. Used only by automated tests, and its database name MUST end with _test
  // so a test run can never touch real data.
  MONGODB_URI_TEST: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://')
    .regex(/\/[A-Za-z0-9_-]+_test(\?|$)/, 'must name a database whose name ends with _test')
    .optional(),
  // Optional. Only for networks where Node's default DNS lookup fails (see db.js).
  DNS_SERVERS: z
    .string()
    .optional()
    .refine(
      (value) => value === undefined || splitList(value).every((item) => isIP(item) !== 0),
      'must be a comma-separated list of IP addresses',
    ),
});

const parsed = envSchema.safeParse(process.env);

// Fail fast: refuse to start with a broken configuration.
// Only variable names and messages are printed, never values.
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const raw = parsed.data;

// The only configuration object the rest of the app should use.
// WARNING: it holds secrets (mongodbUri, mongodbUriTest). Never log or print this object.
export const env = Object.freeze({
  nodeEnv: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  port: raw.PORT,
  clientOrigins: splitList(raw.CLIENT_ORIGINS),
  mongodbUri: raw.MONGODB_URI,
  mongodbUriTest: raw.MONGODB_URI_TEST ?? null,
  dnsServers: raw.DNS_SERVERS ? splitList(raw.DNS_SERVERS) : [],
});