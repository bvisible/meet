// //// Neoffice — added file (no upstream equivalent)
// Séance note-taking: a minimal Ogg/Opus (RFC 7845) muxer and reader.
//
// The SFU receives Opus packets inside RTP and keeps them as they are (no
// decoding, no re-encoding): this file only wraps them in Ogg pages so that
// any tool (ffmpeg, the transcription box) can read the result.

import { Buffer } from 'node:buffer';

export const OPUS_SAMPLE_RATE = 48000;

/** Samples (at 48 kHz) of one 20 ms Opus frame. */
export const SILENCE_FRAME_SAMPLES = 960;

/**
 * One 20 ms CELT frame that decodes to digital silence (TOC byte 0xF8 followed
 * by the range-coder bytes that set the "silence" flag). Used to fill the holes
 * of a track (muted microphone, DTX, lost packets) so that the position inside
 * the file is always the position inside the meeting.
 */
export const OPUS_SILENCE_20MS = Buffer.from([0xf8, 0xff, 0xfe]);

const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;
const MAX_PAGE_SEGMENTS = 255;
// Pages stay small so that a crash loses at most a fraction of a second.
const TARGET_PAGE_BYTES = 4000;

// Ogg CRC-32: polynomial 0x04c11db7, MSB first, initial value 0, no final xor.
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let r = (i << 24) >>> 0;
		for (let j = 0; j < 8; j++) {
			r = (r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1) >>> 0;
		}
		table[i] = r;
	}
	return table;
})();

export function oggCrc(data: Uint8Array): number {
	let crc = 0;
	for (let i = 0; i < data.length; i++) {
		crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xff) ^ data[i]]) >>> 0;
	}
	return crc >>> 0;
}

/**
 * Number of 48 kHz samples carried by one Opus packet (RFC 6716 §3.1), or 0
 * when the packet is not a well-formed Opus packet.
 */
export function opusPacketSamples(packet: Uint8Array): number {
	if (packet.length < 1) return 0;
	const toc = packet[0];

	let frame: number;
	if (toc & 0x80) {
		// CELT-only: 2.5, 5, 10 or 20 ms
		frame = (OPUS_SAMPLE_RATE << ((toc >> 3) & 3)) / 400;
	} else if ((toc & 0x60) === 0x60) {
		// Hybrid: 10 or 20 ms
		frame = toc & 0x08 ? OPUS_SAMPLE_RATE / 50 : OPUS_SAMPLE_RATE / 100;
	} else {
		// SILK-only: 10, 20, 40 or 60 ms
		const size = (toc >> 3) & 3;
		frame =
			size === 3
				? (OPUS_SAMPLE_RATE * 60) / 1000
				: (OPUS_SAMPLE_RATE << size) / 100;
	}

	let count: number;
	switch (toc & 3) {
		case 0:
			count = 1;
			break;
		case 1:
		case 2:
			count = 2;
			break;
		default:
			if (packet.length < 2) return 0;
			count = packet[1] & 0x3f;
	}

	const total = frame * count;
	// An Opus packet never holds more than 120 ms.
	if (count === 0 || total > 5760) return 0;
	return total;
}

interface OggOpusOptions {
	/** Ogg bitstream serial number (random per stream). */
	serial: number;
	/** Channel count written in OpusHead (the packets are downmixed on decode). */
	channels?: number;
	vendor?: string;
}

/**
 * Writes one logical Ogg/Opus stream. Whole Opus packets only: a packet is
 * never split across two pages, so any run of pages is cut-safe.
 */
export class OggOpusWriter {
	private readonly serial: number;
	private readonly channels: number;
	private readonly vendor: string;
	private pageSequence = 0;
	private granule = 0;
	private pending: Buffer[] = [];
	private pendingSegments = 0;
	private pendingBytes = 0;
	private pendingGranule = 0;
	private headerWritten = false;
	private ended = false;

	constructor(options: OggOpusOptions) {
		this.serial = options.serial >>> 0;
		this.channels = options.channels ?? 1;
		this.vendor = options.vendor ?? 'neoffice-seance';
	}

	/** Total samples of the packets accepted so far (the pre-skip is 0). */
	get position(): number {
		return this.granule;
	}

	/** The two header pages (OpusHead, OpusTags). Call once, first. */
	headerPages(): Buffer {
		if (this.headerWritten) {
			throw new Error('Opus header pages were already written');
		}
		this.headerWritten = true;

		const head = Buffer.alloc(19);
		head.write('OpusHead', 0, 'ascii');
		head[8] = 1; // version
		head[9] = this.channels;
		head.writeUInt16LE(0, 10); // pre-skip
		head.writeUInt32LE(OPUS_SAMPLE_RATE, 12); // input sample rate (informative)
		head.writeInt16LE(0, 16); // output gain
		head[18] = 0; // channel mapping family 0

		const vendor = Buffer.from(this.vendor, 'utf8');
		const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
		tags.write('OpusTags', 0, 'ascii');
		tags.writeUInt32LE(vendor.length, 8);
		vendor.copy(tags, 12);
		tags.writeUInt32LE(0, 12 + vendor.length); // no user comments

		return Buffer.concat([
			this.buildPage([head], 0, FLAG_BOS),
			this.buildPage([tags], 0, 0),
		]);
	}

	/**
	 * Adds one Opus packet of `samples` samples. Returns the pages that became
	 * complete (zero or one).
	 */
	addPacket(packet: Buffer, samples: number): Buffer[] {
		if (this.ended) throw new Error('Ogg stream already ended');
		const segments = Math.floor(packet.length / 255) + 1;
		const out: Buffer[] = [];

		if (
			this.pending.length > 0 &&
			this.pendingSegments + segments > MAX_PAGE_SEGMENTS
		) {
			out.push(this.flushPending(0));
		}

		this.pending.push(packet);
		this.pendingSegments += segments;
		this.pendingBytes += packet.length;
		this.granule += samples;
		this.pendingGranule = this.granule;

		if (this.pendingBytes >= TARGET_PAGE_BYTES) {
			out.push(this.flushPending(0));
		}
		return out;
	}

	/** Forces the page under construction out (null when it is empty). */
	flush(): Buffer | null {
		if (this.pending.length === 0) return null;
		return this.flushPending(0);
	}

	/** Last page of the stream (carries the end-of-stream flag). */
	end(): Buffer {
		if (this.ended) throw new Error('Ogg stream already ended');
		this.ended = true;
		return this.flushPending(FLAG_EOS);
	}

	private flushPending(flags: number): Buffer {
		const page = this.buildPage(this.pending, this.pendingGranule, flags);
		this.pending = [];
		this.pendingSegments = 0;
		this.pendingBytes = 0;
		return page;
	}

	private buildPage(packets: Buffer[], granule: number, flags: number): Buffer {
		const lacing: number[] = [];
		for (const packet of packets) {
			let remaining = packet.length;
			while (remaining >= 255) {
				lacing.push(255);
				remaining -= 255;
			}
			lacing.push(remaining);
		}

		const header = Buffer.alloc(27 + lacing.length);
		header.write('OggS', 0, 'ascii');
		header[4] = 0; // stream structure version
		header[5] = flags;
		header.writeBigInt64LE(BigInt(granule), 6);
		header.writeUInt32LE(this.serial, 14);
		header.writeUInt32LE(this.pageSequence++ >>> 0, 18);
		header.writeUInt32LE(0, 22); // checksum, filled below
		header[26] = lacing.length;
		for (let i = 0; i < lacing.length; i++) header[27 + i] = lacing[i];

		const page = Buffer.concat([header, ...packets]);
		page.writeUInt32LE(oggCrc(page), 22);
		return page;
	}
}

interface OggPage {
	flags: number;
	granule: bigint;
	serial: number;
	sequence: number;
	packets: Buffer[];
	checksumOk: boolean;
}

/**
 * Reads back a run of Ogg pages (whole packets per page, which is what
 * OggOpusWriter produces). Used by the tests and by the integrity checks.
 */
export function readOggPages(data: Buffer): OggPage[] {
	const pages: OggPage[] = [];
	let offset = 0;
	while (offset + 27 <= data.length) {
		if (data.toString('ascii', offset, offset + 4) !== 'OggS') {
			throw new Error(`Missing Ogg capture pattern at byte ${offset}`);
		}
		const flags = data[offset + 5];
		const granule = data.readBigInt64LE(offset + 6);
		const serial = data.readUInt32LE(offset + 14);
		const sequence = data.readUInt32LE(offset + 18);
		const checksum = data.readUInt32LE(offset + 22);
		const segmentCount = data[offset + 26];
		const tableStart = offset + 27;
		const bodyStart = tableStart + segmentCount;
		let bodyLength = 0;
		for (let i = 0; i < segmentCount; i++) bodyLength += data[tableStart + i];
		const end = bodyStart + bodyLength;
		if (end > data.length) throw new Error('Truncated Ogg page');

		const copy = Buffer.from(data.subarray(offset, end));
		copy.writeUInt32LE(0, 22);
		const checksumOk = oggCrc(copy) === checksum;

		const packets: Buffer[] = [];
		let cursor = bodyStart;
		let current = 0;
		let open = false;
		for (let i = 0; i < segmentCount; i++) {
			const size = data[tableStart + i];
			current += size;
			open = true;
			if (size < 255) {
				packets.push(Buffer.from(data.subarray(cursor, cursor + current)));
				cursor += current;
				current = 0;
				open = false;
			}
		}
		if (open) {
			throw new Error('Packet continued on the next page (not produced here)');
		}

		pages.push({ flags, granule, serial, sequence, packets, checksumOk });
		offset = end;
	}
	return pages;
}

export const OGG_FLAG_EOS = FLAG_EOS;
export const OGG_FLAG_BOS = FLAG_BOS;
