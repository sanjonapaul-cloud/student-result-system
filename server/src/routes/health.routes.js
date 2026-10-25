import { Router } from 'express';
import mongoose from 'mongoose';
import { env } from '../config/env.js';

const router = Router();

// Mongoose reports its connection state as a number.
const DB_STATES = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };

// GET /api/v1/health : answers "is the server up, and can it reach the database?"
router.get('/', (req, res) => {
  const database = DB_STATES[mongoose.connection.readyState] ?? 'unknown';
  const healthy = database === 'connected';

  // 503 (Service Unavailable) when the database is not connected,
  // so monitors and deployment platforms can detect the problem.
  res.status(healthy ? 200 : 503).json({
    success: healthy,
    data: {
      status: healthy ? 'ok' : 'degraded',
      database,
      environment: env.nodeEnv,
      timestamp: new Date().toISOString(),
    },
  });
});

export default router;