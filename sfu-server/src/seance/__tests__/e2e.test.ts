// //// Neoffice — added file (no upstream equivalent)
// The whole path, for real: socket.io clients, the SFU's own handlers, a real
// mediasoup worker, RTP over UDP into PlainTransports, real Opus, the HTTP
// pick-up, and ffmpeg to listen to the result.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import dgram from 'node:dgram';
import fs from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import cors from 'cors';
import express from 'express';
import * as jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { readOggPages } from '../oggOpus';
import { seanceHandle } from '../spool';
import {
	consentToken,
	type Instance,
	makeInstance,
	makeSpoolDir,
	openChunk,
	SECRET,
	startToken,
	testConfig,
} from './fixtures';
import {
	decodePcm,
	ffmpegAvailable,
	realOpusPackets,
	rms,
	rtpPacket,
	toneFrequency,
} from './helpers';

const TENANT = 'e2e.example';
const MEETING = 'e2e-room-0001';

interface Stack {
	http: HttpServer;
	io: Server;
	port: number;
	spool: string;
	stop(): Promise<void>;
}

let stack: Stack;
const clients: Socket[] = [];
const udp: dgram.Socket[] = [];

function ack<T = Record<string, unknown>>(
	socket: Socket,
	event: string,
	data?: unknown,
): Promise<T & { success: boolean; error?: string }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`no answer to ${event}`)),
			8000,
		);
		socket.emit(event, data, (response: never) => {
			clearTimeout(timer);
			resolve(response);
		});
	});
}

function connectionToken(
	userId: string,
	name: string,
	extra: Record<string, unknown> = {},
) {
	const now = Math.floor(Date.now() / 1000);
	return jwt.sign(
		{
			user_id: userId,
			user_name: name,
			meeting_id: MEETING,
			tenant: TENANT,
			scope: 'full',
			is_host: false,
			iat: now,
			exp: now + 3600,
			...extra,
		},
		SECRET,
		{ algorithm: 'HS256' },
	);
}

interface Person {
	socket: Socket;
	userId: string;
	states: Array<Record<string, unknown>>;
	ended: Array<Record<string, unknown>>;
	send(packets: Buffer[], options?: { voice?: boolean }): Promise<void>;
	producerId: string;
	/** Opens the microphone (done at once by join, unless told otherwise). */
	openMicrophone(): Promise<void>;
}

async function join(
	userId: string,
	name: string,
	extra: Record<string, unknown> = {},
	options: { microphone?: boolean } = {},
): Promise<Person> {
	const socket = connect(`http://127.0.0.1:${stack.port}`, {
		auth: { token: connectionToken(userId, name, extra) },
		transports: ['websocket'],
		reconnection: false,
	});
	clients.push(socket);
	await new Promise<void>((resolve, reject) => {
		socket.once('connect', () => resolve());
		socket.once('connect_error', reject);
	});
	const states: Array<Record<string, unknown>> = [];
	const ended: Array<Record<string, unknown>> = [];
	socket.on('seance:state', (payload) => states.push(payload));
	socket.on('seance:ended', (payload) => ended.push(payload));

	const joined = await ack(socket, 'join_room', {
		roomId: MEETING,
		userData: { name, userId, is_guest: false },
		mediaState: { audio_enabled: true, video_enabled: false },
	});
	assert.equal(joined.success, true, `join_room: ${joined.error}`);

	const sender = dgram.createSocket('udp4');
	udp.push(sender);
	let sequence = 1;
	let timestamp = 1000;
	let port = 0;
	let ssrc = 0;

	const person: Person = {
		socket,
		userId,
		states,
		ended,
		producerId: '',
		async openMicrophone() {
			const transport = await ack<{ id: string; ip: string; port: number }>(
				socket,
				'create_plain_transport',
				{},
			);
			assert.equal(
				transport.success,
				true,
				`plain transport: ${transport.error}`,
			);
			ssrc = 1000 + Math.floor(Math.random() * 1_000_000);
			const producer = await ack<{ id: string }>(socket, 'create_producer', {
				transportId: transport.id,
				kind: 'audio',
				rtpParameters: {
					codecs: [
						{
							mimeType: 'audio/opus',
							payloadType: 111,
							clockRate: 48000,
							channels: 2,
							parameters: { useinbandfec: 1 },
						},
					],
					encodings: [{ ssrc }],
					headerExtensions: [
						{ uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level', id: 1 },
					],
				},
				appData: {},
			});
			assert.equal(producer.success, true, `producer: ${producer.error}`);
			person.producerId = producer.id;
			port = transport.port;
		},
		async send(packets: Buffer[], options: { voice?: boolean } = {}) {
			assert.ok(port, 'the microphone is not open');
			const started = Date.now();
			for (let i = 0; i < packets.length; i++) {
				const wait = started + i * 20 - Date.now();
				if (wait > 0) await new Promise((r) => setTimeout(r, wait));
				const packet = rtpPacket({
					sequence: sequence++,
					timestamp,
					payload: packets[i],
					ssrc,
					level: {
						value: options.voice === false ? 127 : 25,
						voice: options.voice !== false,
						id: 1,
					},
				});
				timestamp += 960;
				await new Promise<void>((resolve) =>
					sender.send(packet, port, '127.0.0.1', () => resolve()),
				);
			}
		},
	};
	if (options.microphone !== false) await person.openMicrophone();
	return person;
}

interface ManifestTrack {
	track_id: string;
	user_id: string;
	name: string;
	duration_ms: number;
	erased: boolean;
	end_reason: string | null;
	withdrawn: boolean;
	activity: Array<[number, number]>;
	chunks: Array<{ index: number; file: string; sha256: string }>;
}
interface Manifest {
	state: string;
	end_reason: string | null;
	tracks: ManifestTrack[];
}

const get = (handle: string, instance: Instance, p: string) =>
	fetch(`http://127.0.0.1:${stack.port}/seance/${handle}${p}`, {
		headers: { Authorization: `Bearer ${instance.pullKey}` },
	});

async function manifestOf(
	seanceId: string,
	instance: Instance,
): Promise<Manifest> {
	const response = await get(
		seanceHandle(TENANT, seanceId),
		instance,
		'/manifest',
	);
	assert.equal(response.status, 200);
	return (await response.json()) as Manifest;
}

async function listen(
	seanceId: string,
	instance: Instance,
	track: ManifestTrack,
): Promise<Int16Array> {
	const streams: Buffer[] = [];
	for (const chunk of track.chunks) {
		const response = await get(
			seanceHandle(TENANT, seanceId),
			instance,
			`/chunks/${chunk.file}`,
		);
		assert.equal(response.status, 200);
		const sealed = Buffer.from(await response.arrayBuffer());
		streams.push(
			openChunk(
				sealed,
				instance,
				`${seanceId}/${track.track_id}/${chunk.index}`,
			),
		);
	}
	const ogg = Buffer.concat(streams);
	assert.ok(readOggPages(ogg).every((p) => p.checksumOk));
	return decodePcm(ogg);
}

function start(host: Person, instance: Instance, seanceId: string) {
	return ack<{ active: boolean }>(host.socket, 'seance:start', {
		token: startToken(instance, {
			tenant: TENANT,
			meeting_id: MEETING,
			seance_id: seanceId,
			host_user_id: host.userId,
		}),
	});
}

function consent(person: Person, seanceId: string) {
	return ack<{ you: string; capturing: string[] }>(
		person.socket,
		'seance:consent',
		{
			token: consentToken(person.userId, {
				tenant: TENANT,
				meeting_id: MEETING,
				seance_id: seanceId,
			}),
		},
	);
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('séance note-taking, end to end', {
	skip: !ffmpegAvailable() && 'ffmpeg is not installed',
}, () => {
	let host: Person;
	let marie: Person;
	let paul: Person;

	before(async () => {
		process.env.NODE_ENV = 'development'; // PlainTransport, no rate limits
		process.env.JWT_SECRET = SECRET;
		process.env.WEBRTC_LISTEN_IP = '127.0.0.1';
		process.env.WEBRTC_ANNOUNCED_IP = '127.0.0.1';
		process.env.MEDIASOUP_NUM_WORKERS = '1';
		process.env.RTC_MIN_PORT = '41000';
		process.env.RTC_MAX_PORT = '41999';
		process.env.SFU_LOG_LEVEL = 'error';

		// loaded only now: the mediasoup configuration reads the environment at import
		const { MediasoupManager } = await import(
			'../../mediasoup/MediasoupManager'
		);
		const { AuthManager } = await import('../../server/AuthManager');
		const { RouteManager } = await import('../../server/RouteManager');
		const { SocketHandlerManager } = await import(
			'../../server/SocketHandlerManager'
		);
		const { SeanceManager } = await import('../SeanceManager');
		const { mediaFacadeOf } = await import('../mediaAdapter');

		const spool = makeSpoolDir();
		const app = express();
		app.use(cors());
		app.use(express.json());
		const http = createServer(app);
		const io = new Server(http, { transports: ['websocket'] });

		const mediasoup = new MediasoupManager();
		await mediasoup.init();
		const seance = new SeanceManager({
			config: testConfig(spool, { chunkSeconds: 1 }),
			secret: SECRET,
			media: mediaFacadeOf(mediasoup),
		});
		new RouteManager(app, mediasoup, seance).setupRoutes();
		new SocketHandlerManager(
			io,
			mediasoup,
			new AuthManager(SECRET),
			seance,
		).setupSocketHandlers();
		await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));

		stack = {
			http,
			io,
			port: (http.address() as AddressInfo).port,
			spool,
			async stop() {
				seance.shutdown();
				await mediasoup.cleanup();
				await io.close();
				fs.rmSync(spool, { recursive: true, force: true });
			},
		};

		host = await join('host@e2e.example', 'Hélène Host', { is_host: true });
		marie = await join('marie@e2e.example', 'Marie Dupont');
		paul = await join('paul@e2e.example', 'Paul Martin');
	});

	after(async () => {
		for (const client of clients) client.disconnect();
		for (const socket of udp) socket.close();
		await stack?.stop();
	});

	it('says what it can do', async () => {
		const health = (await (
			await fetch(`http://127.0.0.1:${stack.port}/health`)
		).json()) as {
			status: string;
			features?: { seance: boolean };
		};
		assert.equal(health.status, 'healthy');
		assert.deepEqual(health.features, { seance: true });
	});

	it('captures only the person who said yes, and gives it to the instance sealed', async () => {
		const instance = makeInstance();
		const id = 'MTG-A';

		// somebody who is not a host cannot start
		const refusedStart = await ack(marie.socket, 'seance:start', {
			token: startToken(instance, {
				tenant: TENANT,
				meeting_id: MEETING,
				seance_id: id,
				host_user_id: marie.userId,
			}),
		});
		assert.deepEqual(
			[refusedStart.success, refusedStart.error],
			[false, 'not_host'],
		);

		const started = await start(host, instance, id);
		assert.equal(started.success, true, `start: ${started.error}`);
		assert.equal(started.active, true);

		await tick(100);
		assert.ok(
			marie.states.length >= 1 && paul.states.length >= 1,
			'the room is told',
		);

		// Marie says yes, Paul does not answer
		const yes = await consent(marie, id);
		assert.equal(yes.success, true, `consent: ${yes.error}`);
		assert.equal(yes.you, 'consented');

		// nobody can answer for somebody else
		const stolen = await ack(paul.socket, 'seance:consent', {
			token: consentToken(marie.userId, {
				tenant: TENANT,
				meeting_id: MEETING,
				seance_id: id,
			}),
		});
		assert.deepEqual([stolen.success, stolen.error], [false, 'wrong_user']);

		// both talk for three seconds: a 330 Hz tone and an 880 Hz tone
		await Promise.all([
			marie.send(realOpusPackets(3, 330)),
			paul.send(realOpusPackets(3, 880)),
		]);

		assert.equal((await ack(host.socket, 'seance:stop', {})).success, true);
		await tick(100);
		assert.ok(paul.ended.length >= 1, 'the room is told it ended');

		const manifest = await manifestOf(id, instance);
		assert.equal(manifest.state, 'ended');
		assert.deepEqual(
			manifest.tracks.map((t) => t.user_id),
			[marie.userId],
			'Paul never said yes: nothing of him was kept',
		);
		const track = manifest.tracks[0];
		assert.equal(track.name, 'Marie Dupont');
		assert.ok(
			Math.abs(track.duration_ms - 3000) < 400,
			`track lasts ${track.duration_ms} ms`,
		);
		assert.ok(track.activity.length >= 1, 'speech was detected');

		const pcm = await listen(id, instance, track);
		assert.ok(
			Math.abs(pcm.length / 48000 - 3) < 0.4,
			`${pcm.length / 48000} s`,
		);
		const middle = Math.floor(pcm.length / 2);
		assert.ok(
			rms(pcm, middle - 24000, middle + 24000) > 0.03,
			'Marie is audible',
		);
		const hz = toneFrequency(pcm, middle - 24000, middle + 24000);
		assert.ok(
			Math.abs(hz - 330) < 30,
			`heard ${hz} Hz, Marie speaks at 330 Hz`,
		);
	});

	it('stops capturing the moment a person withdraws, and erases on request', async () => {
		const instance = makeInstance();
		const id = 'MTG-B';
		assert.equal((await start(host, instance, id)).success, true);
		assert.equal((await consent(marie, id)).success, true);
		assert.equal((await consent(paul, id)).success, true);

		const marieTalks = marie.send(realOpusPackets(2, 330));
		const paulTalks = paul.send(realOpusPackets(3, 880));
		await marieTalks;
		const withdrawn = await ack<{ you: string }>(
			marie.socket,
			'seance:withdraw',
			{
				erase: true,
			},
		);
		assert.equal(withdrawn.success, true);
		assert.equal(withdrawn.you, 'withdrawn');
		await paulTalks;
		await ack(host.socket, 'seance:stop', {});
		await tick(100);

		const manifest = await manifestOf(id, instance);
		const forMarie = manifest.tracks.find((t) => t.user_id === marie.userId);
		const forPaul = manifest.tracks.find((t) => t.user_id === paul.userId);
		assert.ok(forMarie && forPaul);
		assert.equal(forMarie.erased, true);
		assert.equal(forMarie.chunks.length, 0);
		assert.deepEqual(forMarie.activity, []);
		assert.equal(forMarie.withdrawn, true);
		// nothing of her audio, nothing of her name: only a tombstone
		const dir = path.join(stack.spool, seanceHandle(TENANT, id));
		const left = fs
			.readdirSync(dir)
			.filter((f) => f.startsWith(forMarie.track_id));
		assert.deepEqual(left, [`${forMarie.track_id}.json`]);
		const tombstone = JSON.parse(
			fs.readFileSync(path.join(dir, `${forMarie.track_id}.json`), 'utf8'),
		);
		assert.equal(tombstone.erased, true);
		assert.equal(tombstone.name, '');
		assert.deepEqual(tombstone.activity, []);

		assert.ok(
			Math.abs(forPaul.duration_ms - 3000) < 400,
			`${forPaul.duration_ms}`,
		);
		const pcm = await listen(id, instance, forPaul);
		const middle = Math.floor(pcm.length / 2);
		const hz = toneFrequency(pcm, middle - 24000, middle + 24000);
		assert.ok(Math.abs(hz - 880) < 60, `heard ${hz} Hz, Paul speaks at 880 Hz`);
	});

	it('keeps the timeline when a microphone is muted, and finishes the track of whoever leaves', async () => {
		const instance = makeInstance();
		const id = 'MTG-C';
		assert.equal((await start(host, instance, id)).success, true);
		assert.equal((await consent(paul, id)).success, true);

		await paul.send(realOpusPackets(1, 880)); // 1 s of tone
		const paused = await ack(paul.socket, 'pause_producer', {
			producerId: paul.producerId,
		});
		assert.equal(paused.success, true);
		await paul.send(realOpusPackets(2, 880)); // 2 s the SFU does not forward
		const resumed = await ack(paul.socket, 'resume_producer', {
			producerId: paul.producerId,
		});
		assert.equal(resumed.success, true);
		await paul.send(realOpusPackets(1, 880)); // 1 s again

		await ack(host.socket, 'seance:stop', {});
		await tick(100);

		const manifest = await manifestOf(id, instance);
		const track = manifest.tracks[0];
		assert.ok(
			Math.abs(track.duration_ms - 4000) < 500,
			`4 s of wall clock, the track lasts ${track.duration_ms} ms`,
		);
		const pcm = await listen(id, instance, track);
		assert.ok(rms(pcm, 4800, 38400) > 0.03, 'first second is heard');
		assert.ok(
			rms(pcm, 62400, 86400) < 0.002,
			'the muted two seconds are silent',
		);
		assert.ok(rms(pcm, 148800, 182400) > 0.03, 'the last second is heard');
	});

	it('tells speech from silence by the audio level the browser sends', async () => {
		const instance = makeInstance();
		const id = 'MTG-G';
		assert.equal((await start(host, instance, id)).success, true);
		assert.equal((await consent(paul, id)).success, true);

		// one second of noise flagged as no voice, then one second of speech
		await paul.send(realOpusPackets(1, 880), { voice: false });
		await paul.send(realOpusPackets(1, 880), { voice: true });
		await ack(host.socket, 'seance:stop', {});
		await tick(100);

		const track = (await manifestOf(id, instance)).tracks[0];
		assert.equal(track.activity.length, 1, JSON.stringify(track.activity));
		const [from, to] = track.activity[0];
		assert.ok(Math.abs(from - 1000) < 150, `speech starts at ${from} ms`);
		assert.ok(Math.abs(to - 2000) < 150, `speech ends at ${to} ms`);
	});

	it('captures a microphone opened after the yes', async () => {
		const instance = makeInstance();
		const id = 'MTG-E';
		const late = await join(
			'late@e2e.example',
			'Luc Late',
			{},
			{ microphone: false },
		);
		assert.equal((await start(host, instance, id)).success, true);
		assert.equal((await consent(late, id)).success, true);
		await tick(100);

		await late.openMicrophone(); // the person unmutes for the first time
		await late.send(realOpusPackets(2, 660));

		await ack(host.socket, 'seance:stop', {});
		await tick(100);

		const manifest = await manifestOf(id, instance);
		const track = manifest.tracks.find((t) => t.user_id === late.userId);
		assert.ok(track, 'the late microphone was picked up');
		const pcm = await listen(id, instance, track);
		assert.ok(rms(pcm, 24000, 72000) > 0.03, 'what was said is there');
		const hz = toneFrequency(pcm, 24000, 72000);
		assert.ok(Math.abs(hz - 660) < 50, `heard ${hz} Hz`);
		late.socket.disconnect();
	});

	it('refuses an end-to-end encrypted room, for the host and for the others', async () => {
		const instance = makeInstance();
		const id = 'MTG-F';
		const cipherHost = await join(
			'chost@e2e.example',
			'Cipher Host',
			{ is_host: true, e2ee_required: true },
			{ microphone: false },
		);
		const refused = await start(cipherHost, instance, id);
		assert.deepEqual([refused.success, refused.error], [false, 'e2ee_room']);

		// a plain host starts; a person whose token says the room is encrypted cannot answer
		assert.equal((await start(host, instance, id)).success, true);
		const cipherGuest = await join(
			'cguest@e2e.example',
			'Cipher Guest',
			{ e2ee_required: true },
			{ microphone: false },
		);
		const answer = await consent(cipherGuest, id);
		assert.deepEqual([answer.success, answer.error], [false, 'e2ee_room']);

		await ack(host.socket, 'seance:stop', {});
		cipherHost.socket.disconnect();
		cipherGuest.socket.disconnect();
	});

	it('ends a person’s track when they leave, and the call goes on', async () => {
		const instance = makeInstance();
		const id = 'MTG-D';
		const leaver = await join('leaver@e2e.example', 'Léa Leaver');
		assert.equal((await start(host, instance, id)).success, true);
		assert.equal((await consent(leaver, id)).success, true);
		await leaver.send(realOpusPackets(1, 440));

		leaver.socket.disconnect();
		await tick(300);

		const manifest = await manifestOf(id, instance);
		assert.equal(
			manifest.state,
			'ended' === manifest.state ? manifest.state : 'active',
		);
		const track = manifest.tracks[0];
		assert.equal(track.end_reason, 'left');

		// nobody else was affected: Paul can still start and be captured
		assert.equal((await ack(host.socket, 'seance:stop', {})).success, true);
	});
});
