// //// Neoffice — added file (no upstream equivalent)
// One secret per tenant (neoffice-maintenance#1101): a secret held by one instance signs for its own tenant only.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import * as jwt from 'jsonwebtoken';
import { AuthManager } from '../../server/AuthManager';
import {
	acceptsSharedSecret,
	tenantSecret,
	verifyTenantToken,
} from '../../utils/tenantSecret';
import { START_TOKEN_TYPE, verifyStartToken } from '../tokens';

const MASTER = 'the-secret-of-the-sfu';
const A = 'client-a.example';
const B = 'client-b.example';

function connection(tenant: string | undefined, secret: string, extra = {}) {
	const claims: Record<string, unknown> = {
		meeting_id: 'abc-defg-hij',
		user_id: 'someone@client.example',
		user_name: 'Someone',
		scope: 'full',
		...extra,
	};
	if (tenant !== undefined) claims.tenant = tenant;
	const lifetime = 'exp' in extra ? {} : { expiresIn: 300 };
	return jwt.sign(claims, secret, { algorithm: 'HS256', ...lifetime });
}

function socketWith(token: string) {
	return {
		handshake: {
			auth: { token },
			query: {},
			address: '127.0.0.1',
			headers: {},
		},
	} as never;
}

afterEach(() => {
	delete process.env.SFU_ACCEPT_SHARED_SECRET;
});

describe('the secret of a tenant', () => {
	it('is the one the hub derives (same vector as neoffice_devops/cloud/meet_sfu.py)', () => {
		assert.equal(
			tenantSecret('vector-master', 'client.example'),
			'a43603907cf0a64a784fc49c324ec674989fcb9391e3d5b24431b392a911f258',
		);
	});

	it('differs from one tenant to another and from the shared secret', () => {
		assert.notEqual(tenantSecret(MASTER, A), tenantSecret(MASTER, B));
		assert.notEqual(tenantSecret(MASTER, A), MASTER);
	});
});

describe('a connection token', () => {
	it('signed with the secret of its tenant is accepted', () => {
		const decoded = verifyTenantToken<jwt.JwtPayload>(
			connection(A, tenantSecret(MASTER, A)),
			MASTER,
		);
		assert.equal(decoded.tenant, A);
	});

	it('claiming another tenant with the secret of one is refused, even during the transition', () => {
		const forged = connection(B, tenantSecret(MASTER, A));
		assert.throws(() => verifyTenantToken(forged, MASTER), /invalid signature/);
	});

	it('signed with the shared secret is accepted during the transition only', () => {
		assert.equal(acceptsSharedSecret(), true);
		assert.equal(
			verifyTenantToken<jwt.JwtPayload>(connection(A, MASTER), MASTER).tenant,
			A,
		);
		process.env.SFU_ACCEPT_SHARED_SECRET = '0';
		assert.throws(
			() => verifyTenantToken(connection(A, MASTER), MASTER),
			/invalid signature/,
		);
	});

	it('without a tenant is refused once the transition is over', () => {
		assert.ok(verifyTenantToken(connection(undefined, MASTER), MASTER));
		process.env.SFU_ACCEPT_SHARED_SECRET = 'false';
		assert.throws(
			() => verifyTenantToken(connection(undefined, MASTER), MASTER),
			/without a tenant/,
		);
	});

	it('that has expired is not rescued by the shared secret', () => {
		const expired = connection(A, tenantSecret(MASTER, A), {
			exp: Math.floor(Date.now() / 1000) - 60,
		});
		assert.throws(
			() => verifyTenantToken(expired, MASTER),
			jwt.TokenExpiredError,
		);
	});

	it('with another algorithm is refused', () => {
		const unsigned = jwt.sign(
			{ tenant: A, meeting_id: 'x', user_id: 'y' },
			'',
			{ algorithm: 'none' },
		);
		assert.throws(() => verifyTenantToken(unsigned, MASTER));
	});

	it('opens a socket in the rooms of its tenant only', () => {
		const auth = new AuthManager(MASTER);
		const socket = socketWith(
			connection(A, tenantSecret(MASTER, A)),
		) as unknown as {
			meetingId?: string;
		};
		assert.equal(auth.authenticateSocket(socket as never), true);
		assert.equal(socket.meetingId, `${A}:abc-defg-hij`);
		assert.equal(
			auth.authenticateSocket(
				socketWith(connection(B, tenantSecret(MASTER, A))),
			),
			false,
		);
	});
});

describe('a séance token', () => {
	it('is verified with the secret of its tenant too', () => {
		const now = Math.floor(Date.now() / 1000);
		const token = jwt.sign(
			{
				aud: 'neoffice-seance',
				scope: 'seance',
				tenant: A,
				meeting_id: 'abc-defg-hij',
				seance_id: 'S-1',
				host_user_id: 'host@client.example',
				pull_key_hash: 'a'.repeat(64),
				jti: 'j-1',
				iat: now,
				exp: now + 120,
			},
			tenantSecret(MASTER, A),
			{ algorithm: 'HS256', header: { alg: 'HS256', typ: START_TOKEN_TYPE } },
		);
		process.env.SFU_ACCEPT_SHARED_SECRET = '0';
		const claims = verifyStartToken(token, MASTER);
		assert.equal(claims.tenant, A);
	});
});
