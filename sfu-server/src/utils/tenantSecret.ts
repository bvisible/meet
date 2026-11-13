// //// Neoffice — added file (no upstream equivalent). One secret per tenant (neoffice-maintenance#1101).
//
// The tenant that separates the rooms is a claim of the token. Each instance receives the secret of its own tenant,
// HMAC-SHA256(JWT_SECRET, "meet-sfu-tenant\0" + tenant), derived the same way by the hub that configures it
// (neoffice_devops/cloud/meet_sfu.py). The SFU derives the secret of the tenant a token claims and verifies the
// signature with it: a secret held by one tenant signs for that tenant alone.
//
// Transition: instances receive their own secret with their next update. Until then a token signed with JWT_SECRET
// itself is still accepted, and each tenant that still uses it is logged once. SFU_ACCEPT_SHARED_SECRET=0 in the
// .env ends that (and refuses a token without a tenant).

import { createHmac } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { loggers } from './logger';

const DERIVATION_LABEL = 'meet-sfu-tenant\0';
const legacyTenantsSeen = new Set<string>();

/** The secret of one tenant: hex HMAC-SHA256 of the SFU's secret over the label and the tenant. */
export function tenantSecret(master: string, tenant: string): string {
	return createHmac('sha256', master)
		.update(DERIVATION_LABEL + tenant)
		.digest('hex');
}

/** True while a token signed with the SFU's own secret is still accepted (the default, see the header). */
export function acceptsSharedSecret(): boolean {
	const value = (process.env.SFU_ACCEPT_SHARED_SECRET ?? '1')
		.trim()
		.toLowerCase();
	return !['0', 'false', 'no', 'off'].includes(value);
}

function claimedTenant(token: string): string {
	const claimed = jwt.decode(token);
	if (!claimed || typeof claimed === 'string') return '';
	const tenant = (claimed as jwt.JwtPayload).tenant;
	return typeof tenant === 'string' ? tenant : '';
}

function isBadSignature(error: unknown): boolean {
	return (
		error instanceof jwt.JsonWebTokenError &&
		!(error instanceof jwt.TokenExpiredError) &&
		!(error instanceof jwt.NotBeforeError) &&
		error.message === 'invalid signature'
	);
}

/**
 * Verify a token an instance signed: with the secret of the tenant it claims, or, during the transition only, with
 * the SFU's own secret. HS256 only. Any other failure (expired, wrong audience, malformed) is thrown as jsonwebtoken
 * throws it, whichever secret would have matched.
 */
export function verifyTenantToken<T = jwt.JwtPayload>(
	token: string,
	master: string,
	options: jwt.VerifyOptions = {},
): T {
	const verifyOptions = {
		...options,
		algorithms: ['HS256'] as jwt.Algorithm[],
	};
	const tenant = claimedTenant(token);
	const shared = acceptsSharedSecret();
	if (tenant) {
		try {
			return jwt.verify(
				token,
				tenantSecret(master, tenant),
				verifyOptions,
			) as T;
		} catch (error) {
			if (!shared || !isBadSignature(error)) throw error;
		}
	} else if (!shared) {
		throw new jwt.JsonWebTokenError('token without a tenant');
	}
	const decoded = jwt.verify(token, master, verifyOptions) as T;
	const seen = tenant || '<none>';
	if (!legacyTenantsSeen.has(seen)) {
		legacyTenantsSeen.add(seen);
		loggers.authManager.warn(
			'Token signed with the shared secret (tenant=%s): this instance has not received its own secret yet',
			seen,
		);
	}
	return decoded;
}
