// //// Neoffice — added file (no upstream equivalent)
// Séance note-taking: the pick-up side. The instance (server to server) comes
// to fetch what was captured, with the pull key only it holds. The SFU keeps
// the SHA-256 of that key, never the key itself.
//
//   GET    /seance/:handle/manifest        what exists (tracks, chunks, speech)
//   GET    /seance/:handle/chunks/:file    one sealed chunk
//   POST   /seance/:handle/ack             {files: [...]}  the chunks stored, drop them
//   POST   /seance/:handle/stop            end the séance (host gone)
//   POST   /seance/:handle/withdraw        {user_id, erase}  a person withdrew elsewhere
//   DELETE /seance/:handle                 forget everything
//
// Every request carries `Authorization: Bearer <pull key>`. An unknown séance
// and a wrong key answer the same way.

import fs from 'node:fs';
import type { Application, Request, Response } from 'express';
import { loggers } from '../utils/logger';
import type { SeanceManager } from './SeanceManager';

const log = loggers.seance;

const FAILURES_PER_MINUTE = 20;
const FAILURE_WINDOW_MS = 60_000;
const MAX_ACK_FILES = 2000;

function clientAddress(req: Request): string {
	const forwarded = req.headers['x-forwarded-for'];
	const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
		?.split(',')[0]
		?.trim();
	return first || req.socket.remoteAddress || 'unknown';
}

function bearer(req: Request): string {
	const header = req.headers.authorization;
	if (typeof header !== 'string') return '';
	const match = /^Bearer\s+(\S{16,256})$/i.exec(header);
	return match ? match[1] : '';
}

export function registerSeanceRoutes(
	app: Application,
	manager: SeanceManager,
): void {
	// Failed attempts per address, over a sliding minute. A plain map: no
	// timer, nothing to dispose of.
	const failures = new Map<string, { count: number; resetAt: number }>();
	const tooManyFailures = (address: string): boolean => {
		const now = Date.now();
		if (failures.size > 5000) {
			for (const [key, entry] of failures) {
				if (entry.resetAt < now) failures.delete(key);
			}
		}
		const entry = failures.get(address);
		return (
			!!entry && entry.resetAt >= now && entry.count >= FAILURES_PER_MINUTE
		);
	};
	const recordFailure = (address: string): void => {
		const now = Date.now();
		const entry = failures.get(address);
		if (!entry || entry.resetAt < now) {
			failures.set(address, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
		} else {
			entry.count++;
		}
	};

	// Resolves the séance of a request, answering 401/429 itself when it
	// cannot. Returns null when a response has already been sent.
	const authorize = (req: Request, res: Response) => {
		if (!manager.enabled) {
			res.status(404).json({ error: 'not_found' });
			return null;
		}
		const address = clientAddress(req);
		if (tooManyFailures(address)) {
			res.status(429).json({ error: 'too_many_requests' });
			return null;
		}
		const seance = manager.authorizePull(req.params.handle, bearer(req));
		if (!seance) {
			recordFailure(address);
			res.status(401).json({ error: 'unauthorized' });
			return null;
		}
		return seance;
	};

	app.get('/seance/:handle/manifest', (req: Request, res: Response) => {
		const seance = authorize(req, res);
		if (!seance) return;
		res.setHeader('Cache-Control', 'no-store');
		res.json(manager.manifest(seance));
	});

	app.get('/seance/:handle/chunks/:file', (req: Request, res: Response) => {
		const seance = authorize(req, res);
		if (!seance) return;
		const full = manager.chunkPath(seance, req.params.file);
		if (!full) {
			res.status(404).json({ error: 'not_found' });
			return;
		}
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('Content-Type', 'application/octet-stream');
		const stream = fs.createReadStream(full);
		stream.on('error', () => {
			if (!res.headersSent) res.status(404).json({ error: 'not_found' });
			else res.destroy();
		});
		stream.pipe(res);
	});

	app.post('/seance/:handle/ack', (req: Request, res: Response) => {
		const seance = authorize(req, res);
		if (!seance) return;
		const files: unknown = req.body?.files;
		if (
			!Array.isArray(files) ||
			files.length > MAX_ACK_FILES ||
			!files.every((f) => typeof f === 'string')
		) {
			res.status(400).json({ error: 'bad_request' });
			return;
		}
		res.json({ removed: manager.acknowledge(seance, files as string[]) });
	});

	app.post('/seance/:handle/stop', (req: Request, res: Response) => {
		const seance = authorize(req, res);
		if (!seance) return;
		manager.stopByPull(seance);
		res.json({ state: seance.state });
	});

	app.post('/seance/:handle/withdraw', (req: Request, res: Response) => {
		const seance = authorize(req, res);
		if (!seance) return;
		const userId: unknown = req.body?.user_id;
		if (
			typeof userId !== 'string' ||
			userId.length === 0 ||
			userId.length > 256
		) {
			res.status(400).json({ error: 'bad_request' });
			return;
		}
		manager.withdrawByPull(seance, userId, req.body?.erase === true);
		res.json({ ok: true });
	});

	app.delete('/seance/:handle', (req: Request, res: Response) => {
		const seance = authorize(req, res);
		if (!seance) return;
		manager.purge(seance);
		log.info('Séance %s purged by its instance', seance.handle.slice(0, 8));
		res.status(204).end();
	});
}
