import { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config';
import logger from './logger';

// Request ID middleware
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  req.id = req.headers['x-request-id'] as string || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  res.setHeader('x-request-id', req.id);
  next();
}

// Logging middleware
const morganFormat = config.NODE_ENV === 'development' ? 'dev' : 'combined';
export const loggerMiddleware = morgan(morganFormat, {
  stream: {
    write: (message) => logger.info(message.trim()),
  },
});

// Security middleware
export const securityMiddleware = helmet();

// Error handling middleware
export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  const requestId = req.id || 'unknown';

  logger.error(`[${requestId}] Error:`, {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  const statusCode = err.statusCode || 500;
  const message = config.NODE_ENV === 'production' ? 'Internal server error' : err.message;

  res.status(statusCode).json({
    error: message,
    requestId,
    ...(config.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

// Not found middleware
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    method: req.method,
  });
}

declare global {
  namespace Express {
    interface Request {
      id: string;
    }
  }
}
