// //// Neoffice — added file (no upstream equivalent)
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import {
	OGG_FLAG_BOS,
	OGG_FLAG_EOS,
	OggOpusWriter,
	OPUS_SILENCE_20MS,
	oggCrc,
	opusPacketSamples,
	readOggPages,
	SILENCE_FRAME_SAMPLES,
} from '../oggOpus';
import {
	decodePcm,
	ffmpegAvailable,
	probeDuration,
	realOpusPackets,
	rms,
} from './helpers';

describe('opusPacketSamples', () => {
	it('reads the frame size of a CELT-only packet', () => {
		assert.equal(opusPacketSamples(Buffer.from([0xf8, 0xff, 0xfe])), 960); // 20 ms
		assert.equal(opusPacketSamples(Buffer.from([0xf0, 0xff, 0xfe])), 480); // 10 ms
		assert.equal(opusPacketSamples(Buffer.from([0xe8, 0xff, 0xfe])), 240); // 5 ms
		assert.equal(opusPacketSamples(Buffer.from([0xe0, 0xff, 0xfe])), 120); // 2.5 ms
	});

	it('reads the frame size of SILK-only and hybrid packets', () => {
		assert.equal(opusPacketSamples(Buffer.from([0x08, 0x00])), 960); // SILK 20 ms
		assert.equal(opusPacketSamples(Buffer.from([0x00, 0x00])), 480); // SILK 10 ms
		assert.equal(opusPacketSamples(Buffer.from([0x10, 0x00])), 1920); // SILK 40 ms
		assert.equal(opusPacketSamples(Buffer.from([0x18, 0x00])), 2880); // SILK 60 ms
		assert.equal(opusPacketSamples(Buffer.from([0x68, 0x00])), 960); // hybrid 20 ms
		assert.equal(opusPacketSamples(Buffer.from([0x60, 0x00])), 480); // hybrid 10 ms
	});

	it('counts several frames per packet', () => {
		// code 1 and 2: two frames
		assert.equal(opusPacketSamples(Buffer.from([0xf9, 0, 0])), 1920);
		assert.equal(opusPacketSamples(Buffer.from([0xfa, 0, 0])), 1920);
		// code 3: frame count in the next byte (3 frames of 20 ms)
		assert.equal(opusPacketSamples(Buffer.from([0xfb, 0x03, 0, 0])), 2880);
	});

	it('reads the frame count of a code-3 packet, with its flag bits', () => {
		// 2.5 ms CELT frames; count byte = VBR flag (0x80) | padding flag (0x40) | count
		assert.equal(opusPacketSamples(Buffer.from([0xe3, 0x30, 0, 0])), 5760); // 48 frames
		assert.equal(opusPacketSamples(Buffer.from([0xe3, 0xa0, 0, 0])), 3840); // 32 + VBR
		assert.equal(opusPacketSamples(Buffer.from([0xe3, 0x41, 0, 0])), 120); // 1 + padding
	});

	it('refuses what is not an Opus packet', () => {
		assert.equal(opusPacketSamples(Buffer.alloc(0)), 0);
		assert.equal(opusPacketSamples(Buffer.from([0xfb])), 0); // code 3 without count
		assert.equal(opusPacketSamples(Buffer.from([0xfb, 0x00, 0])), 0); // zero frames
		// 48 frames of 20 ms = 960 ms, far above the 120 ms an Opus packet can hold
		assert.equal(opusPacketSamples(Buffer.from([0xfb, 0x30, 0])), 0);
	});
});

describe('oggCrc', () => {
	it('matches reference values (bit-by-bit computation of the Ogg CRC-32)', () => {
		assert.equal(oggCrc(Buffer.alloc(0)), 0);
		assert.equal(oggCrc(Buffer.from('OggS', 'ascii')), 0x5fb0a94f);
		assert.equal(oggCrc(Buffer.from('123456789', 'ascii')), 0x89a1897f);
	});

	it('agrees with the pages ffmpeg writes', (t) => {
		if (!ffmpegAvailable()) return t.skip('ffmpeg is not installed');
		const packets = realOpusPackets(1);
		assert.ok(packets.length > 40);
		// realOpusPackets read ffmpeg's pages through readOggPages: make the
		// checksum verdict explicit by re-reading a fresh file.
		const result = spawnSync(
			'ffmpeg',
			[
				'-v',
				'error',
				'-f',
				'lavfi',
				'-i',
				'sine=duration=1',
				'-c:a',
				'libopus',
				'-f',
				'ogg',
				'-',
			],
			{ maxBuffer: 16 * 1024 * 1024 },
		);
		const pages = readOggPages(result.stdout);
		assert.ok(pages.length > 2);
		assert.ok(pages.every((p) => p.checksumOk));
	});
});

describe('OggOpusWriter', () => {
	function stream(packets: Buffer[], samplesEach = SILENCE_FRAME_SAMPLES) {
		const writer = new OggOpusWriter({ serial: 0xdeadbeef });
		const parts: Buffer[] = [writer.headerPages()];
		for (const packet of packets) {
			for (const page of writer.addPacket(packet, samplesEach))
				parts.push(page);
		}
		parts.push(writer.end());
		return { writer, data: Buffer.concat(parts) };
	}

	it('writes OpusHead and OpusTags, then audio, then an end-of-stream page', () => {
		const { data } = stream(
			Array.from({ length: 10 }, () => OPUS_SILENCE_20MS),
		);
		const pages = readOggPages(data);

		assert.ok(
			pages.every((p) => p.checksumOk),
			'every checksum is right',
		);
		assert.ok(pages.every((p) => p.serial === 0xdeadbeef));
		assert.deepEqual(
			pages.map((p) => p.sequence),
			pages.map((_, i) => i),
			'page sequence numbers are contiguous',
		);

		assert.equal(pages[0].flags & OGG_FLAG_BOS, OGG_FLAG_BOS);
		assert.equal(pages[0].packets[0].toString('ascii', 0, 8), 'OpusHead');
		assert.equal(pages[0].packets[0][9], 1, 'mono');
		assert.equal(pages[0].packets[0].readUInt32LE(12), 48000);
		assert.equal(pages[1].packets[0].toString('ascii', 0, 8), 'OpusTags');

		const last = pages[pages.length - 1];
		assert.equal(last.flags & OGG_FLAG_EOS, OGG_FLAG_EOS);
		assert.equal(last.granule, BigInt(10 * SILENCE_FRAME_SAMPLES));
	});

	it('keeps the granule position equal to the samples written', () => {
		const { writer, data } = stream(
			[OPUS_SILENCE_20MS, OPUS_SILENCE_20MS, OPUS_SILENCE_20MS],
			960,
		);
		assert.equal(writer.position, 3 * 960);
		const audio = readOggPages(data).slice(2);
		const total = audio.reduce((n, p) => n + p.packets.length, 0);
		assert.equal(total, 3);
		assert.equal(audio[audio.length - 1].granule, BigInt(3 * 960));
	});

	it('cuts pages by size and never splits a packet', () => {
		const big = Buffer.alloc(900, 0x55);
		big[0] = 0xf8;
		const { data } = stream(Array.from({ length: 40 }, () => big));
		const pages = readOggPages(data);
		assert.ok(pages.length > 5, 'many pages');
		const audio = pages.slice(2).flatMap((p) => p.packets);
		assert.equal(audio.length, 40);
		assert.ok(audio.every((p) => p.length === 900));
		assert.ok(pages.every((p) => p.checksumOk));
	});

	it('lays out packets whose size is a multiple of 255', () => {
		const exact = Buffer.alloc(255, 0x11);
		exact[0] = 0xf8;
		const twice = Buffer.alloc(510, 0x22);
		twice[0] = 0xf8;
		const { data } = stream([exact, twice, OPUS_SILENCE_20MS]);
		const audio = readOggPages(data)
			.slice(2)
			.flatMap((p) => p.packets);
		assert.deepEqual(
			audio.map((p) => p.length),
			[255, 510, 3],
		);
	});

	it('starts a new page before exceeding 255 segments', () => {
		const packet = Buffer.alloc(1200, 0x33); // 5 segments each
		packet[0] = 0xf8;
		const writer = new OggOpusWriter({ serial: 1 });
		const parts = [writer.headerPages()];
		for (let i = 0; i < 100; i++) {
			for (const page of writer.addPacket(packet, 960)) parts.push(page);
		}
		parts.push(writer.end());
		const pages = readOggPages(Buffer.concat(parts));
		const audio = pages.slice(2).flatMap((p) => p.packets);
		assert.equal(audio.length, 100);
	});

	it('never puts more than 255 segments in a page', () => {
		const writer = new OggOpusWriter({ serial: 3 });
		const parts = [writer.headerPages()];
		for (let i = 0; i < 700; i++) {
			for (const page of writer.addPacket(OPUS_SILENCE_20MS, 960)) {
				parts.push(page);
			}
		}
		parts.push(writer.end());
		const data = Buffer.concat(parts);
		const pages = readOggPages(data); // throws on a page whose lacing is broken
		assert.ok(pages.every((p) => p.checksumOk));
		assert.equal(pages.slice(2).flatMap((p) => p.packets).length, 700);
		// 700 one-segment packets in at most 255-segment pages: three data pages at least
		assert.ok(pages.length >= 5, 'cut by the segment limit, not by size');
	});

	it('counts the terminating segment of a packet that fills its last segment', () => {
		const exact = Buffer.alloc(255, 0x44); // a 255-byte segment and a 0-byte one
		exact[0] = 0xf8;
		const writer = new OggOpusWriter({ serial: 4 });
		const parts = [writer.headerPages()];
		for (let i = 0; i < 300; i++) {
			for (const page of writer.addPacket(exact, 960)) parts.push(page);
		}
		parts.push(writer.end());
		const pages = readOggPages(Buffer.concat(parts)); // throws on a broken page
		assert.ok(pages.every((p) => p.checksumOk));
		assert.equal(pages.slice(2).flatMap((p) => p.packets).length, 300);
	});

	it('keeps the granule position in step with packets of any duration', () => {
		const writer = new OggOpusWriter({ serial: 5 });
		const parts = [writer.headerPages()];
		let total = 0;
		for (const size of [480, 960, 2880, 120, 1920]) {
			total += size;
			for (const page of writer.addPacket(OPUS_SILENCE_20MS, size)) {
				parts.push(page);
			}
		}
		assert.equal(writer.position, total);
		parts.push(writer.end());
		const pages = readOggPages(Buffer.concat(parts));
		assert.equal(pages[pages.length - 1].granule, BigInt(total));
	});

	it('flags a page whose bytes were altered', () => {
		const writer = new OggOpusWriter({ serial: 6 });
		const data = Buffer.concat([writer.headerPages(), writer.end()]);
		assert.ok(readOggPages(data).every((p) => p.checksumOk));
		const damaged = Buffer.from(data);
		damaged[40] ^= 0xff;
		assert.ok(readOggPages(damaged).some((p) => !p.checksumOk));
	});

	it('ends an empty stream with one empty end page', () => {
		const writer = new OggOpusWriter({ serial: 7 });
		const data = Buffer.concat([writer.headerPages(), writer.end()]);
		const pages = readOggPages(data);
		assert.equal(pages.length, 3);
		assert.equal(pages[2].packets.length, 0);
		assert.equal(pages[2].flags & OGG_FLAG_EOS, OGG_FLAG_EOS);
		assert.equal(pages[2].granule, 0n);
	});

	it('refuses to write after the end', () => {
		const writer = new OggOpusWriter({ serial: 1 });
		writer.headerPages();
		writer.end();
		assert.throws(() => writer.addPacket(OPUS_SILENCE_20MS, 960));
		assert.throws(() => writer.end());
		assert.throws(() => writer.headerPages());
	});

	it('produces a file ffmpeg reads, with the right duration', (t) => {
		if (!ffmpegAvailable()) return t.skip('ffmpeg is not installed');
		const real = realOpusPackets(2); // 2 s of real Opus
		assert.ok(real.length >= 95, `got ${real.length} packets`);
		const writer = new OggOpusWriter({ serial: 99 });
		const parts = [writer.headerPages()];
		for (const packet of real) {
			for (const page of writer.addPacket(packet, 960)) parts.push(page);
		}
		// one second of silence frames after the sound
		for (let i = 0; i < 50; i++) {
			for (const page of writer.addPacket(OPUS_SILENCE_20MS, 960)) {
				parts.push(page);
			}
		}
		parts.push(writer.end());
		const data = Buffer.concat(parts);

		const seconds = probeDuration(data);
		const expected = (real.length + 50) * 0.02;
		assert.ok(
			Math.abs(seconds - expected) < 0.05,
			`duration ${seconds} vs ${expected}`,
		);

		const pcm = decodePcm(data);
		const soundEnd = real.length * 960;
		assert.ok(rms(pcm, 4800, soundEnd - 4800) > 0.03, 'the sound is there');
		assert.ok(
			rms(pcm, soundEnd + 4800, pcm.length) < 0.001,
			'the silence frames decode to silence',
		);
	});
});
