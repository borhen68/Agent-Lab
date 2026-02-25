import { Request, Response, NextFunction } from 'express';
import { config as appConfig } from './config';

/**
 * Optional basic auth middleware.
 * Activated when BASIC_AUTH_USER and BASIC_AUTH_PASS are set in .env.
 * Skipped entirely if either env var is missing (dev-friendly).
 */
export function optionalBasicAuth(req: Request, res: Response, next: NextFunction): void {
    const user = process.env.BASIC_AUTH_USER;
    const pass = process.env.BASIC_AUTH_PASS;

    // Skip if not configured
    if (!user || !pass) {
        next();
        return;
    }

    // Health check always passes
    if (req.path === '/health') {
        next();
        return;
    }

    const authorization = req.headers.authorization || '';
    const [scheme, credentials] = authorization.split(' ');

    if (scheme?.toLowerCase() !== 'basic' || !credentials) {
        challenge(res);
        return;
    }

    try {
        const decoded = Buffer.from(credentials, 'base64').toString('utf8');
        const [incomingUser, ...passParts] = decoded.split(':');
        const incomingPass = passParts.join(':');

        if (incomingUser === user && incomingPass === pass) {
            next();
        } else {
            challenge(res);
        }
    } catch {
        challenge(res);
    }
}

function challenge(res: Response): void {
    res.setHeader('WWW-Authenticate', 'Basic realm="Agent Strategy Lab"');
    res.status(401).json({ error: 'Authentication required' });
}
