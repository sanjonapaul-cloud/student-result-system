import express from 'express';
import apiRoutes from './routes/index.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

// Don't advertise that this is Express. Helmet in Phase 4 will cover more headers.
app.disable('x-powered-by');

// Parse JSON request bodies, with a size cap to reject oversized payloads.
app.use(express.json({ limit: '100kb' }));

// All API routes live under the versioned prefix.
app.use('/api/v1', apiRoutes);

// Must stay LAST, and in this order.
app.use(notFound);
app.use(errorHandler);

export default app;