// //// Neoffice — added file (no upstream equivalent)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import { registerSeanceRoutes } from '../routes';
import { SeanceManager } from '../SeanceManager';
import {
	consentToken,
	FakeMedia,
	HOST,
	MARIE,
	makeInstance,
	makeSpoolDir,
	SECRET,
	Speaker,
	startToken,
	testConfig,
} from './fixtures';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function server() {
	const media = new FakeMedia();
	media.room();
	const spool = makeSpoolDir();
	const clock = { now: 1_800_000_000_000 };
	const manager = new SeanceManager({
		config: testConfig(spool),
		secret: SECRET,
		media,
		now: () => clock.now,
	});
	const app = express();
	app.use(express.json());
	registerSeanceRoutes(app, manager);
	const http: Server = await new Promise((resolve) => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s));
	});
	const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
	cleanups.push(async () => {
		await new Promise((resolve) => http.close(resolve));
		manager.shutdown();
		fs.rmSync(spool, { recursive: true, force: true });
	});

	const instance = makeInstance();
	await manager.start(HOST(), startToken(instance));
	media.addProducer('marie@example.ch');
	await manager.consent(MARIE(), consentToken('marie@example.ch'));
	new Speaker(media.consumers()[0], clock).talk(100);
	await manager.stop(HOST());

	const handle = fs
		.readdirSync(spool)
		.find((n) => /^[0-9a-f]{32}$/.test(n)) as string;
	const call = (path: string, init: RequestInit = {}, key = instance.pullKey) =>
		fetch(`${base}/seance/${handle}${path}`, {
			...init,
			headers: {
				...(init.headers as Record<string, string>),
				...(key ? { Authorization: `Bearer ${key}` } : {}),
				'Content-Type': 'application/json',
			},
		});
	return { base, handle, instance, manager, call, spool };
}

describe('pick-up routes', () => {
	it('serves the manifest to the holder of the pull key', async () => {
		const s = await server();
		const response = await s.call('/manifest');
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('cache-control'), 'no-store');
		const manifest = (await response.json()) as {
			seance_id: string;
			tracks: unknown[];
		};
		assert.equal(manifest.seance_id, 'MTG-0001');
		assert.equal(manifest.tracks.length, 1);
	});

	it('answers 401 the same way for a wrong key, no key, and an unknown séance', async () => {
		const s = await server();
		const wrong = await s.call('/manifest', {}, 'a-wrong-pull-key-0123456789');
		const none = await s.call('/manifest', {}, '');
		const unknown = await fetch(`${s.base}/seance/${'0'.repeat(32)}/manifest`, {
			headers: { Authorization: `Bearer ${s.instance.pullKey}` },
		});
		const malformed = await fetch(`${s.base}/seance/not-a-handle/manifest`, {
			headers: { Authorization: `Bearer ${s.instance.pullKey}` },
		});
		for (const response of [wrong, none, unknown, malformed]) {
			assert.equal(response.status, 401);
			assert.deepEqual(await response.json(), { error: 'unauthorized' });
		}
	});

	it('serves a chunk byte for byte, and refuses anything else', async () => {
		const s = await server();
		const manifest = (await (await s.call('/manifest')).json()) as {
			tracks: Array<{
				chunks: Array<{ file: string; bytes: number; sha256: string }>;
			}>;
		};
		const chunk = manifest.tracks[0].chunks[0];
		const response = await s.call(`/chunks/${chunk.file}`);
		assert.equal(response.status, 200);
		const body = Buffer.from(await response.arrayBuffer());
		assert.equal(body.length, chunk.bytes);
		const { createHash } = await import('node:crypto');
		assert.equal(createHash('sha256').update(body).digest('hex'), chunk.sha256);

		assert.equal((await s.call('/chunks/seance.json')).status, 404);
		assert.equal((await s.call('/chunks/..%2Fseance.json')).status, 404);
		assert.equal(
			(await s.call(`/chunks/${'a'.repeat(16)}-000001-0-1000.nsc`)).status,
			404,
		);
	});

	it('removes acknowledged chunks', async () => {
		const s = await server();
		const before = (await (await s.call('/manifest')).json()) as {
			tracks: Array<{ chunks: Array<{ file: string }> }>;
		};
		const files = before.tracks[0].chunks.map((c) => c.file);
		const response = await s.call('/ack', {
			method: 'POST',
			body: JSON.stringify({ files: [files[0]] }),
		});
		assert.deepEqual(await response.json(), { removed: 1 });
		const after = (await (await s.call('/manifest')).json()) as typeof before;
		assert.equal(after.tracks[0].chunks.length, files.length - 1);

		const bad = await s.call('/ack', {
			method: 'POST',
			body: JSON.stringify({ files: 'x' }),
		});
		assert.equal(bad.status, 400);
		const notNames = await s.call('/ack', {
			method: 'POST',
			body: JSON.stringify({ files: [1, 2] }),
		});
		assert.equal(notNames.status, 400);
		const tooMany = await s.call('/ack', {
			method: 'POST',
			body: JSON.stringify({ files: Array.from({ length: 2001 }, () => 'a') }),
		});
		assert.equal(tooMany.status, 400);
	});

	it('withdraws a person and erases on request', async () => {
		const s = await server();
		const response = await s.call('/withdraw', {
			method: 'POST',
			body: JSON.stringify({ user_id: 'marie@example.ch', erase: true }),
		});
		assert.equal(response.status, 200);
		const manifest = (await (await s.call('/manifest')).json()) as {
			tracks: Array<{ erased: boolean; chunks: unknown[] }>;
		};
		assert.equal(manifest.tracks[0].erased, true);
		assert.equal(manifest.tracks[0].chunks.length, 0);

		const bad = await s.call('/withdraw', {
			method: 'POST',
			body: JSON.stringify({}),
		});
		assert.equal(bad.status, 400);
	});

	it('erases only when asked with a real boolean', async () => {
		const s = await server();
		const response = await s.call('/withdraw', {
			method: 'POST',
			body: JSON.stringify({ user_id: 'marie@example.ch', erase: 'false' }),
		});
		assert.equal(response.status, 200);
		const manifest = (await (await s.call('/manifest')).json()) as {
			tracks: Array<{ erased: boolean; withdrawn: boolean; chunks: unknown[] }>;
		};
		assert.equal(manifest.tracks[0].withdrawn, true);
		assert.equal(manifest.tracks[0].erased, false);
		assert.ok(manifest.tracks[0].chunks.length >= 1);
	});

	it('forgets the séance on DELETE', async () => {
		const s = await server();
		const response = await s.call('', { method: 'DELETE' });
		assert.equal(response.status, 204);
		assert.equal((await s.call('/manifest')).status, 401);
		assert.equal(fs.existsSync(`${s.spool}/${s.handle}`), false);
	});

	it('slows down somebody who keeps guessing', async () => {
		const s = await server();
		let last = 0;
		for (let i = 0; i < 25; i++) {
			last = (await s.call('/manifest', {}, `guess-${i}-0123456789abcdef`))
				.status;
		}
		assert.equal(last, 429);
		// even the right key waits: the limit is on the address
		assert.equal((await s.call('/manifest')).status, 429);
	});

	it('is invisible when the feature is off', async () => {
		const spool = makeSpoolDir();
		const manager = new SeanceManager({
			config: testConfig(spool, { enabled: false }),
			secret: SECRET,
			media: new FakeMedia(),
		});
		const app = express();
		registerSeanceRoutes(app, manager);
		const http: Server = await new Promise((resolve) => {
			const s = app.listen(0, '127.0.0.1', () => resolve(s));
		});
		cleanups.push(async () => {
			await new Promise((resolve) => http.close(resolve));
			fs.rmSync(spool, { recursive: true, force: true });
		});
		const port = (http.address() as AddressInfo).port;
		const response = await fetch(
			`http://127.0.0.1:${port}/seance/${'a'.repeat(32)}/manifest`,
			{
				headers: { Authorization: 'Bearer 0123456789abcdef0123' },
			},
		);
		assert.equal(response.status, 404);
	});
});
