import winston from 'winston';
import fs from 'fs';
import path from 'path';
import { config } from './config';

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const colors = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  debug: '\x1b[35m',
  reset: '\x1b[0m',
};

const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const color = colors[level as keyof typeof colors] || colors.reset;
    const cleanMessage = typeof message === 'string' ? message : JSON.stringify(message);
    let metaStr = '';

    if (Object.keys(meta).length > 0 && meta.stack === undefined) {
      metaStr = ` ${JSON.stringify(meta)}`;
    }

    return `${color}[${timestamp}] ${level.toUpperCase()}${colors.reset} ${cleanMessage}${metaStr}`;
  }),
);

const logDir = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

export const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  levels,
  format,
  defaultMeta: { service: 'agent-lab' },
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logDir, 'combined.log') }),
  ],
});

export default logger;
