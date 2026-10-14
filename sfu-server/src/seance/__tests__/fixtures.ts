// //// Neoffice — added file (no upstream equivalent)
// A fake mediasoup, a fake instance (tokens, keys) and a spool directory:
// everything the SeanceManager tests need, with no network and no worker.

import { Buffer } from 'node:buffer';
import {
	constants,
	createDecipheriv,
	createHash,
	generateKeyPairSync,
	type KeyObject,
	privateDecrypt,
} from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as jwt from 'jsonwebtoken';
import type { SeanceConfig } from '../config';
import { OPUS_SILENCE_20MS } from '../oggOpus';
import type {
	ConsumerLike,
	DirectTransportLike,
	MediaFacade,
	ProducerLike,
	RouterLike,
	SeanceNotifier,
	SocketContext,
} from '../SeanceManager';
import {
	CONSENT_TOKEN_TYPE,
	SEANCE_AUDIENCE,
	START_TOKEN_TYPE,
} from '../tokens';
import { AUDIO_LEVEL_EXTENSION_ID, rtpPacket } from './helpers';

export const SECRET = 'secret-shared-by-the-fleet';
export const TENANT = 'client.example';
const MEETING = 'abc-defg-hij';
export const ROOM = `${TENANT}:${MEETING}`;

// ---- fake mediasoup ----------------------------------------------------------

class FakeConsumer extends EventEmitter implements ConsumerLike {
	rtpParameters = {
		headerExtensions: [
			{
				uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level',
				id: AUDIO_LEVEL_EXTENSION_ID,
			},
		],
	};
	closed = false;
	constructor(readonly producerId: string) {
		super();
	}
	close(): void {
		this.closed = true;
	}
}

class FakeTransport implements DirectTransportLike {
	closed = false;
	consumers: FakeConsumer[] = [];
	async consume(options: { producerId: string }): Promise<ConsumerLike> {
		const consumer = new FakeConsumer(options.producerId);
		this.consumers.push(consumer);
		return consumer;
	}
	close(): void {
		this.closed = true;
		for (const consumer of this.consumers) consumer.emit('transportclose');
	}
}

class FakeRouter implements RouterLike {
	rtpCapabilities = { codecs: [] };
	transports: FakeTransport[] = [];
	failNextTransport = false;
	private gate: Promise<void> | null = null;

	/** The next createDirectTransport waits until the returned function is called. */
	holdNextTransport(): () => void {
		let release: () => void = () => undefined;
		this.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		return release;
	}

	async createDirectTransport(): Promise<DirectTransportLike> {
		if (this.gate) {
			const gate = this.gate;
			this.gate = null;
			await gate;
		}
		if (this.failNextTransport) {
			this.failNextTransport = false;
			throw new Error('worker is gone');
		}
		const transport = new FakeTransport();
		this.transports.push(transport);
		return transport;
	}
}

export class FakeMedia implements MediaFacade {
	routers = new Map<string, FakeRouter>();
	private producers = new Map<string, ProducerLike[]>();
	private created: Array<
		(room: string, peer: string, p: ProducerLike) => void
	> = [];
	private removed: Array<(room: string, peer: string) => void> = [];
	private closed: Array<(room: string) => void> = [];
	private nextId = 1;

	room(roomId = ROOM): FakeRouter {
		let router = this.routers.get(roomId);
		if (!router) {
			router = new FakeRouter();
			this.routers.set(roomId, router);
		}
		return router;
	}

	getRouter(roomId: string): RouterLike | undefined {
		return this.routers.get(roomId);
	}

	getPeerAudioProducers(roomId: string, peerId: string): ProducerLike[] {
		return (this.producers.get(`${roomId}|${peerId}`) ?? []).filter(
			(p) => p.kind === 'audio' && !p.closed,
		);
	}

	onProducerCreated(
		listener: (r: string, p: string, x: ProducerLike) => void,
	): void {
		this.created.push(listener);
	}
	onPeerRemoved(listener: (r: string, p: string) => void): void {
		this.removed.push(listener);
	}
	onRoomClosed(listener: (r: string) => void): void {
		this.closed.push(listener);
	}

	/** A person's microphone (or video, or shared screen) appears. */
	addProducer(
		peerId: string,
		options: {
			kind?: string;
			appData?: Record<string, unknown>;
			roomId?: string;
			closed?: boolean;
		} = {},
	): ProducerLike {
		const roomId = options.roomId ?? ROOM;
		this.room(roomId);
		const producer: ProducerLike = {
			id: `producer-${this.nextId++}`,
			kind: options.kind ?? 'audio',
			closed: options.closed ?? false,
			appData: options.appData ?? {},
		};
		const key = `${roomId}|${peerId}`;
		this.producers.set(key, [...(this.producers.get(key) ?? []), producer]);
		for (const listener of this.created) listener(roomId, peerId, producer);
		return producer;
	}

	removePeer(peerId: string, roomId = ROOM): void {
		for (const listener of this.removed) listener(roomId, peerId);
		this.producers.delete(`${roomId}|${peerId}`);
	}

	closeRoom(roomId = ROOM): void {
		for (const listener of this.closed) listener(roomId);
		this.routers.delete(roomId);
	}

	/** Every consumer created in a room, in order. */
	consumers(roomId = ROOM): FakeConsumer[] {
		return (this.routers.get(roomId)?.transports ?? []).flatMap(
			(t) => t.consumers,
		);
	}
}

export class RecordingNotifier implements SeanceNotifier {
	events: Array<{
		roomId: string;
		event: string;
		payload: Record<string, unknown>;
	}> = [];
	emitToRoom(roomId: string, event: string, payload: unknown): void {
		this.events.push({
			roomId,
			event,
			payload: payload as Record<string, unknown>,
		});
	}
	last(event: string): Record<string, unknown> | undefined {
		return [...this.events].reverse().find((e) => e.event === event)?.payload;
	}
}

// ---- the instance (what the real one does with the same secret) -----------------

export interface Instance {
	privateKey: KeyObject;
	publicPem: string;
	pullKey: string;
	pullKeyHash: string;
}

let sharedKeys: { privateKey: KeyObject; publicPem: string } | null = null;

export function makeInstance(): Instance {
	if (!sharedKeys) {
		const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
		sharedKeys = {
			privateKey: pair.privateKey,
			publicPem: pair.publicKey
				.export({ type: 'spki', format: 'pem' })
				.toString(),
		};
	}
	const pullKey = `pull-${Math.random().toString(16).slice(2)}-${Date.now()}-0123456789`;
	return {
		...sharedKeys,
		pullKey,
		pullKeyHash: createHash('sha256').update(pullKey).digest('hex'),
	};
}

let jtiCounter = 0;
const nowSeconds = () => Math.floor(Date.now() / 1000);

export function startToken(
	instance: Instance,
	overrides: Record<string, unknown> = {},
	options: { type?: string; secret?: string } = {},
): string {
	return jwt.sign(
		{
			aud: SEANCE_AUDIENCE,
			scope: 'seance',
			tenant: TENANT,
			meeting_id: MEETING,
			seance_id: 'MTG-0001',
			host_user_id: 'host@example.ch',
			pull_key_hash: instance.pullKeyHash,
			enc_key: instance.publicPem,
			jti: `start-${++jtiCounter}`,
			iat: nowSeconds(),
			exp: nowSeconds() + 120,
			...overrides,
		},
		options.secret ?? SECRET,
		{
			algorithm: 'HS256',
			header: { alg: 'HS256', typ: options.type ?? START_TOKEN_TYPE },
		},
	);
}

export function consentToken(
	userId: string,
	overrides: Record<string, unknown> = {},
	options: { type?: string; secret?: string } = {},
): string {
	return jwt.sign(
		{
			aud: SEANCE_AUDIENCE,
			scope: 'seance',
			tenant: TENANT,
			meeting_id: MEETING,
			seance_id: 'MTG-0001',
			user_id: userId,
			consent_at: '2026-10-14T10:00:00Z',
			jti: `consent-${++jtiCounter}`,
			iat: nowSeconds(),
			exp: nowSeconds() + 120,
			...overrides,
		},
		options.secret ?? SECRET,
		{
			algorithm: 'HS256',
			header: { alg: 'HS256', typ: options.type ?? CONSENT_TOKEN_TYPE },
		},
	);
}

// ---- sockets, config, spool --------------------------------------------------------

export function socketContext(
	userId: string,
	overrides: Partial<SocketContext> = {},
): SocketContext {
	return {
		userId,
		userName: userId.split('@')[0],
		isHost: false,
		isCohost: false,
		isGuest: false,
		e2eeRequired: false,
		tenant: TENANT,
		rawMeetingId: MEETING,
		roomId: ROOM,
		...overrides,
	};
}

export const HOST = () => socketContext('host@example.ch', { isHost: true });
export const MARIE = () => socketContext('marie@example.ch');
export const PAUL = () => socketContext('paul@example.ch');

export function makeSpoolDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'seance-spool-'));
}

export function testConfig(
	spoolDir: string,
	overrides: Partial<SeanceConfig> = {},
): SeanceConfig {
	return {
		enabled: true,
		spoolDir,
		chunkSeconds: 1,
		maxTracksPerSeance: 40,
		maxSeanceSeconds: 4 * 3600,
		retentionHours: 24,
		maxSeanceBytes: 1024 * 1024 * 1024,
		maxSpoolBytes: 4 * 1024 * 1024 * 1024,
		allowPlaintext: false,
		...overrides,
	};
}

// ---- audio ------------------------------------------------------------------------------

/** A 20 ms packet of something that is not silence. */
const SPEECH = Buffer.concat([Buffer.from([0xf8]), Buffer.alloc(60, 0x5a)]);

export class Speaker {
	private sequence = 100;
	private timestamp = 5000;
	constructor(
		private readonly consumer: FakeConsumer,
		private readonly clock: { now: number },
	) {}

	/** Sends `count` packets, 20 ms apart, advancing the shared clock. */
	talk(count: number, payload: Buffer = SPEECH): void {
		for (let i = 0; i < count; i++) {
			this.consumer.emit(
				'rtp',
				rtpPacket({
					sequence: this.sequence++,
					timestamp: this.timestamp,
					payload,
					level: { value: 30, voice: payload !== OPUS_SILENCE_20MS },
				}),
			);
			this.timestamp += 960;
			this.clock.now += 20;
		}
	}
}

// ---- opening what the SFU sealed (the instance's side) --------------------------------

export function openChunk(
	sealed: Buffer,
	instance: Instance,
	additionalData: string,
): Buffer {
	const wrappedLength = sealed.readUInt16BE(4);
	const wrapped = sealed.subarray(6, 6 + wrappedLength);
	const iv = sealed.subarray(6 + wrappedLength, 6 + wrappedLength + 12);
	const body = sealed.subarray(6 + wrappedLength + 12, sealed.length - 16);
	const tag = sealed.subarray(sealed.length - 16);
	const dataKey = privateDecrypt(
		{
			key: instance.privateKey,
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: 'sha256',
		},
		wrapped,
	);
	const decipher = createDecipheriv('aes-256-gcm', dataKey, iv);
	decipher.setAAD(Buffer.from(additionalData, 'utf8'));
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(body), decipher.final()]);
}
