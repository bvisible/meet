// //// Neoffice — added file (no upstream equivalent)
// Shared helpers of the séance tests.

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readOggPages } from '../oggOpus';

export const AUDIO_LEVEL_EXTENSION_ID = 6;

let ffmpegChecked: boolean | null = null;

/** True when ffmpeg and ffprobe can be run (the audio-level tests need them). */
export function ffmpegAvailable(): boolean {
	if (ffmpegChecked === null) {
		const a = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		const b = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
		ffmpegChecked = a.status === 0 && b.status === 0;
	}
	return ffmpegChecked;
}

interface RtpOptions {
	sequence: number;
	timestamp: number;
	payload: Buffer;
	ssrc?: number;
	payloadType?: number;
	marker?: boolean;
	/** Audio-level extension: value 0..127 and the voice flag. */
	level?: { value: number; voice: boolean; id?: number; twoByte?: boolean };
	csrcCount?: number;
	padding?: number;
	/** One-byte header extension elements put BEFORE the audio level: [id, bytes]. */
	otherElements?: Array<[number, Buffer]>;
}

export function rtpPacket(options: RtpOptions): Buffer {
	const csrcCount = options.csrcCount ?? 0;
	const hasExtension =
		options.level !== undefined || !!options.otherElements?.length;
	const fixed = Buffer.alloc(12 + csrcCount * 4);
	fixed[0] =
		0x80 | (options.padding ? 0x20 : 0) | (hasExtension ? 0x10 : 0) | csrcCount;
	fixed[1] = (options.marker ? 0x80 : 0) | (options.payloadType ?? 111);
	fixed.writeUInt16BE(options.sequence & 0xffff, 2);
	fixed.writeUInt32BE(options.timestamp >>> 0, 4);
	fixed.writeUInt32BE((options.ssrc ?? 0x1234abcd) >>> 0, 8);

	const parts: Buffer[] = [fixed];
	if (hasExtension) {
		const level = options.level;
		const id = level?.id ?? AUDIO_LEVEL_EXTENSION_ID;
		const value = level ? (level.voice ? 0x80 : 0) | (level.value & 0x7f) : 0;
		if (level?.twoByte) {
			// profile 0x1000, one 32-bit word: [id][len=1][value][pad]
			parts.push(Buffer.from([0x10, 0x00, 0x00, 0x01, id, 1, value, 0]));
		} else {
			// profile 0xBEDE: other elements first, then the audio level, padded
			const body: number[] = [];
			for (const [otherId, bytes] of options.otherElements ?? []) {
				body.push((otherId << 4) | (bytes.length - 1), ...bytes);
			}
			if (level) body.push((id << 4) | 0, value);
			while (body.length % 4 !== 0) body.push(0);
			parts.push(Buffer.from([0xbe, 0xde, 0x00, body.length / 4, ...body]));
		}
	}
	parts.push(options.payload);
	if (options.padding) {
		const pad = Buffer.alloc(options.padding);
		pad[pad.length - 1] = options.padding;
		parts.push(pad);
	}
	return Buffer.concat(parts);
}

/**
 * Real Opus packets (20 ms each), made with ffmpeg: a sine sweep so that
 * successive packets differ. The first two Ogg packets (headers) are dropped.
 */
export function realOpusPackets(seconds: number, frequency = 330): Buffer[] {
	const result = spawnSync(
		'ffmpeg',
		[
			'-hide_banner',
			'-loglevel',
			'error',
			'-f',
			'lavfi',
			'-i',
			`sine=frequency=${frequency}:sample_rate=48000:duration=${seconds}`,
			'-af',
			'volume=0.5',
			'-c:a',
			'libopus',
			'-b:a',
			'24k',
			'-application',
			'voip',
			'-frame_duration',
			'20',
			'-ac',
			'1',
			'-f',
			'ogg',
			'-',
		],
		{ maxBuffer: 64 * 1024 * 1024 },
	);
	if (result.status !== 0) {
		throw new Error(`ffmpeg failed: ${result.stderr?.toString()}`);
	}
	const pages = readOggPages(result.stdout);
	return pages.flatMap((page) => page.packets).slice(2);
}

/** Duration, in seconds, of an Ogg file (ffprobe needs a seekable file). */
export function probeDuration(ogg: Buffer): number {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seance-probe-'));
	const file = path.join(dir, 'probe.ogg');
	try {
		fs.writeFileSync(file, ogg);
		const result = spawnSync(
			'ffprobe',
			[
				'-v',
				'error',
				'-show_entries',
				'format=duration',
				'-of',
				'default=nw=1:nk=1',
				file,
			],
			{ encoding: 'utf8' },
		);
		if (result.status !== 0) {
			throw new Error(`ffprobe failed: ${result.stderr}`);
		}
		return Number(result.stdout.trim());
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Decodes an Ogg/Opus buffer to signed 16-bit mono PCM at 48 kHz. */
export function decodePcm(ogg: Buffer): Int16Array {
	const result = spawnSync(
		'ffmpeg',
		[
			'-v',
			'error',
			'-f',
			'ogg',
			'-i',
			'pipe:0',
			'-f',
			's16le',
			'-ac',
			'1',
			'-ar',
			'48000',
			'pipe:1',
		],
		{ input: ogg, maxBuffer: 256 * 1024 * 1024 },
	);
	if (result.status !== 0) {
		throw new Error(`ffmpeg decode failed: ${result.stderr?.toString()}`);
	}
	const out = result.stdout;
	return new Int16Array(
		out.buffer.slice(
			out.byteOffset,
			out.byteOffset + out.length - (out.length % 2),
		),
	);
}

/** Dominant frequency (Hz) of a window of a pure tone, by its zero crossings. */
export function toneFrequency(
	pcm: Int16Array,
	fromSample: number,
	toSample: number,
): number {
	let crossings = 0;
	const end = Math.min(toSample, pcm.length);
	for (let i = fromSample + 1; i < end; i++) {
		if (pcm[i - 1] < 0 !== pcm[i] < 0) crossings++;
	}
	return (crossings / 2) * (48000 / Math.max(1, end - fromSample));
}

/** Root-mean-square of a window of PCM, in 0..1. */
export function rms(
	pcm: Int16Array,
	fromSample: number,
	toSample: number,
): number {
	let sum = 0;
	const end = Math.min(toSample, pcm.length);
	for (let i = fromSample; i < end; i++) sum += (pcm[i] / 32768) ** 2;
	return Math.sqrt(sum / Math.max(1, end - fromSample));
}
