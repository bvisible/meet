// //// Neoffice — added file (no upstream equivalent)
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
	constants,
	createDecipheriv,
	generateKeyPairSync,
	type KeyObject,
	privateDecrypt,
} from 'node:crypto';
import { before, describe, it } from 'node:test';
import { SEALED_MAGIC, Sealer } from '../sealer';

let privateKey: KeyObject;
let publicPem: string;

/** What the instance does: the reference reader of the sealed format. */
function open(
	sealed: Buffer,
	additionalData: string,
	key = privateKey,
): Buffer {
	assert.ok(sealed.subarray(0, 4).equals(SEALED_MAGIC), 'magic');
	const wrappedLength = sealed.readUInt16BE(4);
	const wrapped = sealed.subarray(6, 6 + wrappedLength);
	const iv = sealed.subarray(6 + wrappedLength, 6 + wrappedLength + 12);
	const body = sealed.subarray(6 + wrappedLength + 12, sealed.length - 16);
	const tag = sealed.subarray(sealed.length - 16);
	const dataKey = privateDecrypt(
		{
			key,
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

describe('Sealer', () => {
	before(() => {
		const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
		privateKey = pair.privateKey;
		publicPem = pair.publicKey
			.export({ type: 'spki', format: 'pem' })
			.toString();
	});

	it('seals so that only the holder of the private key reads it', () => {
		const plain = Buffer.from('OggS… some audio …', 'utf8');
		const sealed = new Sealer(publicPem).seal(plain, 'MTG-1/aaaa/1');

		assert.ok(!sealed.includes(plain), 'the clear text is nowhere in the file');
		assert.ok(open(sealed, 'MTG-1/aaaa/1').equals(plain));
	});

	it('uses a new key and a new IV for each chunk', () => {
		const sealer = new Sealer(publicPem);
		const plain = Buffer.alloc(64, 7);
		const a = sealer.seal(plain, 'x');
		const b = sealer.seal(plain, 'x');
		assert.ok(!a.equals(b));
	});

	it('draws a new IV and a new wrapped key every time', () => {
		const sealer = new Sealer(publicPem);
		const plain = Buffer.alloc(64, 7);
		const a = sealer.seal(plain, 'x');
		const b = sealer.seal(plain, 'x');
		const parts = (sealed: Buffer) => {
			const wrappedLength = sealed.readUInt16BE(4);
			return {
				wrapped: sealed.subarray(6, 6 + wrappedLength),
				iv: sealed.subarray(6 + wrappedLength, 6 + wrappedLength + 12),
			};
		};
		assert.ok(!parts(a).iv.equals(parts(b).iv));
		assert.ok(!parts(a).wrapped.equals(parts(b).wrapped));
	});

	it('refuses a chunk that was altered', () => {
		const sealed = new Sealer(publicPem).seal(
			Buffer.alloc(200, 1),
			'MTG-1/aaaa/1',
		);
		const body = Buffer.from(sealed);
		body[body.length - 20] ^= 0x01;
		assert.throws(() => open(body, 'MTG-1/aaaa/1'));
		const tag = Buffer.from(sealed);
		tag[tag.length - 1] ^= 0x01;
		assert.throws(() => open(tag, 'MTG-1/aaaa/1'));
	});

	it('binds a chunk to its séance, track and rank', () => {
		const sealed = new Sealer(publicPem).seal(
			Buffer.alloc(50, 3),
			'MTG-1/aaaa/1',
		);
		assert.throws(() => open(sealed, 'MTG-1/aaaa/2'));
		assert.throws(() => open(sealed, 'MTG-1/bbbb/1'));
		assert.throws(() => open(sealed, 'MTG-2/aaaa/1'));
	});

	it('cannot be opened with another key', () => {
		const other = generateKeyPairSync('rsa', { modulusLength: 3072 });
		const sealed = new Sealer(publicPem).seal(Buffer.alloc(50, 3), 'x');
		assert.throws(() => open(sealed, 'x', other.privateKey));
	});

	it('only accepts an RSA public key of at least 2048 bits', () => {
		const small = generateKeyPairSync('rsa', { modulusLength: 1024 });
		assert.throws(
			() =>
				new Sealer(
					small.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
				),
			/2048/,
		);
		const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
		assert.throws(
			() =>
				new Sealer(
					ec.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
				),
			/RSA/,
		);
		assert.throws(() => new Sealer('not a key'));
	});
});
