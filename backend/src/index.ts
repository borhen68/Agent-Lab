import express, { Application } from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { validateConfig, config } from './config';
import { initializeDatabase, disconnectDatabase } from './database';
import { initializeRedis, disconnectRedis } from './redis';
import logger from './logger';
import {
  requestIdMiddleware,
  loggerMiddleware,
  securityMiddleware,
  errorHandler,
  notFoundHandler,
} from './middleware';
import tasksRouter from './routes/tasks';
import agentsRouter from './routes/agents';
import strategiesRouter from './routes/strategies';
import skillsRouter from './routes/skills';
import systemRouter from './routes/system';
import { optionalBasicAuth } from './auth';

// Rate limiters
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const taskLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded: maximum 5 races per minute per IP.' },
});

// Validate config on startup
validateConfig();

const app: Application = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: config.CORS_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Store io instance for routes to access
app.set('io', io);

// Middleware
app.use(requestIdMiddleware);
app.use(loggerMiddleware);
app.use(securityMiddleware);
app.use(cors({ origin: config.CORS_ORIGIN }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: config.NODE_ENV,
  });
});

// Optional basic auth (set BASIC_AUTH_USER + BASIC_AUTH_PASS in .env to enable)
app.use(optionalBasicAuth);

// API Routes
app.use(generalLimiter);
app.use('/api/tasks', taskLimiter, tasksRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/strategies', strategiesRouter);
app.use('/api/skills', skillsRouter);
app.use('/api/system', systemRouter);

// WebSocket
io.on('connection', (socket) => {
  logger.info(`🔌 Client connected: ${socket.id}`);

  socket.on('watch_task', (taskId: string) => {
    socket.join(`task:${taskId}`);
    logger.debug(`Client ${socket.id} watching task ${taskId}`);
  });

  socket.on('disconnect', () => {
    logger.info(`🔌 Client disconnected: ${socket.id}`);
  });
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Graceful shutdown
async function shutdown() {
  logger.info('🛑 Shutting down gracefully...');
  await disconnectDatabase();
  await disconnectRedis();
  httpServer.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
async function start() {
  try {
    logger.info('🚀 Starting Agent Strategy Lab...');

    // Initialize services
    await initializeDatabase();
    await initializeRedis();

    // Start server
    httpServer.listen(config.PORT, () => {
      logger.info(`✅ Server running on port ${config.PORT}`);
      logger.info(`📍 Environment: ${config.NODE_ENV}`);
      logger.info(`🌐 CORS origin: ${config.CORS_ORIGIN}`);
    });
  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

start();

export { app, httpServer, io };
