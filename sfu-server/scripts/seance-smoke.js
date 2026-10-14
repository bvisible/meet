// //// Neoffice — added file (no upstream equivalent)
//
// Smoke and load test of the séance note-taking module, against a RUNNING SFU
// started in development mode (NODE_ENV=development: PlainTransport allowed).
//
// It plays the part of the instance (signs the start and consent tokens with the
// shared secret, holds the RSA key and the pull key) and of N people (real
// socket.io connections, RTP over UDP into PlainTransports), then picks the
// séance up over HTTP, opens every chunk, checks it and prints a summary.
//
//   node scripts/seance-smoke.js --url http://127.0.0.1:3000 --secret <JWT_SECRET> \
//        --people 8 --seconds 30 [--audio sample.ogg]
//
// Exit code 0 only when every person's track came back whole and readable.

const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const { io } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
	.option('url', { type: 'string', default: 'http://127.0.0.1:3000' })
	.option('secret', { type: 'string', default: process.env.JWT_SECRET })
	.option('people', { type: 'number', default: 4 })
	.option('seconds', { type: 'number', default: 20 })
	.option('tenant', { type: 'string', default: 'smoke.example' })
	.option('meeting', { type: 'string', default: `smoke-${Date.now()}` })
	.option('audio', {
		type: 'string',
		describe: 'Ogg/Opus file to play (default: made-up speech-sized packets)',
	})
	.option('plain', {
		type: 'boolean',
		default: false,
		describe: 'start without an encryption key (SEANCE_ALLOW_PLAINTEXT=1 on the SFU)',
	})
	.help().argv;

if (!argv.secret) {
	console.error('A secret is required (--secret or JWT_SECRET).');
	process.exit(2);
}

const SECRET = argv.secret;
const AUDIENCE = 'neoffice-seance';
const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---- the instance's side -----------------------------------------------------------

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
	modulusLength: 3072,
});
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const pullKey = crypto.randomBytes(32).toString('base64url');
const pullKeyHash = crypto.createHash('sha256').update(pullKey).digest('hex');
const seanceId = `SMOKE-${Date.now()}`;
const handle = crypto
	.createHash('sha256')
	.update(`${argv.tenant}\n${seanceId}`)
	.digest('hex')
	.slice(0, 32);

function signSeance(type, claims) {
	return jwt.sign(
		{
			aud: AUDIENCE,
			scope: 'seance',
			tenant: argv.tenant,
			meeting_id: argv.meeting,
			seance_id: seanceId,
			jti: crypto.randomUUID(),
			iat: nowSeconds(),
			exp: nowSeconds() + 120,
			...claims,
		},
		SECRET,
		{ algorithm: 'HS256', header: { alg: 'HS256', typ: type } },
	);
}

function connectionToken(userId, name, isHost) {
	return jwt.sign(
		{
			user_id: userId,
			user_name: name,
			meeting_id: argv.meeting,
			tenant: argv.tenant,
			scope: 'full',
			is_host: isHost,
			iat: nowSeconds(),
			exp: nowSeconds() + 3600,
		},
		SECRET,
		{ algorithm: 'HS256' },
	);
}

function openChunk(sealed, aad) {
	const wrappedLength = sealed.readUInt16BE(4);
	const wrapped = sealed.subarray(6, 6 + wrappedLength);
	const iv = sealed.subarray(6 + wrappedLength, 18 + wrappedLength);
	const body = sealed.subarray(18 + wrappedLength, sealed.length - 16);
	const tag = sealed.subarray(sealed.length - 16);
	const dataKey = crypto.privateDecrypt(
		{ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
		wrapped,
	);
	const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
	decipher.setAAD(Buffer.from(aad, 'utf8'));
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(body), decipher.final()]);
}

// ---- audio ---------------------------------------------------------------------------

function loadPackets() {
	if (argv.audio) {
		const { readOggPages } = require('../dist/sfu-server/src/seance/oggOpus');
		return readOggPages(fs.readFileSync(argv.audio))
			.flatMap((page) => page.packets)
			.slice(2);
	}
	// speech-sized CELT 20 ms packets: valid TOC, arbitrary body
	const packets = [];
	for (let i = 0; i < 50; i++) {
		const packet = crypto.randomBytes(60 + (i % 30));
		packet[0] = 0xf8;
		packets.push(packet);
	}
	return packets;
}

// ---- people ----------------------------------------------------------------------------

function ack(socket, event, data) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no answer to ${event}`)), 10000);
		socket.emit(event, data, (response) => {
			clearTimeout(timer);
			resolve(response);
		});
	});
}

async function join(userId, name, isHost) {
	const socket = io(argv.url, {
		auth: { token: connectionToken(userId, name, isHost) },
		transports: ['websocket'],
		reconnection: false,
	});
	await new Promise((resolve, reject) => {
		socket.once('connect', resolve);
		socket.once('connect_error', reject);
	});
	const joined = await ack(socket, 'join_room', {
		roomId: argv.meeting,
		userData: { name, userId, is_guest: false },
		mediaState: { audio_enabled: true, video_enabled: false },
	});
	if (!joined.success) throw new Error(`join_room: ${joined.error}`);
	return socket;
}

async function microphone(socket) {
	const transport = await ack(socket, 'create_plain_transport', {});
	if (!transport.success) throw new Error(`plain transport: ${transport.error}`);
	const ssrc = crypto.randomInt(1000, 2 ** 31);
	const producer = await ack(socket, 'create_producer', {
		transportId: transport.id,
		kind: 'audio',
		rtpParameters: {
			codecs: [
				{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2, parameters: {} },
			],
			encodings: [{ ssrc }],
			headerExtensions: [{ uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level', id: 1 }],
		},
		appData: {},
	});
	if (!producer.success) throw new Error(`producer: ${producer.error}`);
	return { port: transport.port, ssrc };
}

function rtp(sequence, timestamp, ssrc, payload) {
	// 12-byte header + one-byte extension carrying the audio level (id 1, voice)
	const header = Buffer.alloc(20);
	header[0] = 0x90;
	header[1] = 111;
	header.writeUInt16BE(sequence & 0xffff, 2);
	header.writeUInt32BE(timestamp >>> 0, 4);
	header.writeUInt32BE(ssrc >>> 0, 8);
	header.writeUInt16BE(0xbede, 12);
	header.writeUInt16BE(1, 14);
	header[16] = 0x10; // id 1, length 1
	header[17] = 0x80 | 25; // voice, 25 dBov
	return Buffer.concat([header, payload]);
}

async function main() {
	const packets = loadPackets();
	const names = Array.from({ length: argv.people }, (_, i) => ({
		id: `person${i + 1}@${argv.tenant}`,
		name: `Person ${i + 1}`,
	}));

	const host = await join(`host@${argv.tenant}`, 'Host', true);
	const people = [];
	for (const person of names) {
		const socket = await join(person.id, person.name, false);
		const media = await microphone(socket);
		people.push({ ...person, socket, ...media, sender: dgram.createSocket('udp4') });
	}

	const started = await ack(host, 'seance:start', {
		token: signSeance('neoffice-seance-start+jwt', {
			host_user_id: `host@${argv.tenant}`,
			pull_key_hash: pullKeyHash,
			...(argv.plain ? {} : { enc_key: publicPem }),
		}),
	});
	if (!started.success) throw new Error(`seance:start refused: ${started.error}`);

	for (const person of people) {
		const answer = await ack(person.socket, 'seance:consent', {
			token: signSeance('neoffice-seance-consent+jwt', {
				user_id: person.id,
				consent_at: new Date().toISOString(),
			}),
		});
		if (!answer.success) throw new Error(`seance:consent refused: ${answer.error}`);
	}

	console.log(
		`séance ${seanceId} started, ${people.length} people captured, talking for ${argv.seconds} s`,
	);

	// Everybody talks at once, 20 ms apart.
	const total = Math.round((argv.seconds * 1000) / 20);
	const started_at = Date.now();
	await Promise.all(
		people.map(async (person, index) => {
			let sequence = 1;
			let timestamp = 1000;
			for (let i = 0; i < total; i++) {
				const wait = started_at + i * 20 - Date.now();
				if (wait > 0) await new Promise((r) => setTimeout(r, wait));
				const payload = packets[(i + index) % packets.length];
				person.sender.send(rtp(sequence++, timestamp, person.ssrc, payload), person.port, '127.0.0.1');
				timestamp += 960;
			}
		}),
	);

	const stopped = await ack(host, 'seance:stop', {});
	if (!stopped.success) throw new Error(`seance:stop refused: ${stopped.error}`);

	// ---- pick up ------------------------------------------------------------------------
	const base = `${argv.url}/seance/${handle}`;
	const headers = { Authorization: `Bearer ${pullKey}` };
	const manifest = await (await fetch(`${base}/manifest`, { headers })).json();
	let failures = 0;
	let bytes = 0;

	for (const person of people) {
		const track = manifest.tracks.find((t) => t.user_id === person.id);
		if (!track) {
			console.error(`MISSING track of ${person.id}`);
			failures++;
			continue;
		}
		const parts = [];
		for (const chunk of track.chunks) {
			const response = await fetch(`${base}/chunks/${chunk.file}`, { headers });
			const body = Buffer.from(await response.arrayBuffer());
			bytes += body.length;
			if (crypto.createHash('sha256').update(body).digest('hex') !== chunk.sha256) {
				console.error(`BAD HASH ${chunk.file}`);
				failures++;
			}
			parts.push(
				argv.plain ? body : openChunk(body, `${seanceId}/${track.track_id}/${chunk.index}`),
			);
		}
		const stream = Buffer.concat(parts);
		let pages = 0;
		for (let offset = 0; offset + 27 <= stream.length; ) {
			if (stream.toString('ascii', offset, offset + 4) !== 'OggS') {
				console.error(`BAD STREAM of ${person.id} at ${offset}`);
				failures++;
				break;
			}
			const segments = stream[offset + 26];
			let size = 0;
			for (let i = 0; i < segments; i++) size += stream[offset + 27 + i];
			offset += 27 + segments + size;
			pages++;
		}
		const drift = Math.abs(track.duration_ms - argv.seconds * 1000);
		if (drift > 600) {
			console.error(`DURATION of ${person.id}: ${track.duration_ms} ms (drift ${drift})`);
			failures++;
		}
		if (argv.people <= 12) {
			console.log(
				`  ${person.id}: ${track.chunks.length} chunks, ${pages} pages, ${track.duration_ms} ms, ` +
					`${track.activity.length} speech interval(s), anchors=${track.stats?.anchors} ` +
					`silence=${track.stats?.silenceFrames} late=${track.stats?.late}`,
			);
		}
	}

	await fetch(base, { method: 'DELETE', headers });
	console.log(
		`picked up ${bytes} bytes (${(bytes / argv.people / argv.seconds / 125).toFixed(1)} kbit/s per person), ` +
			`${failures} failure(s)`,
	);

	host.disconnect();
	for (const person of people) {
		person.socket.disconnect();
		person.sender.close();
	}
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error('SMOKE TEST FAILED:', error.message);
	process.exit(1);
});
