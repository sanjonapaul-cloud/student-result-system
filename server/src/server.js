import app from './app.js';
import { env } from './config/env.js';
import { connectDb, disconnectDb } from './config/db.js';

async function start() {
  // 1. Database first. Without it the API can't do its job.
  try {
    await connectDb();
    console.log('MongoDB connected');
  } catch (err) {
    console.error('Could not connect to MongoDB:', err.message);
    process.exit(1);
  }

  // 2. Then start accepting requests.
  const server = app.listen(env.port, (err) => {
    // Express 5 also calls this callback when listening fails; the 'error' handler below reports it.
    if (err) return;
    console.log(`Server listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });

  server.on('error', (listenErr) => {
    if (listenErr.code === 'EADDRINUSE') {
      console.error(`Port ${env.port} is already in use. Stop the other process or change PORT in .env.`);
    } else {
      console.error('Server failed to start:', listenErr);
    }
    process.exit(1);
  });

  // 3. Clean shutdown.
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down...`);

    // Backstop: if closing takes more than 10 seconds, exit anyway.
    setTimeout(() => process.exit(1), 10000).unref();

    server.close(async () => {
      await disconnectDb();
      console.log('Shutdown complete');
      process.exit(0);
    });
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();