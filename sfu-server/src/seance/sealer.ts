// //// Neoffice — added file (no upstream equivalent)
// Séance note-taking: seals every chunk of audio for the instance that owns
// the séance, so that the SFU host cannot read what it keeps on disk.
//
// The instance generates an RSA key pair for each séance and hands the PUBLIC
// key to the SFU inside the signed start token. A chunk is sealed with a fresh
// AES-256-GCM key, itself wrapped with RSA-OAEP(SHA-256). The SFU never holds
// anything able to open what it has written.
//
// File layout:
//   "NSC1" | wrapped key length (u16 BE) | wrapped key | IV (12) | ciphertext | tag (16)
// The additional authenticated data names the chunk
// (`<séance>/<track>/<index>`), so chunks cannot be swapped.

import { Buffer } from 'node:buffer';
import {
	constants,
	createCipheriv,
	createPublicKey,
	type KeyObject,
	publicEncrypt,
	randomBytes,
} from 'node:crypto';

export const SEALED_MAGIC = Buffer.from('NSC1', 'ascii');
const MIN_RSA_BITS = 2048;

export class Sealer {
	private readonly key: KeyObject;

	constructor(publicKeyPem: string) {
		const key = createPublicKey(publicKeyPem);
		if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa') {
			throw new Error('The séance key must be an RSA public key');
		}
		const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
		if (bits < MIN_RSA_BITS) {
			throw new Error(`The séance key must be at least ${MIN_RSA_BITS} bits`);
		}
		this.key = key;
	}

	seal(plain: Buffer, additionalData: string): Buffer {
		const dataKey = randomBytes(32);
		const iv = randomBytes(12);
		const wrapped = publicEncrypt(
			{
				key: this.key,
				padding: constants.RSA_PKCS1_OAEP_PADDING,
				oaepHash: 'sha256',
			},
			dataKey,
		);
		const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
		cipher.setAAD(Buffer.from(additionalData, 'utf8'));
		const body = Buffer.concat([cipher.update(plain), cipher.final()]);
		const tag = cipher.getAuthTag();

		const length = Buffer.alloc(2);
		length.writeUInt16BE(wrapped.length);
		return Buffer.concat([SEALED_MAGIC, length, wrapped, iv, body, tag]);
	}
}
