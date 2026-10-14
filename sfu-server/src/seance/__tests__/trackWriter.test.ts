// //// Neoffice — added file (no upstream equivalent)
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';
import {
	OGG_FLAG_BOS,
	OGG_FLAG_EOS,
	opusPacketSamples,
	readOggPages,
} from '../oggOpus';
import { type TrackChunk, TrackWriter } from '../trackWriter';
import {
	AUDIO_LEVEL_EXTENSION_ID,
	decodePcm,
	ffmpegAvailable,
	realOpusPackets,
	rms,
	rtpPacket,
} from './helpers';

const START = 1_700_000_000_000; // wall clock of the track start
// A 20 ms Opus packet with some content (the writer never decodes).
const SPEECH = Buffer.concat([Buffer.from([0xf8]), Buffer.alloc(60, 0x5a)]);

function makeWriter(chunkSeconds = 30) {
	const chunks: TrackChunk[] = [];
	const writer = new TrackWriter({
		serial: 42,
		startMs: START,
		chunkSeconds,
		onChunk: (c) => chunks.push(c),
	});
	return { writer, chunks };
}

interface Feed {
	sequence?: number;
	timestamp?: number;
	count: number;
	wallMs?: number;
	skip?: number[]; // indexes not to send (lost packets)
	voice?: boolean | null;
	payload?: Buffer;
	ssrc?: number;
}

/** Sends `count` packets 20 ms apart; returns where the next one would be. */
function feed(writer: TrackWriter, f: Feed) {
	let sequence = f.sequence ?? 100;
	let timestamp = f.timestamp ?? 1000;
	let wall = f.wallMs ?? START;
	for (let i = 0; i < f.count; i++) {
		if (!f.skip?.includes(i)) {
			const level =
				f.voice === undefined || f.voice === null
					? undefined
					: { value: 30, voice: f.voice };
			writer.pushRtp(
				rtpPacket({
					sequence,
					timestamp,
					payload: f.payload ?? SPEECH,
					ssrc: f.ssrc,
					level,
				}),
				wall,
				AUDIO_LEVEL_EXTENSION_ID,
			);
		}
		sequence = (sequence + 1) & 0xffff;
		timestamp = (timestamp + 960) >>> 0;
		wall += 20;
	}
	return { sequence, timestamp, wallMs: wall };
}

function wholeStream(chunks: TrackChunk[]): Buffer {
	return Buffer.concat(chunks.map((c) => c.data));
}

/** The shape of a stream: 'S' for a packet of speech, '.' for a silence frame. */
function shape(chunks: TrackChunk[]): string {
	return readOggPages(wholeStream(chunks))
		.slice(2)
		.flatMap((page) => page.packets)
		.map((packet) => (packet.equals(SPEECH) ? 'S' : '.'))
		.join('');
}

/** 'S' x 3 then '.' x 2 ... as a run-length string: "S3.2". */
function runs(text: string): string {
	return text.replace(/(.)\1*/g, (run) => `${run[0]}${run.length}`);
}

describe('TrackWriter', () => {
	it('keeps every packet of a continuous stream, with no silence added', () => {
		const { writer, chunks } = makeWriter();
		feed(writer, { count: 200 });
		writer.finish(START + 200 * 20);

		assert.equal(writer.samples, 200 * 960);
		assert.equal(writer.stats.packets, 200);
		assert.equal(writer.stats.silenceFrames, 0);
		const pages = readOggPages(wholeStream(chunks));
		const audio = pages.slice(2).flatMap((p) => p.packets);
		assert.equal(audio.length, 200);
		assert.ok(audio.every((p) => p.equals(SPEECH)));
		assert.equal(pages[pages.length - 1].granule, BigInt(200 * 960));
	});

	it('replaces lost packets by silence of the same length', () => {
		const { writer } = makeWriter();
		feed(writer, {
			count: 200,
			skip: [50, 51, 52, 53, 54, 55, 56, 57, 58, 59],
		});
		writer.finish(START + 200 * 20);

		assert.equal(writer.stats.packets, 190);
		assert.equal(writer.stats.silenceFrames, 10);
		assert.equal(writer.samples, 200 * 960, 'the timeline did not shrink');
	});

	it('fills a long hole announced by the RTP timestamp (DTX, muted microphone)', () => {
		const { writer } = makeWriter();
		const next = feed(writer, { count: 50 });
		// five seconds with nothing, sequence numbers carry on, timestamp jumps
		const after = feed(writer, {
			count: 50,
			sequence: next.sequence,
			timestamp: next.timestamp + 5 * 48000,
			wallMs: next.wallMs + 5000,
		});
		writer.finish(after.wallMs);

		assert.equal(writer.stats.silenceFrames, 250);
		assert.equal(writer.samples, (50 + 250 + 50) * 960);
	});

	it('drops duplicates and packets that arrive out of order', () => {
		const { writer } = makeWriter();
		const packet = (sequence: number, timestamp: number) =>
			rtpPacket({ sequence, timestamp, payload: SPEECH });
		writer.pushRtp(packet(10, 0), START);
		writer.pushRtp(packet(11, 960), START + 20);
		writer.pushRtp(packet(11, 960), START + 21); // duplicate
		writer.pushRtp(packet(13, 2880), START + 60); // 12 is missing
		writer.pushRtp(packet(12, 1920), START + 61); // 12 arrives late: dropped
		writer.pushRtp(packet(14, 3840), START + 80);

		assert.equal(writer.stats.late, 2);
		assert.equal(writer.stats.packets, 4);
		assert.equal(writer.stats.silenceFrames, 1);
		assert.equal(writer.samples, 5 * 960);
	});

	it('is exact across the wrap of the sequence number and of the timestamp', () => {
		const { writer } = makeWriter();
		feed(writer, {
			count: 100,
			sequence: 65500,
			timestamp: 4294967296 - 48000,
		});
		writer.finish(START + 100 * 20);
		assert.equal(writer.stats.late, 0);
		assert.equal(writer.stats.silenceFrames, 0);
		assert.equal(writer.samples, 100 * 960);
	});

	it('fills a hole that comes after the timestamp wrapped', () => {
		const { writer, chunks } = makeWriter();
		// the timestamp wraps after 20 packets; packets 60..69 are lost afterwards
		feed(writer, {
			count: 100,
			timestamp: 4294967296 - 20 * 960,
			skip: [60, 61, 62, 63, 64, 65, 66, 67, 68, 69],
		});
		writer.finish(START + 100 * 20);
		assert.equal(writer.samples, 100 * 960);
		// the silence is where the packets were lost, not at the end
		assert.equal(runs(shape(chunks)), 'S60.10S30');
	});

	it('keeps counting holes after an idle fill', () => {
		const { writer, chunks } = makeWriter();
		const next = feed(writer, { count: 25 }); // 0.5 s of speech
		// the microphone is muted for 10 s: the wall clock fills, nothing arrives
		for (let s = 1; s <= 10; s++) writer.tick(START + 500 + s * 1000);
		// it comes back with contiguous timestamps, and later loses packets
		feed(writer, {
			count: 100,
			sequence: next.sequence,
			timestamp: next.timestamp,
			wallMs: START + 10_500,
			skip: [50, 51, 52, 53, 54],
		});
		writer.finish(START + 10_500 + 100 * 20);
		const expected = ((10_500 + 100 * 20) * 48) / 960;
		assert.ok(
			Math.abs(writer.samples / 960 - expected) <= 2,
			`position ${writer.samples / 960} frames vs ${expected}`,
		);
		// the five lost packets are silence IN THE MIDDLE of the second burst
		const text = runs(shape(chunks));
		assert.ok(text.startsWith('S25.'), text);
		assert.ok(text.endsWith('S50.5S45'), text);
	});

	it('does not lose its place while the media keeps coming', () => {
		const { writer } = makeWriter();
		let next = { sequence: 100, timestamp: 1000, wallMs: START };
		for (let second = 0; second < 5; second++) {
			next = feed(writer, { count: 50, ...next });
			writer.tick(next.wallMs); // the owner ticks once a second
		}
		assert.equal(writer.stats.anchors, 1, 'one anchor, at the beginning');
		assert.equal(writer.stats.silenceFrames, 0);
		assert.equal(writer.samples, 250 * 960);
	});

	it('places the media by the wall clock after an interruption', () => {
		const { writer } = makeWriter();
		feed(writer, { count: 50 }); // 1 s of speech
		writer.interrupt();
		// two seconds pass, then a packet whose timestamp has nothing to do with the old ones
		feed(writer, {
			count: 50,
			sequence: 9000,
			timestamp: 123456,
			wallMs: START + 50 * 20 + 2000,
		});
		writer.finish(START + 50 * 20 + 2000 + 1000);

		assert.equal(
			writer.stats.anchors,
			2,
			'one at the start, one after the pause',
		);
		assert.equal(writer.stats.silenceFrames, 100, 'the two silent seconds');
		assert.equal(writer.samples, (50 + 100 + 50) * 960);
	});

	it('keeps the timeline moving by itself while nothing arrives', () => {
		const { writer } = makeWriter();
		feed(writer, { count: 25 }); // 0.5 s
		// nothing for 10 s: one tick per second
		for (let s = 1; s <= 10; s++) writer.tick(START + 500 + s * 1000);
		// it stays ~100 ms behind the wall clock so that late media still fits
		const expected = Math.floor(((10_500 - 100) * 48) / 960) * 960;
		assert.ok(
			Math.abs(writer.samples - expected) <= 2 * 960,
			`position ${writer.samples} vs ~${expected}`,
		);

		// the person comes back: no double counting
		feed(writer, {
			count: 50,
			sequence: 500,
			timestamp: 77777,
			wallMs: START + 10_500,
		});
		writer.finish(START + 11_500);
		assert.ok(
			Math.abs(writer.samples - 11_500 * 48) <= 2 * 960,
			`final position ${writer.samples} vs ${11_500 * 48}`,
		);
	});

	it('does not trust a timestamp that jumps by more than a minute', () => {
		const { writer } = makeWriter();
		feed(writer, { count: 50 });
		feed(writer, {
			count: 50,
			sequence: 150,
			timestamp: 1000 + 50 * 960 + 10 * 60 * 48000, // ten minutes ahead
			wallMs: START + 1000, // but only one second later on the wall clock
		});
		writer.finish(START + 2000);
		assert.ok(
			Math.abs(writer.samples - 2000 * 48) <= 2 * 960,
			`position ${writer.samples}`,
		);
	});

	it('pads up to the end time when the track is finished', () => {
		const { writer } = makeWriter();
		feed(writer, { count: 50 });
		writer.finish(START + 5000);
		assert.equal(writer.samples, 5000 * 48);
		assert.equal(writer.isFinished, true);
		// finishing twice, or feeding afterwards, changes nothing
		writer.finish(START + 9000);
		feed(writer, {
			count: 5,
			sequence: 500,
			timestamp: 5000,
			wallMs: START + 6000,
		});
		assert.equal(writer.samples, 5000 * 48);
	});

	it('cuts chunks of about the requested length, contiguous, whole pages', () => {
		const { writer, chunks } = makeWriter(1); // 1 s chunks
		feed(writer, { count: 275 }); // 5.5 s
		writer.finish(START + 275 * 20);

		assert.equal(chunks.length, 6);
		assert.deepEqual(
			chunks.map((c) => c.index),
			[1, 2, 3, 4, 5, 6],
		);
		assert.equal(chunks[0].startSample, 0);
		for (let i = 1; i < chunks.length; i++) {
			assert.equal(
				chunks[i].startSample,
				chunks[i - 1].startSample + chunks[i - 1].samples,
				'no gap, no overlap',
			);
		}
		assert.deepEqual(
			chunks.map((c) => c.final),
			[false, false, false, false, false, true],
		);
		assert.ok(chunks.slice(0, 5).every((c) => c.samples >= 48000));
		assert.equal(
			chunks.reduce((n, c) => n + c.samples, 0),
			275 * 960,
		);

		// each chunk is a run of whole, valid pages …
		for (const chunk of chunks) {
			assert.ok(readOggPages(chunk.data).every((p) => p.checksumOk));
		}
		// … and end to end they are ONE stream
		const pages = readOggPages(wholeStream(chunks));
		assert.equal(pages[0].flags & OGG_FLAG_BOS, OGG_FLAG_BOS);
		assert.deepEqual(
			pages.map((p) => p.sequence),
			pages.map((_, i) => i),
			'page sequence numbers carry on from one chunk to the next',
		);
		assert.equal(
			pages.filter((p) => p.flags & OGG_FLAG_EOS).length,
			1,
			'a single end of stream',
		);
		assert.equal(pages[pages.length - 1].granule, BigInt(275 * 960));
	});

	it('writes a valid silent stream for a person who never spoke', () => {
		const { writer, chunks } = makeWriter();
		writer.finish(START + 3000);
		const pages = readOggPages(wholeStream(chunks));
		assert.equal(chunks.length, 1);
		assert.equal(pages[0].packets[0].toString('ascii', 0, 8), 'OpusHead');
		assert.equal(pages[pages.length - 1].granule, BigInt(3000 * 48));
		assert.equal(writer.stats.silenceFrames, 150);
	});

	it('records speech intervals from the voice flag, and merges short pauses', () => {
		const { writer } = makeWriter();
		// 0.0–0.4 s speech, 0.2 s pause (merged), 0.6–1.0 s speech,
		// 2 s silence, 3.0–3.2 s speech
		let t = feed(writer, { count: 20, voice: true });
		t = feed(writer, { count: 10, voice: false, ...t });
		t = feed(writer, { count: 20, voice: true, ...t });
		t = feed(writer, { count: 100, voice: false, ...t });
		t = feed(writer, { count: 10, voice: true, ...t });
		writer.finish(t.wallMs);

		assert.deepEqual(writer.activityMs(), [
			[0, 1000],
			[3000, 3200],
		]);
	});

	it('falls back on the packet size when there is no audio-level extension', () => {
		const { writer } = makeWriter();
		const speech = Buffer.concat([Buffer.from([0xf8]), Buffer.alloc(80, 1)]);
		const comfortNoise = Buffer.from([0xf8, 0xff, 0xfe]);
		let t = feed(writer, { count: 10, payload: comfortNoise });
		t = feed(writer, { count: 10, payload: speech, ...t });
		feed(writer, { count: 10, payload: comfortNoise, ...t });
		writer.finish(START + 600);
		assert.deepEqual(writer.activityMs(), [[200, 400]]);
	});

	it('counts what it cannot use, and never throws on it', () => {
		const { writer } = makeWriter();
		writer.pushRtp(Buffer.alloc(3), START);
		writer.pushRtp(
			rtpPacket({ sequence: 1, timestamp: 1, payload: Buffer.from([0xfb]) }), // code 3, no count
			START,
		);
		assert.equal(writer.stats.malformed, 1);
		assert.equal(writer.stats.invalid, 1);
		assert.equal(writer.samples, 0);
	});

	it('copies the payload: the transport may reuse its buffer', () => {
		const { writer, chunks } = makeWriter();
		const packet = rtpPacket({ sequence: 1, timestamp: 1, payload: SPEECH });
		writer.pushRtp(packet, START);
		packet.fill(0); // the buffer is reused by the transport
		writer.finish(START + 20);
		const audio = readOggPages(wholeStream(chunks))
			.slice(2)
			.flatMap((p) => p.packets);
		assert.ok(audio[0].equals(SPEECH));
	});

	it('produces a stream ffmpeg decodes with the sound where it belongs', (t) => {
		if (!ffmpegAvailable()) return t.skip('ffmpeg is not installed');
		const real = realOpusPackets(1); // 1 s of tone
		const { writer, chunks } = makeWriter(1);
		let sequence = 1;
		let timestamp = 0;
		let wall = START;
		// one second of silence first (nobody has spoken yet), then the tone
		wall += 1000;
		for (const payload of real) {
			writer.pushRtp(rtpPacket({ sequence, timestamp, payload }), wall);
			sequence++;
			timestamp += 960;
			wall += 20;
		}
		writer.finish(wall + 1000);

		const pcm = decodePcm(wholeStream(chunks));
		assert.ok(Math.abs(pcm.length - (wall + 1000 - START) * 48) < 3 * 960);
		assert.ok(rms(pcm, 0, 40000) < 0.001, 'silence before the sound');
		assert.ok(
			rms(pcm, 52000, 90000) > 0.03,
			'the sound is where it was spoken',
		);
		assert.ok(
			rms(pcm, pcm.length - 40000, pcm.length) < 0.001,
			'silence after',
		);
		// the Opus packets were not touched
		const kept = readOggPages(wholeStream(chunks))
			.slice(2)
			.flatMap((p) => p.packets)
			.filter((p) => opusPacketSamples(p) > 0 && p.length > 10);
		assert.equal(kept.length, real.length);
	});
});
