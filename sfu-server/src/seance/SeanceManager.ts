// //// Neoffice — added file (no upstream equivalent)
// Séance note-taking ("prise de notes"): the state machine.
//
// A séance is started by a host with a token the instance signed. Each person
// in the room is then asked, and is captured only after answering yes (a second
// token the instance signed, bound to that person). What is captured never
// leaves the SFU in clear: chunks are sealed for the instance (see sealer.ts)
// and wait in the spool until the instance fetches them with its pull key.
//
// This class knows nothing about sockets or HTTP: socketHandlers.ts and
// routes.ts drive it. Everything mediasoup-shaped goes through MediaFacade.

import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loggers } from '../utils/logger';
import type { SeanceConfig } from './config';
import { Sealer } from './sealer';
import {
	chunkFileName,
	directorySize,
	ensureSeanceDir,
	ensureSpoolDir,
	HANDLE_PATTERN,
	listChunkFiles,
	parseChunkFileName,
	readJson,
	removeSeanceDir,
	seanceHandle,
	sha256Hex,
	writeFileAtomic,
} from './spool';
import {
	ReplayCache,
	SeanceError,
	verifyConsentToken,
	verifyStartToken,
} from './tokens';
import { type TrackChunk, type TrackStats, TrackWriter } from './trackWriter';

const log = loggers.seance;

const AUDIO_LEVEL_URI = 'urn:ietf:params:rtp-hdrext:ssrc-audio-level';
const MAX_RTP_ERRORS = 50;
const TICK_INTERVAL_MS = 1000;
const PURGE_INTERVAL_MS = 10 * 60 * 1000;

// ---- what the manager needs from the rest of the SFU -----------------------

export interface ConsumerLike {
	rtpParameters: { headerExtensions?: Array<{ uri: string; id: number }> };
	// biome-ignore lint/suspicious/noExplicitAny: structural stand-in for the mediasoup event emitter
	on(event: string, listener: (...args: any[]) => void): unknown;
	close(): void;
}

export interface DirectTransportLike {
	consume(options: {
		producerId: string;
		rtpCapabilities: unknown;
		paused?: boolean;
	}): Promise<ConsumerLike>;
	close(): void;
}

export interface RouterLike {
	rtpCapabilities: unknown;
	createDirectTransport(): Promise<DirectTransportLike>;
}

export interface ProducerLike {
	id: string;
	kind: string;
	closed: boolean;
	appData: Record<string, unknown>;
}

export interface MediaFacade {
	getRouter(roomId: string): RouterLike | undefined;
	getPeerAudioProducers(roomId: string, peerId: string): ProducerLike[];
	onProducerCreated(
		listener: (roomId: string, peerId: string, producer: ProducerLike) => void,
	): void;
	onPeerRemoved(listener: (roomId: string, peerId: string) => void): void;
	onRoomClosed(listener: (roomId: string) => void): void;
}

export interface SeanceNotifier {
	emitToRoom(roomId: string, event: string, payload: unknown): void;
}

/** What the manager needs to know about the socket that asks. */
export interface SocketContext {
	userId: string;
	userName: string;
	isHost: boolean;
	isCohost: boolean;
	isGuest: boolean;
	e2eeRequired: boolean;
	/** '' when the SFU runs single-tenant. */
	tenant: string;
	rawMeetingId: string;
	/** Effective mediasoup room key (`<tenant>:<meeting>`). */
	roomId: string;
}

// ---- model -----------------------------------------------------------------

type PersonState = 'pending' | 'consented' | 'declined' | 'withdrawn';

interface Tap {
	transport: DirectTransportLike;
	consumer: ConsumerLike;
	producerId: string;
}

interface Track {
	id: string;
	userId: string;
	name: string;
	isGuest: boolean;
	consentAt: string;
	startedMs: number;
	startOffsetMs: number;
	endedMs: number | null;
	endReason: string | null;
	withdrawnMs: number | null;
	erased: boolean;
	/** Length of the track, kept when it ends (chunks may be gone by then). */
	durationMs: number;
	activity: Array<[number, number]>;
	stats: TrackStats | null;
	writer: TrackWriter | null;
	tap: Tap | null;
	attaching: boolean;
	rtpErrors: number;
	bytes: number;
}

type SeanceState = 'active' | 'ended';

interface Seance {
	handle: string;
	seanceId: string;
	tenant: string;
	meetingId: string;
	roomId: string;
	startedMs: number;
	startedBy: { userId: string; name: string };
	pullKeyHash: Buffer;
	/** Chunks are sealed (always, outside development). */
	sealed: boolean;
	/** Null for a séance restored from disk until it is started again. */
	sealer: Sealer | null;
	state: SeanceState;
	endedMs: number | null;
	endReason: string | null;
	people: Map<string, PersonState>;
	tracks: Track[];
	bytes: number;
	dir: string;
}

interface SeanceView {
	active: boolean;
	seance_id: string;
	started_at: string;
	started_by: { id: string; name: string };
	/** User ids captured right now. */
	capturing: string[];
	you: PersonState;
	reason?: string;
}

interface ManifestChunk {
	index: number;
	file: string;
	bytes: number;
	sha256: string;
	start_ms: number;
	duration_ms: number;
	final: boolean;
}

interface ManifestTrack {
	track_id: string;
	user_id: string;
	name: string;
	is_guest: boolean;
	consent_at: string;
	start_offset_ms: number;
	ended: boolean;
	end_reason: string | null;
	withdrawn: boolean;
	erased: boolean;
	duration_ms: number;
	/** Speech intervals, milliseconds from the start of the track. */
	activity: Array<[number, number]>;
	chunks: ManifestChunk[];
	stats: TrackStats | null;
}

interface Manifest {
	version: 1;
	handle: string;
	seance_id: string;
	state: SeanceState;
	started_at: string;
	ended_at: string | null;
	end_reason: string | null;
	codec: 'opus';
	container: 'ogg';
	sample_rate: 48000;
	channels: 1;
	chunk_format: 'nsc1' | 'ogg';
	tracks: ManifestTrack[];
}

interface SeanceSidecar {
	version: 1;
	handle: string;
	seance_id: string;
	tenant: string;
	meeting_id: string;
	started_ms: number;
	started_by: { user_id: string; name: string };
	pull_key_hash: string;
	sealed: boolean;
	state: SeanceState;
	ended_ms: number | null;
	end_reason: string | null;
}

interface TrackSidecar {
	version: 1;
	track_id: string;
	user_id: string;
	name: string;
	is_guest: boolean;
	consent_at: string;
	started_ms: number;
	start_offset_ms: number;
	ended_ms: number | null;
	end_reason: string | null;
	withdrawn_ms: number | null;
	erased: boolean;
	duration_ms?: number;
	activity: Array<[number, number]>;
	stats: TrackStats | null;
}

interface SeanceManagerOptions {
	config: SeanceConfig;
	/** The secret the SFU already shares with the instances (JWT_SECRET). */
	secret: string;
	media: MediaFacade;
	notifier?: SeanceNotifier;
	now?: () => number;
}

// ----------------------------------------------------------------------------

export class SeanceManager {
	private readonly config: SeanceConfig;
	private readonly secret: string;
	private readonly media: MediaFacade;
	private notifier: SeanceNotifier | null;
	private readonly now: () => number;
	private readonly replay = new ReplayCache();
	private readonly byHandle = new Map<string, Seance>();
	private readonly byRoom = new Map<string, Seance>();
	private readonly chunkHashes = new Map<string, string>();
	private spoolBytes = 0;
	private available = false;
	private timers: NodeJS.Timeout[] = [];

	constructor(options: SeanceManagerOptions) {
		this.config = options.config;
		this.secret = options.secret;
		this.media = options.media;
		this.notifier = options.notifier ?? null;
		this.now = options.now ?? Date.now;

		if (!this.config.enabled) {
			log.info('Séance note-taking is disabled (SEANCE_TAP=0)');
			return;
		}
		try {
			ensureSpoolDir(this.config.spoolDir);
		} catch (error) {
			log.error(
				'Séance spool is not usable, the feature stays off: %s',
				(error as Error).message,
			);
			return;
		}
		this.available = true;

		this.restoreFromDisk();
		this.media.onProducerCreated((roomId, peerId, producer) =>
			this.handleProducerCreated(roomId, peerId, producer),
		);
		this.media.onPeerRemoved((roomId, peerId) =>
			this.handlePeerRemoved(roomId, peerId),
		);
		this.media.onRoomClosed((roomId) => this.handleRoomClosed(roomId));

		this.timers.push(
			setInterval(() => this.tick(), TICK_INTERVAL_MS).unref(),
			setInterval(() => this.purgeExpired(), PURGE_INTERVAL_MS).unref(),
		);
		log.info('Séance note-taking is ready');
	}

	setNotifier(notifier: SeanceNotifier): void {
		this.notifier = notifier;
	}

	/** True when sockets and routes should answer. */
	get enabled(): boolean {
		return this.available;
	}

	// ---- sockets ---------------------------------------------------------

	async start(ctx: SocketContext, token: unknown): Promise<SeanceView> {
		this.assertAvailable();
		if (ctx.e2eeRequired) throw new SeanceError('e2ee_room');
		if (!ctx.isHost && !ctx.isCohost) throw new SeanceError('not_host');

		const claims = verifyStartToken(token, this.secret);
		this.assertSameRoom(ctx, claims.tenant, claims.meetingId);
		if (claims.hostUserId !== ctx.userId) throw new SeanceError('wrong_user');
		if (!this.replay.consume(claims.jti, claims.expiresAtMs, this.now())) {
			throw new SeanceError('replayed');
		}

		const live = this.byRoom.get(ctx.roomId);
		if (live && live.state === 'active') {
			if (live.seanceId === claims.seanceId) {
				return this.viewFor(live, ctx.userId); // a reload of the host's page
			}
			throw new SeanceError('already_active');
		}

		const handle = seanceHandle(claims.tenant, claims.seanceId);
		const known = this.byHandle.get(handle);
		const pullKeyHash = Buffer.from(claims.pullKeyHash, 'hex');
		if (known) {
			// Only a séance cut short by a restart of the SFU can go on.
			const resumable =
				known.state === 'ended' &&
				known.endReason === 'server_restart' &&
				known.roomId === ctx.roomId &&
				safeEqual(known.pullKeyHash, pullKeyHash);
			if (!resumable) throw new SeanceError('seance_exists');
			if (known.sealed) {
				if (!claims.encryptionKey) throw new SeanceError('key_required');
				known.sealer = this.sealerFor(claims.encryptionKey);
			}
			known.state = 'active';
			known.endedMs = null;
			known.endReason = null;
			known.people = new Map();
			known.startedBy = { userId: ctx.userId, name: ctx.userName };
			this.byRoom.set(ctx.roomId, known);
			this.persistSeance(known);
			this.broadcast(known);
			log.info('Séance %s resumed after a restart', handle.slice(0, 8));
			return this.viewFor(known, ctx.userId);
		}

		if (!claims.encryptionKey && !this.config.allowPlaintext) {
			throw new SeanceError('key_required');
		}
		const sealer = claims.encryptionKey
			? this.sealerFor(claims.encryptionKey)
			: null;
		if (this.spoolBytes >= this.config.maxSpoolBytes) {
			throw new SeanceError('capacity');
		}

		let dir: string;
		try {
			dir = ensureSeanceDir(this.config.spoolDir, handle);
		} catch (error) {
			log.error(
				'Cannot create a séance directory: %s',
				(error as Error).message,
			);
			throw new SeanceError('spool_unavailable');
		}

		const seance: Seance = {
			handle,
			seanceId: claims.seanceId,
			tenant: claims.tenant,
			meetingId: claims.meetingId,
			roomId: ctx.roomId,
			startedMs: this.now(),
			startedBy: { userId: ctx.userId, name: ctx.userName },
			pullKeyHash,
			sealed: sealer !== null,
			sealer,
			state: 'active',
			endedMs: null,
			endReason: null,
			people: new Map(),
			tracks: [],
			bytes: 0,
			dir,
		};
		this.byHandle.set(handle, seance);
		this.byRoom.set(ctx.roomId, seance);
		this.persistSeance(seance);
		this.broadcast(seance);
		log.info('Séance %s started', handle.slice(0, 8));
		return this.viewFor(seance, ctx.userId);
	}

	async consent(ctx: SocketContext, token: unknown): Promise<SeanceView> {
		this.assertAvailable();
		if (ctx.e2eeRequired) throw new SeanceError('e2ee_room');
		const seance = this.activeSeance(ctx);

		const claims = verifyConsentToken(token, this.secret);
		this.assertSameRoom(ctx, claims.tenant, claims.meetingId);
		if (claims.seanceId !== seance.seanceId) {
			throw new SeanceError('wrong_seance');
		}
		if (claims.userId !== ctx.userId) throw new SeanceError('wrong_user');
		if (!this.replay.consume(claims.jti, claims.expiresAtMs, this.now())) {
			throw new SeanceError('replayed');
		}

		const current = this.activeTrack(seance, ctx.userId);
		if (current) return this.viewFor(seance, ctx.userId); // already captured

		const concurrent = seance.tracks.filter((t) => t.endedMs === null).length;
		if (concurrent >= this.config.maxTracksPerSeance) {
			throw new SeanceError('capacity');
		}
		if (this.spoolBytes >= this.config.maxSpoolBytes) {
			throw new SeanceError('capacity');
		}

		const now = this.now();
		const track: Track = {
			id: randomBytes(8).toString('hex'),
			userId: ctx.userId,
			name: ctx.userName,
			isGuest: ctx.isGuest,
			consentAt: claims.consentAt,
			startedMs: now,
			startOffsetMs: Math.max(0, now - seance.startedMs),
			endedMs: null,
			endReason: null,
			withdrawnMs: null,
			erased: false,
			durationMs: 0,
			activity: [],
			stats: null,
			writer: null,
			tap: null,
			attaching: false,
			rtpErrors: 0,
			bytes: 0,
		};
		track.writer = new TrackWriter({
			serial: randomBytes(4).readUInt32LE(0),
			startMs: now,
			chunkSeconds: this.config.chunkSeconds,
			onChunk: (chunk) => this.storeChunk(seance, track, chunk),
		});
		seance.tracks.push(track);
		seance.people.set(ctx.userId, 'consented');
		this.persistTrack(seance, track);
		this.broadcast(seance);

		// The microphone may already be open: start listening to it.
		for (const producer of this.media.getPeerAudioProducers(
			seance.roomId,
			ctx.userId,
		)) {
			await this.attachTap(seance, track, producer);
		}
		return this.viewFor(seance, ctx.userId);
	}

	decline(ctx: SocketContext): SeanceView {
		this.assertAvailable();
		const seance = this.activeSeance(ctx);
		if (!this.activeTrack(seance, ctx.userId)) {
			seance.people.set(ctx.userId, 'declined');
		}
		return this.viewFor(seance, ctx.userId);
	}

	withdraw(ctx: SocketContext, erase: boolean): SeanceView {
		this.assertAvailable();
		const seance = this.activeSeance(ctx);
		this.withdrawUser(seance, ctx.userId, erase);
		return this.viewFor(seance, ctx.userId);
	}

	stop(ctx: SocketContext): SeanceView {
		this.assertAvailable();
		const seance = this.activeSeance(ctx);
		if (
			!ctx.isHost &&
			!ctx.isCohost &&
			ctx.userId !== seance.startedBy.userId
		) {
			throw new SeanceError('not_host');
		}
		this.endSeance(seance, 'stopped');
		return this.viewFor(seance, ctx.userId);
	}

	getState(ctx: SocketContext): SeanceView | { active: false } {
		this.assertAvailable();
		const seance = this.byRoom.get(ctx.roomId);
		if (!seance || seance.state !== 'active') return { active: false };
		return this.viewFor(seance, ctx.userId);
	}

	// ---- media events ------------------------------------------------------

	private handleProducerCreated(
		roomId: string,
		peerId: string,
		producer: ProducerLike,
	): void {
		try {
			const seance = this.byRoom.get(roomId);
			if (!seance || seance.state !== 'active') return;
			const track = this.activeTrack(seance, peerId);
			if (!track) return;
			void this.attachTap(seance, track, producer);
		} catch (error) {
			log.warn('producer hook failed: %s', (error as Error).message);
		}
	}

	private handlePeerRemoved(roomId: string, peerId: string): void {
		try {
			const seance = this.byRoom.get(roomId);
			if (!seance || seance.state !== 'active') return;
			const track = this.activeTrack(seance, peerId);
			if (!track) return;
			this.endTrack(seance, track, 'left');
			seance.people.delete(peerId);
			this.broadcast(seance);
		} catch (error) {
			log.warn('peer hook failed: %s', (error as Error).message);
		}
	}

	private handleRoomClosed(roomId: string): void {
		try {
			const seance = this.byRoom.get(roomId);
			if (!seance || seance.state !== 'active') return;
			this.endSeance(seance, 'room_closed');
		} catch (error) {
			log.warn('room hook failed: %s', (error as Error).message);
		}
	}

	// ---- taps ----------------------------------------------------------------

	private isCapturable(producer: ProducerLike): boolean {
		// A shared screen can carry anybody's voice, music, a video call:
		// never captured. Only the person's own microphone is.
		return (
			producer.kind === 'audio' &&
			!producer.closed &&
			producer.appData?.type !== 'screen'
		);
	}

	private async attachTap(
		seance: Seance,
		track: Track,
		producer: ProducerLike,
	): Promise<void> {
		if (track.tap || track.attaching || track.endedMs !== null) return;
		if (!this.isCapturable(producer)) return;
		const router = this.media.getRouter(seance.roomId);
		if (!router) return;

		track.attaching = true;
		let transport: DirectTransportLike | null = null;
		try {
			transport = await router.createDirectTransport();
			const consumer = await transport.consume({
				producerId: producer.id,
				rtpCapabilities: router.rtpCapabilities,
				paused: false,
			});

			// The person may have withdrawn while we were awaiting mediasoup.
			if (track.endedMs !== null || track.tap) {
				transport.close();
				return;
			}

			const extension = consumer.rtpParameters.headerExtensions?.find(
				(item) => item.uri === AUDIO_LEVEL_URI,
			);
			const tap: Tap = { transport, consumer, producerId: producer.id };
			track.tap = tap;

			consumer.on('rtp', (packet: Buffer) =>
				this.handleRtp(seance, track, packet, extension?.id),
			);
			consumer.on('producerpause', () => track.writer?.interrupt());
			consumer.on('producerclose', () => this.detachTap(track, tap));
			consumer.on('transportclose', () => this.detachTap(track, tap));
		} catch (error) {
			transport?.close();
			log.warn(
				'Could not listen to a microphone: %s',
				(error as Error).message,
			);
		} finally {
			track.attaching = false;
		}
	}

	private detachTap(track: Track, tap: Tap): void {
		if (track.tap !== tap) return;
		track.tap = null;
		track.writer?.interrupt();
		try {
			tap.transport.close();
		} catch {
			// already closed with the router
		}
	}

	private handleRtp(
		seance: Seance,
		track: Track,
		packet: Buffer,
		audioLevelExtensionId: number | undefined,
	): void {
		try {
			track.writer?.pushRtp(packet, this.now(), audioLevelExtensionId);
		} catch (error) {
			track.rtpErrors++;
			if (track.rtpErrors === 1) {
				log.warn('RTP handling failed: %s', (error as Error).message);
			}
			if (track.rtpErrors >= MAX_RTP_ERRORS) {
				this.endTrack(seance, track, 'error');
				this.broadcast(seance);
			}
		}
	}

	// ---- tracks and chunks -----------------------------------------------

	/** The writer of a track that is still capturing, null otherwise. */
	private liveWriter(track: Track): TrackWriter | null {
		return track.endedMs === null ? track.writer : null;
	}

	private activeSeance(ctx: SocketContext): Seance {
		const seance = this.byRoom.get(ctx.roomId);
		if (!seance || seance.state !== 'active') {
			throw new SeanceError('no_active_seance');
		}
		return seance;
	}

	private activeTrack(seance: Seance, userId: string): Track | undefined {
		return seance.tracks.find((t) => t.userId === userId && t.endedMs === null);
	}

	private sealerFor(publicKeyPem: string): Sealer {
		try {
			return new Sealer(publicKeyPem);
		} catch {
			throw new SeanceError('key_invalid');
		}
	}

	private assertAvailable(): void {
		if (!this.available) throw new SeanceError('seance_unavailable');
	}

	private assertSameRoom(
		ctx: SocketContext,
		tenant: string,
		meetingId: string,
	): void {
		if (tenant !== ctx.tenant || meetingId !== ctx.rawMeetingId) {
			throw new SeanceError('wrong_room');
		}
	}

	private storeChunk(seance: Seance, track: Track, chunk: TrackChunk): void {
		// A chunk of a track that was erased is dropped, never written.
		if (track.erased) return;
		try {
			const sealed = seance.sealed;
			if (sealed && !seance.sealer) throw new Error('no sealing key');
			const data = seance.sealer
				? seance.sealer.seal(
						chunk.data,
						`${seance.seanceId}/${track.id}/${chunk.index}`,
					)
				: chunk.data;
			const startMs = chunk.startSample / 48;
			const durationMs = chunk.samples / 48;
			const file = chunkFileName(
				track.id,
				chunk.index,
				startMs,
				durationMs,
				chunk.final,
				sealed ? 'nsc' : 'ogg',
			);
			writeFileAtomic(path.join(seance.dir, file), data);
			this.chunkHashes.set(`${seance.handle}/${file}`, sha256Hex(data));
			track.bytes += data.length;
			seance.bytes += data.length;
			this.spoolBytes += data.length;
		} catch (error) {
			log.error('Cannot store a chunk: %s', (error as Error).message);
			// Keep the call alive, stop the capture: better nothing than a
			// séance with silent holes nobody knows about.
			setImmediate(() => {
				if (seance.state === 'active') this.endSeance(seance, 'disk_error');
			});
			return;
		}
		this.persistTrack(seance, track);

		if (
			seance.state === 'active' &&
			(seance.bytes >= this.config.maxSeanceBytes ||
				this.spoolBytes >= this.config.maxSpoolBytes)
		) {
			setImmediate(() => {
				if (seance.state === 'active') this.endSeance(seance, 'capacity');
			});
		}
	}

	private endTrack(seance: Seance, track: Track, reason: string): void {
		if (track.endedMs !== null) return;
		const now = this.now();
		const tap = track.tap;
		if (tap) this.detachTap(track, tap);
		track.endedMs = now;
		track.endReason = reason;
		try {
			track.writer?.finish(now); // emits the last chunk
		} catch (error) {
			log.warn('Closing a track failed: %s', (error as Error).message);
		}
		track.activity = track.writer?.activityMs() ?? track.activity;
		track.stats = track.writer ? { ...track.writer.stats } : track.stats;
		track.durationMs = track.writer
			? Math.round((track.writer.samples * 1000) / 48000)
			: track.durationMs;
		this.persistTrack(seance, track);
	}

	private withdrawUser(seance: Seance, userId: string, erase: boolean): void {
		const track = this.activeTrack(seance, userId);
		if (track) this.endTrack(seance, track, 'withdrawn');
		// A person who revokes later (another device, after the end) revokes
		// every track of theirs in this séance.
		const now = this.now();
		for (const own of seance.tracks) {
			if (own.userId === userId && own.withdrawnMs === null) {
				own.withdrawnMs = now;
				this.persistTrack(seance, own);
			}
		}
		if (seance.people.get(userId) === 'consented' || track) {
			seance.people.set(userId, 'withdrawn');
		}
		if (erase) {
			for (const own of seance.tracks.filter((t) => t.userId === userId)) {
				this.eraseTrack(seance, own);
			}
		}
		this.broadcast(seance);
	}

	private eraseTrack(seance: Seance, track: Track): void {
		track.erased = true;
		for (const chunk of listChunkFiles(seance.dir)) {
			if (chunk.trackId !== track.id) continue;
			try {
				const full = path.join(seance.dir, chunk.file);
				const size = fs.statSync(full).size;
				fs.rmSync(full, { force: true });
				this.chunkHashes.delete(`${seance.handle}/${chunk.file}`);
				seance.bytes = Math.max(0, seance.bytes - size);
				this.spoolBytes = Math.max(0, this.spoolBytes - size);
			} catch {
				// already gone
			}
		}
		// What stays is a tombstone: enough for the instance to see that the
		// track was erased, nothing about the person beyond their identifier.
		track.bytes = 0;
		track.activity = [];
		track.stats = null;
		track.durationMs = 0;
		track.name = '';
		this.persistTrack(seance, track);
	}

	private endSeance(seance: Seance, reason: string): void {
		if (seance.state === 'ended') return;
		for (const track of seance.tracks) {
			if (track.endedMs === null) this.endTrack(seance, track, reason);
		}
		seance.state = 'ended';
		seance.endedMs = this.now();
		seance.endReason = reason;
		if (this.byRoom.get(seance.roomId) === seance) {
			this.byRoom.delete(seance.roomId);
		}
		this.persistSeance(seance);
		this.notifier?.emitToRoom(seance.roomId, 'seance:ended', {
			seance_id: seance.seanceId,
			reason,
		});
		log.info('Séance %s ended (%s)', seance.handle.slice(0, 8), reason);
	}

	// ---- views -------------------------------------------------------------

	private viewFor(seance: Seance, userId: string): SeanceView {
		const capturing = seance.tracks
			.filter((t) => t.endedMs === null)
			.map((t) => t.userId);
		const view: SeanceView = {
			active: seance.state === 'active',
			seance_id: seance.seanceId,
			started_at: new Date(seance.startedMs).toISOString(),
			started_by: {
				id: seance.startedBy.userId,
				name: seance.startedBy.name,
			},
			capturing: [...new Set(capturing)],
			you: seance.people.get(userId) ?? 'pending',
		};
		if (seance.endReason) view.reason = seance.endReason;
		return view;
	}

	private broadcast(seance: Seance): void {
		if (seance.state !== 'active') return;
		const view = this.viewFor(seance, '');
		// `you` is meaningless in a broadcast: every client keeps its own.
		const { you: _you, ...shared } = view;
		this.notifier?.emitToRoom(seance.roomId, 'seance:state', shared);
	}

	// ---- pick-up side (HTTP) -----------------------------------------------

	/** The séance when the pull key is the right one, null otherwise. */
	authorizePull(handle: string, pullKey: string): Seance | null {
		if (!this.available || !HANDLE_PATTERN.test(handle)) return null;
		const seance = this.byHandle.get(handle);
		if (!seance || typeof pullKey !== 'string' || pullKey.length === 0) {
			return null;
		}
		const presented = createHash('sha256').update(pullKey, 'utf8').digest();
		return safeEqual(presented, seance.pullKeyHash) ? seance : null;
	}

	manifest(seance: Seance): Manifest {
		const files = listChunkFiles(seance.dir);
		const tracks: ManifestTrack[] = seance.tracks.map((track) => {
			const chunks: ManifestChunk[] = [];
			for (const file of files) {
				if (file.trackId !== track.id) continue;
				const full = path.join(seance.dir, file.file);
				let bytes = 0;
				try {
					bytes = fs.statSync(full).size;
				} catch {
					continue;
				}
				chunks.push({
					index: file.index,
					file: file.file,
					bytes,
					sha256: this.hashOf(seance, file.file, full),
					start_ms: file.startMs,
					duration_ms: file.durationMs,
					final: file.final,
				});
			}
			const live = this.liveWriter(track);
			const activity = live ? live.activityMs() : track.activity;
			const stats = live ? { ...live.stats } : track.stats;
			const durationMs = live
				? Math.round((live.samples * 1000) / 48000)
				: track.durationMs;
			return {
				track_id: track.id,
				user_id: track.userId,
				name: track.name,
				is_guest: track.isGuest,
				consent_at: track.consentAt,
				start_offset_ms: track.startOffsetMs,
				ended: track.endedMs !== null,
				end_reason: track.endReason,
				withdrawn: track.withdrawnMs !== null,
				erased: track.erased,
				duration_ms: durationMs,
				activity,
				chunks,
				stats,
			};
		});

		return {
			version: 1,
			handle: seance.handle,
			seance_id: seance.seanceId,
			state: seance.state,
			started_at: new Date(seance.startedMs).toISOString(),
			ended_at: seance.endedMs ? new Date(seance.endedMs).toISOString() : null,
			end_reason: seance.endReason,
			codec: 'opus',
			container: 'ogg',
			sample_rate: 48000,
			channels: 1,
			chunk_format: seance.sealed ? 'nsc1' : 'ogg',
			tracks,
		};
	}

	/** Full path of a chunk file, or null when it does not exist. */
	chunkPath(seance: Seance, file: string): string | null {
		if (!parseChunkFileName(file)) return null;
		const full = path.join(seance.dir, file);
		return fs.existsSync(full) ? full : null;
	}

	/** The instance confirms it stored these chunks: they can go. */
	acknowledge(seance: Seance, files: string[]): number {
		let removed = 0;
		for (const file of files) {
			const parsed = parseChunkFileName(file);
			if (!parsed) continue;
			const full = path.join(seance.dir, file);
			try {
				const size = fs.statSync(full).size;
				fs.rmSync(full, { force: true });
				this.chunkHashes.delete(`${seance.handle}/${file}`);
				seance.bytes = Math.max(0, seance.bytes - size);
				this.spoolBytes = Math.max(0, this.spoolBytes - size);
				removed++;
			} catch {
				// unknown or already removed
			}
		}
		return removed;
	}

	/** Server-to-server stop (the instance ends a séance whose host is gone). */
	stopByPull(seance: Seance, reason = 'stopped_by_instance'): void {
		this.endSeance(seance, reason);
	}

	/** Server-to-server withdrawal (the person used another device). */
	withdrawByPull(seance: Seance, userId: string, erase: boolean): void {
		this.withdrawUser(seance, userId, erase);
	}

	/** Forgets the séance and everything stored for it. */
	purge(seance: Seance): void {
		if (seance.state === 'active') this.endSeance(seance, 'purged');
		removeSeanceDir(this.config.spoolDir, seance.handle);
		for (const key of [...this.chunkHashes.keys()]) {
			if (key.startsWith(`${seance.handle}/`)) this.chunkHashes.delete(key);
		}
		this.spoolBytes = Math.max(0, this.spoolBytes - seance.bytes);
		this.byHandle.delete(seance.handle);
		if (this.byRoom.get(seance.roomId) === seance) {
			this.byRoom.delete(seance.roomId);
		}
	}

	/** Ends every séance (SFU shutting down) so that no chunk is lost. */
	shutdown(): void {
		for (const timer of this.timers) clearInterval(timer);
		this.timers = [];
		for (const seance of [...this.byHandle.values()]) {
			if (seance.state === 'active') this.endSeance(seance, 'server_restart');
		}
	}

	// ---- housekeeping --------------------------------------------------------

	private tick(): void {
		const now = this.now();
		for (const seance of this.byHandle.values()) {
			if (seance.state !== 'active') continue;
			if (now - seance.startedMs >= this.config.maxSeanceSeconds * 1000) {
				this.endSeance(seance, 'max_duration');
				continue;
			}
			for (const track of seance.tracks) {
				if (track.endedMs === null) {
					try {
						track.writer?.tick(now);
					} catch (error) {
						log.warn('tick failed: %s', (error as Error).message);
					}
				}
			}
		}
	}

	private purgeExpired(): void {
		const now = this.now();
		const keep = this.config.retentionHours * 3600 * 1000;
		for (const seance of [...this.byHandle.values()]) {
			if (seance.state === 'ended' && seance.endedMs !== null) {
				if (now - seance.endedMs >= keep) {
					log.info('Séance %s expired, removed', seance.handle.slice(0, 8));
					this.purge(seance);
				}
			}
		}
	}

	private hashOf(seance: Seance, file: string, full: string): string {
		const key = `${seance.handle}/${file}`;
		let hash = this.chunkHashes.get(key);
		if (!hash) {
			hash = sha256Hex(fs.readFileSync(full));
			this.chunkHashes.set(key, hash);
		}
		return hash;
	}

	// ---- persistence ---------------------------------------------------------

	private persistSeance(seance: Seance): void {
		const sidecar: SeanceSidecar = {
			version: 1,
			handle: seance.handle,
			seance_id: seance.seanceId,
			tenant: seance.tenant,
			meeting_id: seance.meetingId,
			started_ms: seance.startedMs,
			started_by: {
				user_id: seance.startedBy.userId,
				name: seance.startedBy.name,
			},
			pull_key_hash: seance.pullKeyHash.toString('hex'),
			sealed: seance.sealed,
			state: seance.state,
			ended_ms: seance.endedMs,
			end_reason: seance.endReason,
		};
		try {
			writeFileAtomic(
				path.join(seance.dir, 'seance.json'),
				JSON.stringify(sidecar),
			);
		} catch (error) {
			log.warn('Cannot persist a séance: %s', (error as Error).message);
		}
	}

	private persistTrack(seance: Seance, track: Track): void {
		const live = this.liveWriter(track);
		const sidecar: TrackSidecar = {
			version: 1,
			track_id: track.id,
			user_id: track.userId,
			name: track.name,
			is_guest: track.isGuest,
			consent_at: track.consentAt,
			started_ms: track.startedMs,
			start_offset_ms: track.startOffsetMs,
			ended_ms: track.endedMs,
			end_reason: track.endReason,
			withdrawn_ms: track.withdrawnMs,
			erased: track.erased,
			duration_ms: live
				? Math.round((live.samples * 1000) / 48000)
				: track.durationMs,
			activity: live ? live.activityMs() : track.activity,
			stats: live ? { ...live.stats } : track.stats,
		};
		try {
			writeFileAtomic(
				path.join(seance.dir, `${track.id}.json`),
				JSON.stringify(sidecar),
			);
		} catch (error) {
			log.warn('Cannot persist a track: %s', (error as Error).message);
		}
	}

	/**
	 * After a restart of the SFU: what is on disk can still be picked up.
	 * Whatever was `active` is closed (no tap survives a restart).
	 */
	private restoreFromDisk(): void {
		let handles: string[] = [];
		try {
			handles = fs.readdirSync(this.config.spoolDir);
		} catch {
			return;
		}
		for (const handle of handles) {
			if (!HANDLE_PATTERN.test(handle)) continue;
			const dir = path.join(this.config.spoolDir, handle);
			const sidecar = readJson<SeanceSidecar>(path.join(dir, 'seance.json'));
			if (!sidecar || sidecar.version !== 1 || sidecar.handle !== handle) {
				continue;
			}

			const tracks: Track[] = [];
			const chunkFiles = listChunkFiles(dir);
			const names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
			for (const name of names) {
				if (name === 'seance.json') continue;
				const item = readJson<TrackSidecar>(path.join(dir, name));
				if (!item || item.version !== 1) continue;
				tracks.push({
					id: item.track_id,
					userId: item.user_id,
					name: item.name,
					isGuest: item.is_guest,
					consentAt: item.consent_at,
					startedMs: item.started_ms,
					startOffsetMs: item.start_offset_ms,
					endedMs: item.ended_ms ?? sidecar.ended_ms ?? this.now(),
					endReason: item.end_reason ?? 'server_restart',
					withdrawnMs: item.withdrawn_ms,
					erased: item.erased,
					durationMs:
						item.duration_ms ??
						Math.max(
							0,
							...chunkFiles
								.filter((c) => c.trackId === item.track_id)
								.map((c) => c.startMs + c.durationMs),
						),
					activity: item.activity ?? [],
					stats: item.stats,
					writer: null,
					tap: null,
					attaching: false,
					rtpErrors: 0,
					bytes: 0,
				});
			}

			const bytes = directorySize(dir);
			const wasActive = sidecar.state === 'active';
			const seance: Seance = {
				handle,
				seanceId: sidecar.seance_id,
				tenant: sidecar.tenant,
				meetingId: sidecar.meeting_id,
				roomId: sidecar.tenant
					? `${sidecar.tenant}:${sidecar.meeting_id}`
					: sidecar.meeting_id,
				startedMs: sidecar.started_ms,
				startedBy: {
					userId: sidecar.started_by.user_id,
					name: sidecar.started_by.name,
				},
				pullKeyHash: Buffer.from(sidecar.pull_key_hash, 'hex'),
				// A restored séance is only read until it is started again.
				sealed: sidecar.sealed,
				sealer: null,
				state: 'ended',
				endedMs: sidecar.ended_ms ?? this.now(),
				endReason: wasActive ? 'server_restart' : sidecar.end_reason,
				people: new Map(),
				tracks,
				bytes,
				dir,
			};
			this.byHandle.set(handle, seance);
			this.spoolBytes += bytes;
			if (wasActive) this.persistSeance(seance);
		}
		if (this.byHandle.size > 0) {
			log.info('Restored %d séance(s) from the spool', this.byHandle.size);
		}
	}
}

function safeEqual(a: Buffer, b: Buffer): boolean {
	return a.length === b.length && timingSafeEqual(a, b);
}
