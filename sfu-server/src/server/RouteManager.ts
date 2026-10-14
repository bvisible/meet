import fs from 'node:fs';
import path from 'node:path';
import type { Application, Request, Response } from 'express';
import type { MediasoupManager } from '../mediasoup/MediasoupManager';
import { registerSeanceRoutes } from '../seance/routes';
import type { SeanceManager } from '../seance/SeanceManager';
import type { HealthStats } from '../types';

export class RouteManager {
	private app: Application;
	private mediasoup: MediasoupManager;
	// //// Neoffice — séance note-taking (optional)
	private seance: SeanceManager | null;

	private static version: string = RouteManager.readVersion();

	private static readVersion(): string {
		try {
			const pkgPath = path.join(__dirname, '..', '..', 'package.json');
			const raw = fs.readFileSync(pkgPath, 'utf8');
			const json = JSON.parse(raw) as { version?: string };
			return json.version ?? 'unknown';
		} catch (_err) {
			return 'unknown';
		}
	}

	constructor(
		app: Application,
		mediasoup: MediasoupManager,
		seance: SeanceManager | null = null,
	) {
		this.app = app;
		this.mediasoup = mediasoup;
		this.seance = seance;
	}

	setupRoutes(): void {
		this.app.get('/', (_req: Request, res: Response) => {
			res.json({
				message: 'NeoMeet SFU Server is running',
				version: RouteManager.version,
				timestamp: new Date().toISOString(),
			});
		});

		this.app.get('/health', (_req: Request, res: Response) => {
			const stats: HealthStats = {
				status: 'healthy',
				uptime: process.uptime(),
				rooms: this.mediasoup.rooms.getRoomCount(),
				peers: this.mediasoup.peers.getPeerCount(),
				// //// Neoffice — capability announcement for the instances
				features: { seance: this.seance?.enabled === true },
			};
			res.json(stats);
		});

		// //// Neoffice — séance note-taking pick-up routes (/seance/*)
		if (this.seance) registerSeanceRoutes(this.app, this.seance);
	}
}
