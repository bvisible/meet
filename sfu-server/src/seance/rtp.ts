// //// Neoffice — added file (no upstream equivalent)
// Séance note-taking: just enough RTP parsing (RFC 3550, RFC 6464) to pull the
// Opus payload and the "is somebody speaking" flag out of a packet.

import type { Buffer } from 'node:buffer';

interface ParsedRtp {
	payloadType: number;
	marker: boolean;
	sequence: number;
	timestamp: number;
	ssrc: number;
	payload: Buffer;
	/** Level in -dBov (0 = loudest, 127 = silence), when the extension is there. */
	audioLevel: number | null;
	/** Voice-activity flag of the audio-level extension, when it is there. */
	voice: boolean | null;
}

const RTP_FIXED_HEADER = 12;

/**
 * Parses one RTP packet. `audioLevelExtensionId` is the id negotiated for
 * urn:ietf:params:rtp-hdrext:ssrc-audio-level (read from the consumer's
 * rtpParameters). Returns null for anything that is not a well-formed packet.
 */
export function parseRtp(
	packet: Buffer,
	audioLevelExtensionId?: number,
): ParsedRtp | null {
	if (packet.length < RTP_FIXED_HEADER) return null;
	if (packet[0] >> 6 !== 2) return null;

	const padding = (packet[0] & 0x20) !== 0;
	const extension = (packet[0] & 0x10) !== 0;
	const csrcCount = packet[0] & 0x0f;
	let offset = RTP_FIXED_HEADER + csrcCount * 4;
	if (packet.length < offset) return null;

	let audioLevel: number | null = null;
	let voice: boolean | null = null;

	if (extension) {
		if (packet.length < offset + 4) return null;
		const profile = packet.readUInt16BE(offset);
		const words = packet.readUInt16BE(offset + 2);
		const start = offset + 4;
		const end = start + words * 4;
		if (packet.length < end) return null;

		if (audioLevelExtensionId !== undefined) {
			let cursor = start;
			if (profile === 0xbede) {
				// One-byte header: [id:4 | len-1:4] then len bytes.
				while (cursor < end) {
					const head = packet[cursor];
					if (head === 0) {
						cursor += 1; // padding
						continue;
					}
					const id = head >> 4;
					if (id === 15) break;
					const length = (head & 0x0f) + 1;
					if (cursor + 1 + length > end) break;
					if (id === audioLevelExtensionId) {
						const value = packet[cursor + 1];
						voice = (value & 0x80) !== 0;
						audioLevel = value & 0x7f;
					}
					cursor += 1 + length;
				}
			} else if ((profile & 0xfff0) === 0x1000) {
				// Two-byte header: [id:8][len:8] then len bytes.
				while (cursor + 1 < end) {
					const id = packet[cursor];
					if (id === 0) {
						cursor += 1; // padding
						continue;
					}
					const length = packet[cursor + 1];
					if (cursor + 2 + length > end) break;
					if (id === audioLevelExtensionId && length >= 1) {
						const value = packet[cursor + 2];
						voice = (value & 0x80) !== 0;
						audioLevel = value & 0x7f;
					}
					cursor += 2 + length;
				}
			}
		}
		offset = end;
	}

	let payloadEnd = packet.length;
	if (padding) {
		const padLength = packet[packet.length - 1];
		if (padLength === 0 || padLength > packet.length - offset) return null;
		payloadEnd -= padLength;
	}
	if (payloadEnd <= offset) return null;

	return {
		payloadType: packet[1] & 0x7f,
		marker: (packet[1] & 0x80) !== 0,
		sequence: packet.readUInt16BE(2),
		timestamp: packet.readUInt32BE(4),
		ssrc: packet.readUInt32BE(8),
		payload: packet.subarray(offset, payloadEnd),
		audioLevel,
		voice,
	};
}
