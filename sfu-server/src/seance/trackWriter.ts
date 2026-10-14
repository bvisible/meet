// //// Neoffice — added file (no upstream equivalent)
// Séance note-taking: turns the RTP packets of ONE person into ONE Ogg/Opus
// stream, cut into chunks of about `chunkSeconds`.
//
// The stream is continuous in time: every hole (muted microphone, DTX, lost
// packets) is filled with silence, so that the sample position inside the
// stream is always the time elapsed since the track started. The chunks are
// whole Ogg pages: putting them end to end gives back one valid stream.

import { Buffer } from 'node:buffer';
import {
	OggOpusWriter,
	OPUS_SAMPLE_RATE,
	OPUS_SILENCE_20MS,
	opusPacketSamples,
	SILENCE_FRAME_SAMPLES,
} from './oggOpus';
import { parseRtp } from './rtp';

const SAMPLES_PER_MS = OPUS_SAMPLE_RATE / 1000;

// No packet for this long: keep the timeline moving with silence.
const IDLE_FILL_AFTER_MS = 1000;
// ... but stay a little behind the wall clock, so that late media still fits.
const IDLE_FILL_SLACK_SAMPLES = 100 * SAMPLES_PER_MS;
// An RTP timestamp that jumps further than this is not trusted: use the wall clock.
const MAX_RTP_GAP_SAMPLES = 60 * OPUS_SAMPLE_RATE;
// Upper bound of one silence fill (4 hours of 20 ms frames).
const MAX_FILL_FRAMES = 4 * 3600 * 50;
// Speech separated by less than this is one interval.
const ACTIVITY_MERGE_GAP_SAMPLES = 400 * SAMPLES_PER_MS;
// Without the audio-level extension, a packet this big carries speech.
const FALLBACK_VOICE_MIN_BYTES = 30;

export interface TrackChunk {
	/** 1-based, contiguous. */
	index: number;
	/** Whole Ogg pages, in clear (sealing happens downstream). */
	data: Buffer;
	/** Position of the chunk's first sample inside the track. */
	startSample: number;
	samples: number;
	final: boolean;
}

interface TrackWriterOptions {
	/** Ogg bitstream serial number. */
	serial: number;
	/** Wall-clock time (ms since epoch) at which the track starts. */
	startMs: number;
	chunkSeconds?: number;
	onChunk: (chunk: TrackChunk) => void;
}

export interface TrackStats {
	packets: number;
	silenceFrames: number;
	/** Duplicates and packets older than the last one accepted. */
	late: number;
	/** Not RTP at all. */
	malformed: number;
	/** RTP whose payload is not an Opus packet. */
	invalid: number;
	/** Times the position was re-synchronised on the wall clock. */
	anchors: number;
}

export class TrackWriter {
	readonly stats: TrackStats = {
		packets: 0,
		silenceFrames: 0,
		late: 0,
		malformed: 0,
		invalid: 0,
		anchors: 0,
	};

	private readonly options: TrackWriterOptions;
	private readonly ogg: OggOpusWriter;
	private readonly chunkSamples: number;
	private position = 0;
	private run: {
		baseTimestamp: number;
		basePosition: number;
		lastSequence: number;
	} | null = null;
	private lastPacketMs: number;
	private chunkIndex = 1;
	private chunkPages: Buffer[] = [];
	private chunkStart = 0;
	private finished = false;
	private activity: Array<[number, number]> = [];
	private openActivity: [number, number] | null = null;

	constructor(options: TrackWriterOptions) {
		this.options = options;
		this.chunkSamples = Math.round(
			(options.chunkSeconds ?? 30) * OPUS_SAMPLE_RATE,
		);
		this.ogg = new OggOpusWriter({ serial: options.serial });
		this.chunkPages.push(this.ogg.headerPages());
		this.lastPacketMs = options.startMs;
	}

	/** Samples written so far (silence included). */
	get samples(): number {
		return this.position;
	}

	get isFinished(): boolean {
		return this.finished;
	}

	/**
	 * One RTP packet from the consumer. `nowMs` is the wall-clock arrival
	 * time; `audioLevelExtensionId` the id negotiated for the audio-level
	 * header extension (undefined when there is none).
	 */
	pushRtp(packet: Buffer, nowMs: number, audioLevelExtensionId?: number): void {
		if (this.finished) return;

		const rtp = parseRtp(packet, audioLevelExtensionId);
		if (!rtp) {
			this.stats.malformed++;
			return;
		}
		const samples = opusPacketSamples(rtp.payload);
		if (samples === 0) {
			this.stats.invalid++;
			return;
		}

		if (this.run) {
			const step = (rtp.sequence - this.run.lastSequence) & 0xffff;
			if (step === 0 || step >= 0x8000) {
				this.stats.late++;
				return;
			}
			const target =
				this.run.basePosition +
				((rtp.timestamp - this.run.baseTimestamp) >>> 0);
			const gap = target - this.position;
			if (gap > MAX_RTP_GAP_SAMPLES) {
				this.anchorOnWallClock(rtp.timestamp, rtp.sequence, nowMs);
			} else {
				if (gap >= SILENCE_FRAME_SAMPLES) this.fillSilence(gap);
				this.run.lastSequence = rtp.sequence;
			}
		} else {
			this.anchorOnWallClock(rtp.timestamp, rtp.sequence, nowMs);
		}

		const speaking =
			rtp.voice !== null
				? rtp.voice
				: rtp.payload.length >= FALLBACK_VOICE_MIN_BYTES;
		if (speaking) {
			this.markActive(this.position, this.position + samples);
		}

		this.lastPacketMs = nowMs;
		this.stats.packets++;
		// The packet buffer belongs to the transport: keep our own copy.
		this.append(Buffer.from(rtp.payload), samples);
	}

	/**
	 * The media source went away (microphone muted, producer closed): the
	 * next packet is placed by the wall clock, not by its RTP timestamp.
	 */
	interrupt(): void {
		this.run = null;
	}

	/** Called about once a second by the owner. */
	tick(nowMs: number): void {
		if (this.finished) return;
		if (nowMs - this.lastPacketMs < IDLE_FILL_AFTER_MS) return;
		const wallPosition = this.wallPosition(nowMs) - IDLE_FILL_SLACK_SAMPLES;
		if (wallPosition - this.position >= SILENCE_FRAME_SAMPLES) {
			this.fillSilence(wallPosition - this.position);
		}
		this.run = null;
	}

	/** Pads up to `nowMs`, writes the end-of-stream page, emits the last chunk. */
	finish(nowMs: number): void {
		if (this.finished) return;
		const wallPosition = this.wallPosition(nowMs);
		if (wallPosition - this.position >= SILENCE_FRAME_SAMPLES) {
			this.fillSilence(wallPosition - this.position);
		}
		this.closeChunk(true);
		this.finished = true;
	}

	/** Speech intervals, in milliseconds from the start of the track. */
	activityMs(): Array<[number, number]> {
		const all = this.openActivity
			? [...this.activity, this.openActivity]
			: this.activity;
		return all.map(([from, to]) => [
			Math.round(from / SAMPLES_PER_MS),
			Math.round(to / SAMPLES_PER_MS),
		]);
	}

	private wallPosition(nowMs: number): number {
		return Math.round((nowMs - this.options.startMs) * SAMPLES_PER_MS);
	}

	private anchorOnWallClock(
		timestamp: number,
		sequence: number,
		nowMs: number,
	): void {
		const wallPosition = this.wallPosition(nowMs);
		if (wallPosition - this.position >= SILENCE_FRAME_SAMPLES) {
			this.fillSilence(wallPosition - this.position);
		}
		this.run = {
			baseTimestamp: timestamp,
			basePosition: this.position,
			lastSequence: sequence,
		};
		this.stats.anchors++;
	}

	private fillSilence(samples: number): void {
		const frames = Math.min(
			Math.floor(samples / SILENCE_FRAME_SAMPLES),
			MAX_FILL_FRAMES,
		);
		for (let i = 0; i < frames; i++) {
			this.append(OPUS_SILENCE_20MS, SILENCE_FRAME_SAMPLES);
		}
		this.stats.silenceFrames += frames;
	}

	private markActive(from: number, to: number): void {
		if (
			this.openActivity &&
			from - this.openActivity[1] <= ACTIVITY_MERGE_GAP_SAMPLES
		) {
			this.openActivity[1] = to;
			return;
		}
		if (this.openActivity) this.activity.push(this.openActivity);
		this.openActivity = [from, to];
	}

	private append(packet: Buffer, samples: number): void {
		for (const page of this.ogg.addPacket(packet, samples)) {
			this.chunkPages.push(page);
		}
		this.position += samples;
		if (this.position - this.chunkStart >= this.chunkSamples) {
			this.closeChunk(false);
		}
	}

	private closeChunk(final: boolean): void {
		const tail = final ? this.ogg.end() : this.ogg.flush();
		if (tail) this.chunkPages.push(tail);
		if (this.chunkPages.length === 0) return;

		const chunk: TrackChunk = {
			index: this.chunkIndex++,
			data: Buffer.concat(this.chunkPages),
			startSample: this.chunkStart,
			samples: this.position - this.chunkStart,
			final,
		};
		this.chunkPages = [];
		this.chunkStart = this.position;
		this.options.onChunk(chunk);
	}
}
