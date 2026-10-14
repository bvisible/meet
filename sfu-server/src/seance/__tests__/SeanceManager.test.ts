// //// Neoffice — added file (no upstream equivalent)
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readOggPages } from '../oggOpus';
import { SeanceManager, type SocketContext } from '../SeanceManager';
import { SeanceError } from '../tokens';
import {
	consentToken,
	FakeMedia,
	HOST,
	type Instance,
	MARIE,
	makeInstance,
	makeSpoolDir,
	openChunk,
	PAUL,
	RecordingNotifier,
	ROOM,
	SECRET,
	Speaker,
	socketContext,
	startToken,
	testConfig,
} from './fixtures';

interface Rig {
	media: FakeMedia;
	notifier: RecordingNotifier;
	manager: SeanceManager;
	instance: Instance;
	spool: string;
	clock: { now: number };
}

const rigs: Rig[] = [];

function rig(overrides: Parameters<typeof testConfig>[1] = {}): Rig {
	const media = new FakeMedia();
	media.room();
	const notifier = new RecordingNotifier();
	const spool = makeSpoolDir();
	const clock = { now: 1_800_000_000_000 };
	const manager = new SeanceManager({
		config: testConfig(spool, overrides),
		secret: SECRET,
		media,
		notifier,
		now: () => clock.now,
	});
	const made = {
		media,
		notifier,
		manager,
		instance: makeInstance(),
		spool,
		clock,
	};
	rigs.push(made);
	return made;
}

async function refused(
	promise: Promise<unknown> | (() => unknown),
): Promise<string> {
	try {
		await (typeof promise === 'function' ? promise() : promise);
	} catch (error) {
		assert.ok(error instanceof SeanceError, `unexpected error: ${error}`);
		return error.code;
	}
	return 'accepted';
}

async function startedRig(overrides: Parameters<typeof testConfig>[1] = {}) {
	const r = rig(overrides);
	await r.manager.start(HOST(), startToken(r.instance));
	return r;
}

function chunkFiles(spool: string): string[] {
	const found: string[] = [];
	for (const handle of fs.readdirSync(spool)) {
		const dir = path.join(spool, handle);
		if (!fs.statSync(dir).isDirectory()) continue;
		for (const file of fs.readdirSync(dir)) {
			if (/\.(nsc|ogg)$/.test(file)) found.push(path.join(dir, file));
		}
	}
	return found;
}

afterEach(() => {
	for (const r of rigs.splice(0)) {
		r.manager.shutdown();
		fs.rmSync(r.spool, { recursive: true, force: true });
	}
});

describe('starting a séance', () => {
	it('lets a host start it and tells the room', async () => {
		const r = rig();
		const view = await r.manager.start(HOST(), startToken(r.instance));

		assert.equal(view.active, true);
		assert.equal(view.seance_id, 'MTG-0001');
		assert.deepEqual(view.capturing, []);
		assert.equal(view.you, 'pending');
		const state = r.notifier.last('seance:state');
		assert.ok(state);
		assert.equal(state.active, true);
		assert.equal(
			'you' in state,
			false,
			'a broadcast carries nobody’s own state',
		);
	});

	it('lets a co-host start it', async () => {
		const r = rig();
		const cohost = socketContext('host@example.ch', { isCohost: true });
		await r.manager.start(cohost, startToken(r.instance));
	});

	it('refuses a person who is not host or co-host', async () => {
		const r = rig();
		const token = startToken(r.instance, { host_user_id: 'marie@example.ch' });
		assert.equal(await refused(r.manager.start(MARIE(), token)), 'not_host');
	});

	it('refuses a start token minted for somebody else', async () => {
		const r = rig();
		const token = startToken(r.instance, {
			host_user_id: 'other-host@example.ch',
		});
		assert.equal(await refused(r.manager.start(HOST(), token)), 'wrong_user');
	});

	it('refuses a token of another meeting or another tenant', async () => {
		const r = rig();
		assert.equal(
			await refused(
				r.manager.start(HOST(), startToken(r.instance, { meeting_id: 'zzz' })),
			),
			'wrong_room',
		);
		assert.equal(
			await refused(
				r.manager.start(
					HOST(),
					startToken(r.instance, { tenant: 'other.example' }),
				),
			),
			'wrong_room',
		);
	});

	it('refuses an end-to-end encrypted room', async () => {
		const r = rig();
		const host = { ...HOST(), e2eeRequired: true } satisfies SocketContext;
		assert.equal(
			await refused(r.manager.start(host, startToken(r.instance))),
			'e2ee_room',
		);
	});

	it('refuses a token that was already used', async () => {
		const r = rig();
		const token = startToken(r.instance);
		await r.manager.start(HOST(), token);
		assert.equal(await refused(r.manager.start(HOST(), token)), 'replayed');
	});

	it('refuses a start token signed with another secret', async () => {
		const r = rig();
		const token = startToken(
			r.instance,
			{},
			{ secret: 'not-the-fleet-secret' },
		);
		assert.equal(
			await refused(r.manager.start(HOST(), token)),
			'token_invalid',
		);
	});

	it('refuses a second séance while one is running, and the same one twice', async () => {
		const r = await startedRig();
		assert.equal(
			await refused(
				r.manager.start(
					HOST(),
					startToken(r.instance, { seance_id: 'MTG-0002' }),
				),
			),
			'already_active',
		);
		await r.manager.stop(HOST());
		assert.equal(
			await refused(r.manager.start(HOST(), startToken(r.instance))),
			'seance_exists',
		);
	});

	it('answers an idempotent start (reload of the host page) with the same séance', async () => {
		const r = await startedRig();
		const again = await r.manager.start(HOST(), startToken(r.instance));
		assert.equal(again.seance_id, 'MTG-0001');
		assert.equal(again.active, true);
	});

	it('refuses to start without an encryption key', async () => {
		const r = rig();
		const token = startToken(r.instance, { enc_key: undefined });
		assert.equal(await refused(r.manager.start(HOST(), token)), 'key_required');
		assert.equal(
			await refused(
				r.manager.start(
					HOST(),
					startToken(r.instance, { enc_key: 'not a key' }),
				),
			),
			'key_invalid',
		);
	});

	it('accepts no key only in development', async () => {
		const r = rig({ allowPlaintext: true });
		await r.manager.start(
			HOST(),
			startToken(r.instance, { enc_key: undefined }),
		);
	});
});

describe('nothing is captured before the person says yes', () => {
	it('creates no tap for a microphone nobody agreed to', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		r.media.addProducer('paul@example.ch');
		assert.equal(r.media.consumers().length, 0);
		assert.equal(chunkFiles(r.spool).length, 0);
	});

	it('taps only the person who answered yes', async () => {
		const r = await startedRig();
		const marie = r.media.addProducer('marie@example.ch');
		r.media.addProducer('paul@example.ch');

		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));

		const consumers = r.media.consumers();
		assert.equal(consumers.length, 1);
		assert.equal(consumers[0].producerId, marie.id);
		const view = r.manager.getState(PAUL());
		assert.ok('capturing' in view);
		assert.deepEqual(view.capturing, ['marie@example.ch']);
	});

	it('taps a microphone opened after the answer', async () => {
		const r = await startedRig();
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		assert.equal(r.media.consumers().length, 0);

		const producer = r.media.addProducer('marie@example.ch');
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(r.media.consumers().length, 1);
		assert.equal(r.media.consumers()[0].producerId, producer.id);
	});

	it('never taps a shared screen, nor a camera', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch', { appData: { type: 'screen' } });
		r.media.addProducer('marie@example.ch', { kind: 'video' });
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		r.media.addProducer('marie@example.ch', { appData: { type: 'screen' } });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(r.media.consumers().length, 0);
	});

	it('never taps a camera or a closed producer that appears after the answer', async () => {
		const r = await startedRig();
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		r.media.addProducer('marie@example.ch', { kind: 'video' });
		r.media.addProducer('marie@example.ch', { closed: true });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(r.media.consumers().length, 0);
	});

	it('does not put somebody else’s microphone on the track of a person who agreed', async () => {
		const r = await startedRig();
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		r.media.addProducer('paul@example.ch'); // Paul has not answered
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(r.media.consumers().length, 0);
	});

	it('a declined person is not captured, and can still change their mind', async () => {
		const r = await startedRig();
		r.media.addProducer('paul@example.ch');
		const view = r.manager.decline(PAUL());
		assert.equal(view.you, 'declined');
		assert.equal(r.media.consumers().length, 0);

		await r.manager.consent(PAUL(), consentToken('paul@example.ch'));
		assert.equal(r.media.consumers().length, 1);
	});

	it('a decline after a yes does not undo the capture: only withdrawing does', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		const view = r.manager.decline(MARIE());
		assert.equal(view.you, 'consented');
		assert.deepEqual(view.capturing, ['marie@example.ch']);
	});

	it('a consent token is only good for the person it names', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		const forMarie = consentToken('marie@example.ch');
		assert.equal(
			await refused(r.manager.consent(PAUL(), forMarie)),
			'wrong_user',
		);
		assert.equal(r.media.consumers().length, 0);
	});

	it('a consent token is only good once, for this séance, in this room', async () => {
		const r = await startedRig();
		const token = consentToken('marie@example.ch');
		await r.manager.consent(MARIE(), token);
		await r.manager.withdraw(MARIE(), false);
		assert.equal(await refused(r.manager.consent(MARIE(), token)), 'replayed');
		assert.equal(
			await refused(
				r.manager.consent(
					MARIE(),
					consentToken('marie@example.ch', { seance_id: 'MTG-9999' }),
				),
			),
			'wrong_seance',
		);
		assert.equal(
			await refused(
				r.manager.consent(
					MARIE(),
					consentToken('marie@example.ch', { meeting_id: 'zzz' }),
				),
			),
			'wrong_room',
		);
	});

	it('refuses a consent token of the wrong kind or an expired one', async () => {
		const r = await startedRig();
		assert.equal(
			await refused(
				r.manager.consent(
					MARIE(),
					consentToken(
						'marie@example.ch',
						{},
						{ type: 'neoffice-seance-start+jwt' },
					),
				),
			),
			'token_invalid',
		);
		const past = Math.floor(Date.now() / 1000) - 600;
		assert.equal(
			await refused(
				r.manager.consent(
					MARIE(),
					consentToken('marie@example.ch', { iat: past - 60, exp: past }),
				),
			),
			'token_invalid',
		);
	});

	it('refuses to answer when no séance is running', async () => {
		const r = rig();
		assert.equal(
			await refused(
				r.manager.consent(MARIE(), consentToken('marie@example.ch')),
			),
			'no_active_seance',
		);
		assert.deepEqual(r.manager.getState(MARIE()), { active: false });
	});

	it('refuses an end-to-end encrypted room even with a valid answer', async () => {
		const r = await startedRig();
		const marie = { ...MARIE(), e2eeRequired: true };
		assert.equal(
			await refused(r.manager.consent(marie, consentToken('marie@example.ch'))),
			'e2ee_room',
		);
	});

	it('is idempotent for a person already captured', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		assert.equal(r.media.consumers().length, 1);
		assert.equal(
			r.manager.manifest(
				r.manager.authorizePull(handleOf(r), r.instance.pullKey) as never,
			).tracks.length,
			1,
		);
	});
});

function handleOf(r: Rig): string {
	for (const name of fs.readdirSync(r.spool)) {
		if (/^[0-9a-f]{32}$/.test(name)) return name;
	}
	throw new Error('no séance directory');
}

describe('capturing and handing over', () => {
	it('keeps what a person said, sealed, and the instance can read it', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		const marie = new Speaker(r.media.consumers()[0], r.clock);

		marie.talk(150); // 3 s
		await r.manager.stop(HOST());

		const seance = r.manager.authorizePull(handleOf(r), r.instance.pullKey);
		assert.ok(seance);
		const manifest = r.manager.manifest(seance);
		assert.equal(manifest.state, 'ended');
		assert.equal(manifest.chunk_format, 'nsc1');
		assert.equal(manifest.tracks.length, 1);

		const track = manifest.tracks[0];
		assert.equal(track.user_id, 'marie@example.ch');
		assert.equal(track.name, 'marie');
		assert.equal(track.ended, true);
		assert.equal(track.end_reason, 'stopped');
		assert.equal(track.consent_at, '2026-10-14T10:00:00Z');
		assert.ok(track.chunks.length >= 3, `chunks: ${track.chunks.length}`);
		assert.ok(track.chunks[track.chunks.length - 1].final);
		assert.ok(Math.abs(track.duration_ms - 3000) <= 40);
		assert.deepEqual(track.activity, [[0, 3000]]);

		// the SFU wrote nothing readable: the instance opens each chunk
		const streams: Buffer[] = [];
		for (const chunk of track.chunks) {
			const sealed = fs.readFileSync(
				r.manager.chunkPath(seance, chunk.file) as string,
			);
			assert.ok(
				!sealed.includes(Buffer.from('OggS')),
				'no Ogg capture pattern in clear',
			);
			streams.push(
				openChunk(
					sealed,
					r.instance,
					`MTG-0001/${track.track_id}/${chunk.index}`,
				),
			);
		}
		const pages = readOggPages(Buffer.concat(streams));
		assert.ok(pages.every((p) => p.checksumOk));
		const audio = pages.slice(2).flatMap((p) => p.packets);
		assert.equal(audio.length, 150);
	});

	it('records each person on a track of their own, with the offset of their yes', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		r.media.addProducer('paul@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		const marie = new Speaker(r.media.consumers()[0], r.clock);
		marie.talk(100); // 2 s on the clock

		await r.manager.consent(PAUL(), consentToken('paul@example.ch'));
		const paul = new Speaker(r.media.consumers()[1], r.clock);
		paul.talk(50); // 1 s

		await r.manager.stop(HOST());
		const seance = r.manager.authorizePull(handleOf(r), r.instance.pullKey);
		assert.ok(seance);
		const tracks = r.manager.manifest(seance).tracks;
		const byUser = Object.fromEntries(tracks.map((t) => [t.user_id, t]));
		assert.equal(byUser['marie@example.ch'].start_offset_ms, 0);
		assert.equal(byUser['paul@example.ch'].start_offset_ms, 2000);
		assert.ok(Math.abs(byUser['marie@example.ch'].duration_ms - 3000) <= 40);
		assert.ok(Math.abs(byUser['paul@example.ch'].duration_ms - 1000) <= 40);
	});

	it('does not keep what Paul said when only Marie agreed', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		r.media.addProducer('paul@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		await r.manager.stop(HOST());

		const seance = r.manager.authorizePull(handleOf(r), r.instance.pullKey);
		assert.ok(seance);
		const names = r.manager.manifest(seance).tracks.map((t) => t.user_id);
		assert.deepEqual(names, ['marie@example.ch']);
		assert.equal(r.media.consumers().length, 1);
	});

	it('survives a hole in the audio: the position stays the time', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		const consumer = r.media.consumers()[0];
		const marie = new Speaker(consumer, r.clock);
		marie.talk(50); // 1 s
		consumer.emit('producerpause'); // the microphone is muted
		r.clock.now += 4000; // four silent seconds
		marie.talk(50); // 1 s
		await r.manager.stop(HOST());

		const seance = r.manager.authorizePull(handleOf(r), r.instance.pullKey);
		assert.ok(seance);
		const track = r.manager.manifest(seance).tracks[0];
		assert.ok(Math.abs(track.duration_ms - 6000) <= 60, `${track.duration_ms}`);
		assert.deepEqual(track.activity, [
			[0, 1000],
			[5000, 6000],
		]);
	});

	it('closes the tap when the microphone is closed, and picks the next one up', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		const first = r.media.consumers()[0];
		first.emit('producerclose');
		assert.equal(r.media.routers.get(ROOM)?.transports[0].closed, true);

		r.media.addProducer('marie@example.ch');
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(r.media.consumers().length, 2);
	});

	it('does not let a stale event close the tap that replaced it', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		const first = r.media.consumers()[0];
		first.emit('producerclose'); // the first microphone goes away

		r.media.addProducer('marie@example.ch');
		await new Promise((resolve) => setImmediate(resolve));
		const second = r.media.routers.get(ROOM)?.transports[1];
		assert.ok(second);

		first.emit('transportclose'); // a late event of the FIRST tap
		assert.equal(second.closed, false, 'the second tap is still open');
		new Speaker(r.media.consumers()[1], r.clock).talk(10);
		// and the track still knows its tap: withdrawing closes it
		r.manager.withdraw(MARIE(), false);
		assert.equal(second.closed, true, 'nothing is left listening');
		const seance = r.manager.authorizePull(handleOf(r), r.instance.pullKey);
		assert.ok(seance);
		assert.ok(r.manager.manifest(seance).tracks[0].duration_ms >= 200);
	});

	it('closes a tap that was still being created when the person withdrew', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		const release = r.media.room().holdNextTransport();
		const consenting = r.manager.consent(
			MARIE(),
			consentToken('marie@example.ch'),
		);
		await new Promise((resolve) => setImmediate(resolve));
		r.manager.withdraw(MARIE(), false); // while mediasoup is still working
		release();
		await consenting;

		const transport = r.media.routers.get(ROOM)?.transports[0];
		assert.ok(transport);
		assert.equal(transport.closed, true, 'nothing keeps listening');
	});

	it('survives a worker that cannot create the tap', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		r.media.room().failNextTransport = true;
		const view = await r.manager.consent(
			MARIE(),
			consentToken('marie@example.ch'),
		);
		assert.deepEqual(view.capturing, ['marie@example.ch']);
		assert.equal(r.media.consumers().length, 0);
	});

	it('ends a track whose packets keep failing, without touching the call', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		const consumer = r.media.consumers()[0];
		for (let i = 0; i < 60; i++) consumer.emit('rtp', null);
		const view = r.manager.getState(PAUL());
		assert.ok('capturing' in view);
		assert.deepEqual(view.capturing, []);
	});
});

describe('withdrawing, leaving, ending', () => {
	it('stops capturing at once when the person withdraws', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		const marie = new Speaker(r.media.consumers()[0], r.clock);
		marie.talk(50);

		const view = r.manager.withdraw(MARIE(), false);
		assert.equal(view.you, 'withdrawn');
		assert.deepEqual(view.capturing, []);
		assert.equal(r.media.routers.get(ROOM)?.transports[0].closed, true);

		marie.talk(50); // still talking: nobody is listening
		const seance = r.manager.authorizePull(handleOf(r), r.instance.pullKey);
		assert.ok(seance);
		const track = r.manager.manifest(seance).tracks[0];
		assert.equal(track.withdrawn, true);
		assert.equal(track.end_reason, 'withdrawn');
		assert.ok(track.duration_ms <= 1040, `kept ${track.duration_ms} ms`);
		assert.ok(Array.isArray(r.notifier.last('seance:state')?.capturing));
	});

	it('erases what was already captured when the person asks', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		r.media.addProducer('paul@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		await r.manager.consent(PAUL(), consentToken('paul@example.ch'));
		new Speaker(r.media.consumers()[0], r.clock).talk(150);
		new Speaker(r.media.consumers()[1], r.clock).talk(150);
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(chunkFiles(r.spool).length >= 4);

		r.manager.withdraw(MARIE(), true);

		const seance = r.manager.authorizePull(handleOf(r), r.instance.pullKey);
		assert.ok(seance);
		const manifest = r.manager.manifest(seance);
		const marie = manifest.tracks.find((t) => t.user_id === 'marie@example.ch');
		const paul = manifest.tracks.find((t) => t.user_id === 'paul@example.ch');
		assert.ok(marie);
		assert.equal(marie.erased, true);
		assert.equal(marie.chunks.length, 0);
		assert.deepEqual(marie.activity, []);
		assert.equal(marie.name, '', 'the tombstone does not keep the name');
		assert.equal(marie.stats, null);
		assert.ok(paul);
		assert.ok(paul.chunks.length >= 1, 'the others are untouched');
		for (const file of chunkFiles(r.spool)) {
			assert.ok(
				!path.basename(file).startsWith(marie.track_id),
				'no file of the erased track',
			);
		}
	});

	it('does not write a late chunk of an erased track', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		new Speaker(r.media.consumers()[0], r.clock).talk(40);
		r.manager.withdraw(MARIE(), true);
		r.manager.stop(HOST());
		assert.equal(chunkFiles(r.spool).length, 0);
	});

	it('lets a person come back with a new yes: a new track', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		r.manager.withdraw(MARIE(), false);
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));

		const seance = r.manager.authorizePull(handleOf(r), r.instance.pullKey);
		assert.ok(seance);
		const tracks = r.manager.manifest(seance).tracks;
		assert.equal(tracks.length, 2);
		assert.notEqual(tracks[0].track_id, tracks[1].track_id);
		assert.equal(tracks[0].ended, true);
		assert.equal(tracks[1].ended, false);
	});

	it('finishes the track of a person who leaves, and asks them again if they return', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		new Speaker(r.media.consumers()[0], r.clock).talk(50);

		r.media.removePeer('marie@example.ch');

		const seance = r.manager.authorizePull(handleOf(r), r.instance.pullKey);
		assert.ok(seance);
		assert.equal(r.manager.manifest(seance).tracks[0].end_reason, 'left');
		const view = r.manager.getState(MARIE());
		assert.ok('you' in view);
		assert.equal(view.you, 'pending');
	});

	it('ends the séance when the room closes', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		new Speaker(r.media.consumers()[0], r.clock).talk(50);

		r.media.closeRoom();

		const ended = r.notifier.last('seance:ended');
		assert.ok(ended);
		assert.equal(ended.reason, 'room_closed');
		assert.deepEqual(r.manager.getState(HOST()), { active: false });
		assert.ok(chunkFiles(r.spool).length >= 1, 'what was captured is kept');
	});

	it('lets only a host, a co-host or its starter end it', async () => {
		const r = await startedRig();
		assert.equal(await refused(() => r.manager.stop(MARIE())), 'not_host');
		const starter = socketContext('host@example.ch'); // not host any more, but started it
		r.manager.stop(starter);
		assert.deepEqual(r.manager.getState(HOST()), { active: false });
	});

	it('ends by itself after the maximum duration', async () => {
		const r = await startedRig({ maxSeanceSeconds: 60 });
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		r.clock.now += 61_000;
		// the manager ticks every second; drive it by hand through a fresh tick
		(r.manager as unknown as { tick(): void }).tick();
		assert.equal(r.notifier.last('seance:ended')?.reason, 'max_duration');
	});

	it('limits the number of people captured at the same time', async () => {
		const r = await startedRig({ maxTracksPerSeance: 1 });
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		assert.equal(
			await refused(r.manager.consent(PAUL(), consentToken('paul@example.ch'))),
			'capacity',
		);
	});

	it('refuses a new person when the spool is full', async () => {
		const r = await startedRig({ maxSpoolBytes: 4000 });
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		new Speaker(r.media.consumers()[0], r.clock).talk(100); // sealed chunks > 4000 bytes
		// the séance is ended by the next turn of the event loop: ask before it
		assert.equal(
			await refused(r.manager.consent(PAUL(), consentToken('paul@example.ch'))),
			'capacity',
		);
	});

	it('refuses to start a séance when the spool is full', async () => {
		const r = await startedRig({ maxSpoolBytes: 4000 });
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		new Speaker(r.media.consumers()[0], r.clock).talk(100);
		await r.manager.stop(HOST());
		assert.equal(
			await refused(
				r.manager.start(
					HOST(),
					startToken(r.instance, { seance_id: 'MTG-0002' }),
				),
			),
			'capacity',
		);
	});

	it('stops by itself when the disk budget of a séance is spent', async () => {
		const r = await startedRig({ maxSeanceBytes: 1 });
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		new Speaker(r.media.consumers()[0], r.clock).talk(100);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(r.notifier.last('seance:ended')?.reason, 'capacity');
	});
});

describe('the instance picks it up', () => {
	async function captured() {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		new Speaker(r.media.consumers()[0], r.clock).talk(100);
		await r.manager.stop(HOST());
		const handle = handleOf(r);
		return { r, handle };
	}

	it('answers only to the right pull key', async () => {
		const { r, handle } = await captured();
		assert.ok(r.manager.authorizePull(handle, r.instance.pullKey));
		assert.equal(
			r.manager.authorizePull(handle, 'a-wrong-key-0123456789'),
			null,
		);
		assert.equal(r.manager.authorizePull(handle, ''), null);
		assert.equal(
			r.manager.authorizePull('0'.repeat(32), r.instance.pullKey),
			null,
		);
		assert.equal(r.manager.authorizePull('../etc', r.instance.pullKey), null);
	});

	it('stores only the hash of the pull key', async () => {
		const { r, handle } = await captured();
		const sidecar = fs.readFileSync(
			path.join(r.spool, handle, 'seance.json'),
			'utf8',
		);
		assert.ok(sidecar.includes(r.instance.pullKeyHash));
		assert.ok(!sidecar.includes(r.instance.pullKey));
	});

	it('does not write the audio in clear, nor the names, in the chunk files', async () => {
		const { r, handle } = await captured();
		for (const file of fs.readdirSync(path.join(r.spool, handle))) {
			if (!file.endsWith('.nsc')) continue;
			const bytes = fs.readFileSync(path.join(r.spool, handle, file));
			assert.ok(!bytes.includes(Buffer.from('OpusHead')));
			assert.ok(!bytes.includes(Buffer.from('marie')));
		}
	});

	it('removes chunks that the instance acknowledged, and only those', async () => {
		const { r, handle } = await captured();
		const seance = r.manager.authorizePull(handle, r.instance.pullKey);
		assert.ok(seance);
		const files = r.manager
			.manifest(seance)
			.tracks[0].chunks.map((c) => c.file);
		assert.ok(files.length >= 2);

		const duration = r.manager.manifest(seance).tracks[0].duration_ms;
		const removed = r.manager.acknowledge(seance, [
			files[0],
			'../seance.json',
			'nonsense',
		]);
		assert.equal(removed, 1);
		const left = r.manager.manifest(seance).tracks[0].chunks.map((c) => c.file);
		assert.deepEqual(left, files.slice(1));
		assert.equal(
			r.manager.manifest(seance).tracks[0].duration_ms,
			duration,
			'the length of the track does not shrink with the chunks picked up',
		);
		assert.ok(fs.existsSync(path.join(r.spool, handle, 'seance.json')));
	});

	it('never removes a file that is not a chunk of the séance', async () => {
		const { r, handle } = await captured();
		const seance = r.manager.authorizePull(handle, r.instance.pullKey);
		assert.ok(seance);
		const decoy = path.join(r.spool, 'decoy.txt');
		fs.writeFileSync(decoy, 'keep me');
		const removed = r.manager.acknowledge(seance, [
			'../decoy.txt',
			'seance.json',
			`${'a'.repeat(16)}.json`,
		]);
		assert.equal(removed, 0);
		assert.ok(fs.existsSync(decoy));
		assert.ok(fs.existsSync(path.join(r.spool, handle, 'seance.json')));
	});

	it('refuses to serve a path that is not a chunk', async () => {
		const { r, handle } = await captured();
		const seance = r.manager.authorizePull(handle, r.instance.pullKey);
		assert.ok(seance);
		assert.equal(r.manager.chunkPath(seance, 'seance.json'), null);
		assert.equal(r.manager.chunkPath(seance, '../../etc/passwd'), null);
		assert.equal(
			r.manager.chunkPath(seance, `${'a'.repeat(16)}-000001-0-1000.nsc`),
			null,
		);
	});

	it('forgets everything on request', async () => {
		const { r, handle } = await captured();
		const seance = r.manager.authorizePull(handle, r.instance.pullKey);
		assert.ok(seance);
		r.manager.purge(seance);
		assert.equal(fs.existsSync(path.join(r.spool, handle)), false);
		assert.equal(r.manager.authorizePull(handle, r.instance.pullKey), null);
	});

	it('lets the instance end a séance whose host is gone, and withdraw a person', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		new Speaker(r.media.consumers()[0], r.clock).talk(100);
		const seance = r.manager.authorizePull(handleOf(r), r.instance.pullKey);
		assert.ok(seance);

		r.manager.withdrawByPull(seance, 'marie@example.ch', true);
		assert.equal(r.manager.manifest(seance).tracks[0].erased, true);

		r.manager.stopByPull(seance);
		assert.equal(r.manager.manifest(seance).state, 'ended');
		assert.equal(r.manager.manifest(seance).end_reason, 'stopped_by_instance');
	});

	it('removes what stayed too long', async () => {
		const { r, handle } = await captured();
		r.clock.now += 25 * 3600 * 1000;
		(r.manager as unknown as { purgeExpired(): void }).purgeExpired();
		assert.equal(fs.existsSync(path.join(r.spool, handle)), false);
	});
});

describe('after a restart of the SFU', () => {
	it('can still be picked up, and says it was cut short', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		new Speaker(r.media.consumers()[0], r.clock).talk(100);
		const handle = handleOf(r);
		// no stop, no shutdown: the process is gone. A new one starts on the same spool.
		const reborn = new SeanceManager({
			config: testConfig(r.spool),
			secret: SECRET,
			media: new FakeMedia(),
			now: () => r.clock.now,
		});
		try {
			const seance = reborn.authorizePull(handle, r.instance.pullKey);
			assert.ok(seance);
			const manifest = reborn.manifest(seance);
			assert.equal(manifest.state, 'ended');
			assert.equal(manifest.end_reason, 'server_restart');
			assert.equal(manifest.tracks.length, 1);
			assert.equal(manifest.tracks[0].user_id, 'marie@example.ch');
			assert.equal(manifest.tracks[0].end_reason, 'server_restart');
			assert.ok(manifest.tracks[0].chunks.length >= 1);
			assert.equal(manifest.chunk_format, 'nsc1');
			// the audio that was in the last, unfinished chunk is gone; what was written is readable
			const first = manifest.tracks[0].chunks[0];
			const sealed = fs.readFileSync(
				reborn.chunkPath(seance, first.file) as string,
			);
			const opened = openChunk(
				sealed,
				r.instance,
				`MTG-0001/${manifest.tracks[0].track_id}/${first.index}`,
			);
			assert.equal(opened.toString('ascii', 0, 4), 'OggS');
		} finally {
			reborn.shutdown();
		}
	});

	it('goes on with the same séance when the host starts it again', async () => {
		const r = await startedRig();
		r.media.addProducer('marie@example.ch');
		await r.manager.consent(MARIE(), consentToken('marie@example.ch'));
		new Speaker(r.media.consumers()[0], r.clock).talk(100);
		const handle = handleOf(r);

		const media = new FakeMedia();
		media.room();
		const reborn = new SeanceManager({
			config: testConfig(r.spool),
			secret: SECRET,
			media,
			notifier: new RecordingNotifier(),
			now: () => r.clock.now,
		});
		try {
			// a different key pair is not accepted: only the instance that owns the séance
			assert.equal(
				await refused(
					reborn.start(
						HOST(),
						startToken({ ...r.instance, pullKeyHash: 'f'.repeat(64) }),
					),
				),
				'seance_exists',
			);

			const view = await reborn.start(HOST(), startToken(r.instance));
			assert.equal(view.active, true);
			media.addProducer('marie@example.ch');
			await reborn.consent(MARIE(), consentToken('marie@example.ch'));
			new Speaker(media.consumers()[0], r.clock).talk(60);
			await reborn.stop(HOST());

			const seance = reborn.authorizePull(handle, r.instance.pullKey);
			assert.ok(seance);
			const manifest = reborn.manifest(seance);
			assert.equal(manifest.state, 'ended');
			assert.equal(manifest.tracks.length, 2, 'the first part and the second');
			for (const track of manifest.tracks) {
				for (const chunk of track.chunks) {
					const sealed = fs.readFileSync(
						reborn.chunkPath(seance, chunk.file) as string,
					);
					openChunk(
						sealed,
						r.instance,
						`MTG-0001/${track.track_id}/${chunk.index}`,
					);
				}
			}
		} finally {
			reborn.shutdown();
		}
	});

	it('ignores a séance directory that nobody can read', () => {
		const spool = makeSpoolDir();
		fs.mkdirSync(path.join(spool, 'f'.repeat(32)));
		fs.writeFileSync(
			path.join(spool, 'f'.repeat(32), 'seance.json'),
			'{not json',
		);
		const manager = new SeanceManager({
			config: testConfig(spool),
			secret: SECRET,
			media: new FakeMedia(),
		});
		try {
			assert.equal(
				manager.authorizePull('f'.repeat(32), 'whatever-0123456789'),
				null,
			);
		} finally {
			manager.shutdown();
			fs.rmSync(spool, { recursive: true, force: true });
		}
	});
});

describe('the switch', () => {
	it('is off with SEANCE_TAP=0: no spool, every call refused', async () => {
		const spool = path.join(makeSpoolDir(), 'never-created');
		const media = new FakeMedia();
		const manager = new SeanceManager({
			config: testConfig(spool, { enabled: false }),
			secret: SECRET,
			media,
		});
		try {
			assert.equal(manager.enabled, false);
			assert.equal(fs.existsSync(spool), false);
			const instance = makeInstance();
			assert.equal(
				await refused(manager.start(HOST(), startToken(instance))),
				'seance_unavailable',
			);
			assert.equal(
				await refused(
					manager.consent(MARIE(), consentToken('marie@example.ch')),
				),
				'seance_unavailable',
			);
			assert.equal(manager.authorizePull('a'.repeat(32), 'x'.repeat(20)), null);
		} finally {
			manager.shutdown();
		}
	});

	it('is off, and says so, when the spool cannot be written', () => {
		const blocker = path.join(makeSpoolDir(), 'a-file');
		fs.writeFileSync(blocker, 'x');
		const manager = new SeanceManager({
			config: testConfig(path.join(blocker, 'spool')),
			secret: SECRET,
			media: new FakeMedia(),
		});
		try {
			assert.equal(manager.enabled, false);
		} finally {
			manager.shutdown();
		}
	});
});
