// //// Neoffice — added file (no upstream equivalent)
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';
import { parseRtp } from '../rtp';
import { AUDIO_LEVEL_EXTENSION_ID, rtpPacket } from './helpers';

const payload = Buffer.from([0xf8, 0xff, 0xfe]);

describe('parseRtp', () => {
	it('reads a plain packet', () => {
		const parsed = parseRtp(
			rtpPacket({
				sequence: 65535,
				timestamp: 4294967295,
				payload,
				marker: true,
			}),
		);
		assert.ok(parsed);
		assert.equal(parsed.sequence, 65535);
		assert.equal(parsed.timestamp, 4294967295);
		assert.equal(parsed.payloadType, 111);
		assert.equal(parsed.marker, true);
		assert.deepEqual([...parsed.payload], [...payload]);
		assert.equal(parsed.audioLevel, null);
		assert.equal(parsed.voice, null);
	});

	it('reads the audio level of the one-byte header extension', () => {
		const parsed = parseRtp(
			rtpPacket({
				sequence: 1,
				timestamp: 1,
				payload,
				level: { value: 23, voice: true },
			}),
			AUDIO_LEVEL_EXTENSION_ID,
		);
		assert.ok(parsed);
		assert.equal(parsed.audioLevel, 23);
		assert.equal(parsed.voice, true);
		assert.deepEqual([...parsed.payload], [...payload]);
	});

	it('finds the audio level after other extension elements', () => {
		const parsed = parseRtp(
			rtpPacket({
				sequence: 1,
				timestamp: 1,
				payload,
				level: { value: 100, voice: true },
				// abs-send-time (3 bytes) and a one-byte element before it
				otherElements: [
					[4, Buffer.from([1, 2, 3])],
					[2, Buffer.from([9])],
				],
			}),
			AUDIO_LEVEL_EXTENSION_ID,
		);
		assert.ok(parsed);
		assert.equal(
			parsed.audioLevel,
			100,
			'a level above 63 keeps its seventh bit',
		);
		assert.equal(parsed.voice, true);
		assert.deepEqual([...parsed.payload], [...payload]);
	});

	it('reads the audio level of the two-byte header extension', () => {
		const parsed = parseRtp(
			rtpPacket({
				sequence: 1,
				timestamp: 1,
				payload,
				level: { value: 90, voice: false, twoByte: true },
			}),
			AUDIO_LEVEL_EXTENSION_ID,
		);
		assert.ok(parsed);
		assert.equal(parsed.audioLevel, 90);
		assert.equal(parsed.voice, false);
	});

	it('ignores an extension it was not asked about', () => {
		const parsed = parseRtp(
			rtpPacket({
				sequence: 1,
				timestamp: 1,
				payload,
				level: { value: 23, voice: true, id: 9 },
			}),
			AUDIO_LEVEL_EXTENSION_ID,
		);
		assert.ok(parsed);
		assert.equal(parsed.audioLevel, null);
		assert.deepEqual([...parsed.payload], [...payload]);
	});

	it('skips CSRC entries and strips padding', () => {
		const parsed = parseRtp(
			rtpPacket({
				sequence: 1,
				timestamp: 1,
				payload,
				csrcCount: 2,
				padding: 4,
			}),
		);
		assert.ok(parsed);
		assert.deepEqual([...parsed.payload], [...payload]);
	});

	it('refuses what is not a well-formed RTP packet', () => {
		assert.equal(parseRtp(Buffer.alloc(5)), null);
		const wrongVersion = rtpPacket({ sequence: 1, timestamp: 1, payload });
		wrongVersion[0] = 0x40;
		assert.equal(parseRtp(wrongVersion), null);
		// extension that claims more words than the packet holds
		const truncated = rtpPacket({
			sequence: 1,
			timestamp: 1,
			payload: Buffer.alloc(0),
			level: { value: 1, voice: false },
		});
		truncated.writeUInt16BE(40, 14);
		assert.equal(parseRtp(truncated, AUDIO_LEVEL_EXTENSION_ID), null);
		// header and nothing else: no payload
		assert.equal(
			parseRtp(
				rtpPacket({ sequence: 1, timestamp: 1, payload: Buffer.alloc(0) }),
			),
			null,
		);
		// padding count larger than the packet
		const badPadding = rtpPacket({
			sequence: 1,
			timestamp: 1,
			payload,
			padding: 4,
		});
		badPadding[badPadding.length - 1] = 200;
		assert.equal(parseRtp(badPadding), null);
	});
});
