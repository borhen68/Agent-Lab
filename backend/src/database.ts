import { PrismaClient } from '@prisma/client';
import { config } from './config';
import logger from './logger';

let prisma: PrismaClient;

export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      log: config.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    });
  }

  return prisma;
}

export async function initializeDatabase(): Promise<void> {
  const client = getPrismaClient();

  try {
    // Test connection
    await client.$queryRaw`SELECT 1`;
    logger.info('✅ Database connection successful');

    // Run a simple lightweight test query that works on any SQL dialect
    await client.$queryRawUnsafe('SELECT 1');

    logger.info('✅ Database initialized');
  } catch (error) {
    logger.error('❌ Database connection failed:', error);
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    logger.info('Database disconnected');
  }
}

export { PrismaClient };
