/**
 * Prisma Client Singleton
 * Reuses a single PrismaClient instance across the app to avoid
 * exhausting the Neon PostgreSQL connection pool.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  log: ['warn', 'error'],
});

export default prisma;
