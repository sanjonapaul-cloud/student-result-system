import { Router } from 'express';
import healthRoutes from './health.routes.js';

const router = Router();

// Every module's routes get mounted here as the project grows.
router.use('/health', healthRoutes);

export default router;