// //// Neoffice — added file (no upstream equivalent)
// Séance note-taking: the two short-lived tokens the instance signs.
//
// They are signed with the secret the SFU already shares with the instances
// (JWT_SECRET): nothing about the existing connection tokens changes. They
// cannot be mistaken for a connection token, nor the other way round:
//   - `aud` is `neoffice-seance` (connection tokens have none),
//   - `scope` is `seance` (a connection token is `full` or `presence-preview`),
//   - the JOSE header `typ` names the purpose (start / consent),
//   - a connection token without `scope` would be read as `presence-preview`,
//     which cannot start or answer anything.

import * as jwt from 'jsonwebtoken';

export const SEANCE_AUDIENCE = 'neoffice-seance';
const SEANCE_SCOPE = 'seance';
export const START_TOKEN_TYPE = 'neoffice-seance-start+jwt';
export const CONSENT_TOKEN_TYPE = 'neoffice-seance-consent+jwt';

const MAX_TOKEN_LENGTH = 8192;
const MAX_TOKEN_LIFETIME_SECONDS = 300;
const CLOCK_TOLERANCE_SECONDS = 30;
const MAX_REMEMBERED = 100000;
const PRUNE_EVERY_MS = 60_000;

/** An error whose `code` is safe to send to the client. */
export class SeanceError extends Error {
	readonly code: string;

	constructor(code: string, detail?: string) {
		super(detail ?? code);
		this.code = code;
	}
}

interface StartClaims {
	tenant: string;
	meetingId: string;
	seanceId: string;
	hostUserId: string;
	/** Hex SHA-256 of the pull key the instance keeps. */
	pullKeyHash: string;
	/** PEM RSA public key the chunks are sealed for ('' = none). */
	encryptionKey: string;
	jti: string;
	expiresAtMs: number;
}

interface ConsentClaims {
	tenant: string;
	meetingId: string;
	seanceId: string;
	userId: string;
	/** When the instance recorded the person's OK (ISO 8601). */
	consentAt: string;
	jti: string;
	expiresAtMs: number;
}

function text(value: unknown, field: string, max = 256): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > max) {
		throw new SeanceError('token_invalid', `claim ${field}`);
	}
	return value;
}

function verify(token: unknown, secret: string, type: string): jwt.JwtPayload {
	if (
		typeof token !== 'string' ||
		token.length === 0 ||
		token.length > MAX_TOKEN_LENGTH
	) {
		throw new SeanceError('token_invalid');
	}

	let decoded: jwt.Jwt;
	try {
		decoded = jwt.verify(token, secret, {
			algorithms: ['HS256'],
			audience: SEANCE_AUDIENCE,
			complete: true,
			clockTolerance: CLOCK_TOLERANCE_SECONDS,
		}) as jwt.Jwt;
	} catch (error) {
		throw new SeanceError('token_invalid', (error as Error).message);
	}

	if (decoded.header.typ !== type) {
		throw new SeanceError('token_invalid', 'wrong token type');
	}
	const payload = decoded.payload;
	if (typeof payload === 'string') {
		throw new SeanceError('token_invalid', 'payload');
	}
	if (payload.scope !== SEANCE_SCOPE) {
		throw new SeanceError('token_invalid', 'wrong scope');
	}
	if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
		throw new SeanceError('token_invalid', 'missing exp/iat');
	}
	if (payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SECONDS) {
		throw new SeanceError('token_invalid', 'lifetime too long');
	}
	return payload;
}

function tenantOf(payload: jwt.JwtPayload): string {
	const tenant = payload.tenant;
	if (tenant === undefined || tenant === null || tenant === '') return '';
	return text(tenant, 'tenant');
}

export function verifyStartToken(token: unknown, secret: string): StartClaims {
	const payload = verify(token, secret, START_TOKEN_TYPE);
	const pullKeyHash = text(payload.pull_key_hash, 'pull_key_hash', 64);
	if (!/^[0-9a-f]{64}$/.test(pullKeyHash)) {
		throw new SeanceError('token_invalid', 'pull_key_hash');
	}
	const encryptionKey =
		payload.enc_key === undefined || payload.enc_key === ''
			? ''
			: text(payload.enc_key, 'enc_key', 4096);
	return {
		tenant: tenantOf(payload),
		meetingId: text(payload.meeting_id, 'meeting_id'),
		seanceId: text(payload.seance_id, 'seance_id'),
		hostUserId: text(payload.host_user_id, 'host_user_id'),
		pullKeyHash,
		encryptionKey,
		jti: text(payload.jti, 'jti', 128),
		expiresAtMs: (payload.exp as number) * 1000,
	};
}

export function verifyConsentToken(
	token: unknown,
	secret: string,
): ConsentClaims {
	const payload = verify(token, secret, CONSENT_TOKEN_TYPE);
	return {
		tenant: tenantOf(payload),
		meetingId: text(payload.meeting_id, 'meeting_id'),
		seanceId: text(payload.seance_id, 'seance_id'),
		userId: text(payload.user_id, 'user_id'),
		consentAt: text(payload.consent_at, 'consent_at', 64),
		jti: text(payload.jti, 'jti', 128),
		expiresAtMs: (payload.exp as number) * 1000,
	};
}

/** Remembers the `jti` of tokens already used, until they would have expired. */
export class ReplayCache {
	private readonly seen = new Map<string, number>();
	private nextPruneMs = 0;

	/** True the first time a `jti` is presented, false afterwards. */
	consume(jti: string, expiresAtMs: number, nowMs: number): boolean {
		if (nowMs >= this.nextPruneMs) {
			this.prune(nowMs);
			this.nextPruneMs = nowMs + PRUNE_EVERY_MS;
		}
		if (this.seen.has(jti)) return false;
		// A flood of valid tokens must not grow the memory without bound.
		if (this.seen.size >= MAX_REMEMBERED) return false;
		// Keep it a little beyond expiry: the verifier tolerates clock skew.
		this.seen.set(jti, expiresAtMs + CLOCK_TOLERANCE_SECONDS * 1000);
		return true;
	}

	private prune(nowMs: number): void {
		for (const [jti, until] of this.seen) {
			if (until < nowMs) this.seen.delete(jti);
		}
	}
}
