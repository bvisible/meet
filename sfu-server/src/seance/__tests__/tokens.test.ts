// //// Neoffice — added file (no upstream equivalent)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import * as jwt from 'jsonwebtoken';
import {
	CONSENT_TOKEN_TYPE,
	ReplayCache,
	SEANCE_AUDIENCE,
	SeanceError,
	START_TOKEN_TYPE,
	verifyConsentToken,
	verifyStartToken,
} from '../tokens';

const SECRET = 'a-secret-shared-by-the-fleet';
const PULL_KEY_HASH = createHash('sha256')
	.update('pull-key-0123456789')
	.digest('hex');
const now = () => Math.floor(Date.now() / 1000);

function sign(
	claims: Record<string, unknown>,
	type: string | undefined,
	secret = SECRET,
	algorithm: jwt.Algorithm = 'HS256',
) {
	// no `type`: the library's default header (`typ: "JWT"`)
	const options: jwt.SignOptions = type
		? { algorithm, header: { alg: algorithm, typ: type } }
		: { algorithm };
	return jwt.sign(claims, secret, options);
}

function startClaims(overrides: Record<string, unknown> = {}) {
	return {
		aud: SEANCE_AUDIENCE,
		scope: 'seance',
		tenant: 'client.example',
		meeting_id: 'abc-defg-hij',
		seance_id: 'MTG-0001',
		host_user_id: 'host@example.ch',
		pull_key_hash: PULL_KEY_HASH,
		enc_key: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----',
		jti: 'jti-start-1',
		iat: now(),
		exp: now() + 120,
		...overrides,
	};
}

function consentClaims(overrides: Record<string, unknown> = {}) {
	return {
		aud: SEANCE_AUDIENCE,
		scope: 'seance',
		tenant: 'client.example',
		meeting_id: 'abc-defg-hij',
		seance_id: 'MTG-0001',
		user_id: 'marie@example.ch',
		consent_at: '2026-10-14T10:00:00Z',
		jti: 'jti-consent-1',
		iat: now(),
		exp: now() + 120,
		...overrides,
	};
}

function code(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		assert.ok(error instanceof SeanceError, `unexpected ${error}`);
		return error.code;
	}
	return 'accepted';
}

describe('verifyStartToken', () => {
	it('reads a valid start token', () => {
		const claims = verifyStartToken(
			sign(startClaims(), START_TOKEN_TYPE),
			SECRET,
		);
		assert.equal(claims.tenant, 'client.example');
		assert.equal(claims.meetingId, 'abc-defg-hij');
		assert.equal(claims.seanceId, 'MTG-0001');
		assert.equal(claims.hostUserId, 'host@example.ch');
		assert.equal(claims.pullKeyHash, PULL_KEY_HASH);
		assert.equal(claims.jti, 'jti-start-1');
	});

	it('treats a missing tenant as single-tenant', () => {
		const token = sign(startClaims({ tenant: undefined }), START_TOKEN_TYPE);
		assert.equal(verifyStartToken(token, SECRET).tenant, '');
	});

	it('refuses a consent token, whatever it says', () => {
		const token = sign(startClaims(), CONSENT_TOKEN_TYPE);
		assert.equal(
			code(() => verifyStartToken(token, SECRET)),
			'token_invalid',
		);
	});

	it('refuses a token without purpose in its header', () => {
		const token = sign(startClaims(), undefined);
		assert.equal(
			code(() => verifyStartToken(token, SECRET)),
			'token_invalid',
		);
	});

	it('refuses a connection token (the one every participant holds)', () => {
		// what the instance mints for a person who joins a call: no `aud`, scope `full`
		const connection = jwt.sign(
			{
				user_id: 'host@example.ch',
				user_name: 'Host',
				meeting_id: 'abc-defg-hij',
				tenant: 'client.example',
				scope: 'full',
				is_host: true,
				exp: now() + 3600,
				iat: now(),
			},
			SECRET,
			{ algorithm: 'HS256' },
		);
		assert.equal(
			code(() => verifyStartToken(connection, SECRET)),
			'token_invalid',
		);
		assert.equal(
			code(() => verifyConsentToken(connection, SECRET)),
			'token_invalid',
		);
	});

	it('refuses another audience, another scope, another secret, another algorithm', () => {
		assert.equal(
			code(() =>
				verifyStartToken(
					sign(startClaims({ aud: 'other' }), START_TOKEN_TYPE),
					SECRET,
				),
			),
			'token_invalid',
		);
		assert.equal(
			code(() =>
				verifyStartToken(
					sign(startClaims({ scope: 'full' }), START_TOKEN_TYPE),
					SECRET,
				),
			),
			'token_invalid',
		);
		assert.equal(
			code(() =>
				verifyStartToken(
					sign(startClaims(), START_TOKEN_TYPE, 'wrong-secret'),
					SECRET,
				),
			),
			'token_invalid',
		);
		assert.equal(
			code(() =>
				verifyStartToken(
					sign(startClaims(), START_TOKEN_TYPE, SECRET, 'HS512'),
					SECRET,
				),
			),
			'token_invalid',
		);
		assert.equal(
			code(() =>
				verifyStartToken(
					jwt.sign(startClaims(), '', { algorithm: 'none' as jwt.Algorithm }),
					SECRET,
				),
			),
			'token_invalid',
		);
	});

	it('refuses an expired token and one that lives too long', () => {
		assert.equal(
			code(() =>
				verifyStartToken(
					sign(
						startClaims({ iat: now() - 400, exp: now() - 300 }),
						START_TOKEN_TYPE,
					),
					SECRET,
				),
			),
			'token_invalid',
		);
		assert.equal(
			code(() =>
				verifyStartToken(
					sign(startClaims({ exp: now() + 3600 }), START_TOKEN_TYPE),
					SECRET,
				),
			),
			'token_invalid',
		);
	});

	it('refuses missing or malformed claims', () => {
		for (const claim of [
			'meeting_id',
			'seance_id',
			'host_user_id',
			'jti',
			'pull_key_hash',
		]) {
			const token = sign(startClaims({ [claim]: undefined }), START_TOKEN_TYPE);
			assert.equal(
				code(() => verifyStartToken(token, SECRET)),
				'token_invalid',
				claim,
			);
		}
		assert.equal(
			code(() =>
				verifyStartToken(
					sign(
						startClaims({ pull_key_hash: 'not-a-sha256' }),
						START_TOKEN_TYPE,
					),
					SECRET,
				),
			),
			'token_invalid',
		);
		assert.equal(
			code(() => verifyStartToken(undefined, SECRET)),
			'token_invalid',
		);
		assert.equal(
			code(() => verifyStartToken('', SECRET)),
			'token_invalid',
		);
		assert.equal(
			code(() => verifyStartToken('x'.repeat(9000), SECRET)),
			'token_invalid',
		);
	});
});

describe('verifyConsentToken', () => {
	it('reads a valid consent token', () => {
		const claims = verifyConsentToken(
			sign(consentClaims(), CONSENT_TOKEN_TYPE),
			SECRET,
		);
		assert.equal(claims.userId, 'marie@example.ch');
		assert.equal(claims.seanceId, 'MTG-0001');
		assert.equal(claims.consentAt, '2026-10-14T10:00:00Z');
	});

	it('refuses a start token', () => {
		const token = sign(consentClaims(), START_TOKEN_TYPE);
		assert.equal(
			code(() => verifyConsentToken(token, SECRET)),
			'token_invalid',
		);
	});

	it('refuses a token without a person', () => {
		const token = sign(
			consentClaims({ user_id: undefined }),
			CONSENT_TOKEN_TYPE,
		);
		assert.equal(
			code(() => verifyConsentToken(token, SECRET)),
			'token_invalid',
		);
	});
});

describe('ReplayCache', () => {
	it('accepts a token once', () => {
		const cache = new ReplayCache();
		const t = Date.now();
		assert.equal(cache.consume('a', t + 60_000, t), true);
		assert.equal(cache.consume('a', t + 60_000, t + 1), false);
		assert.equal(cache.consume('b', t + 60_000, t), true);
	});

	it('stops remembering new tokens rather than grow without bound', () => {
		const cache = new ReplayCache();
		const t = Date.now();
		let accepted = 0;
		for (let i = 0; i < 100_050; i++) {
			if (cache.consume(`flood-${i}`, t + 3_600_000, t)) accepted++;
		}
		assert.equal(accepted, 100_000);
		// what is remembered is still refused
		assert.equal(cache.consume('flood-0', t + 3_600_000, t), false);
	});

	it('forgets a token once it could no longer be used anyway', () => {
		const cache = new ReplayCache();
		const t = Date.now();
		assert.equal(cache.consume('old', t + 1000, t), true);
		assert.equal(cache.consume('old', t + 1000, t + 500), false);
		// well after expiry (and the clock-skew margin), the memory is reclaimed
		assert.equal(cache.consume('new', t + 500_000, t + 400_000), true);
		assert.equal(cache.consume('old', t + 500_000, t + 400_001), true);
	});

	it('keeps a token it may still be asked about, until its margin is over', () => {
		const cache = new ReplayCache();
		const t = Date.now();
		cache.consume('a', t + 1000, t);
		// expired for 20 s, still inside the 30 s margin of the verifier
		assert.equal(cache.consume('a', t + 1000, t + 21_000), false);
		// past the margin, and the memory has been swept since
		assert.equal(cache.consume('a', t + 1000, t + 31_001 + 60_000), true);
	});

	it('stays fast under a flood', () => {
		const cache = new ReplayCache();
		const t = Date.now();
		const started = process.hrtime.bigint();
		for (let i = 0; i < 100_000; i++) cache.consume(`fast-${i}`, t + 60_000, t);
		const ms = Number(process.hrtime.bigint() - started) / 1e6;
		assert.ok(ms < 2000, `100 000 tokens took ${ms} ms`);
	});
});
