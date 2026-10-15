// //// Neoffice — added file (no upstream equivalent)
// The limits of `get_room_participants`: a person is held to ten a minute, the address to what twelve people can ask,
// so that an office joining a call in the same minute is not cut off (maintenance#1597).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
	PARTICIPANTS_LIMIT_PER_ADDRESS,
	PARTICIPANTS_LIMIT_PER_USER,
	PARTICIPANTS_LIMIT_WINDOW_MS,
	RateLimiter,
} from '../../utils/rateLimiter';

// What SocketHandlerManager.checkSocketRateLimits does for one request: both keys are counted, both must allow.
function asks(limiter: RateLimiter, user: string, address: string): boolean {
	const userAllowed = limiter.checkRateLimit(
		`user:${user}`,
		PARTICIPANTS_LIMIT_PER_USER,
		PARTICIPANTS_LIMIT_WINDOW_MS,
	);
	const addressAllowed = limiter.checkRateLimit(
		`ip:${address}`,
		PARTICIPANTS_LIMIT_PER_ADDRESS,
		PARTICIPANTS_LIMIT_WINDOW_MS,
	);
	return userAllowed && addressAllowed;
}

describe('the limits of the list of participants', () => {
	let limiter: RateLimiter;
	beforeEach(() => {
		limiter = new RateLimiter();
	});
	afterEach(() => {
		limiter.destroy();
	});

	it('does not cut off five people who share an address and join in the same minute', () => {
		const people = ['a', 'b', 'c', 'd', 'e'];
		for (let turn = 0; turn < 6; turn++) {
			for (const person of people) {
				assert.equal(
					asks(limiter, person, '203.0.113.7'),
					true,
					`${person}, turn ${turn}`,
				);
			}
		}
	});

	it('still holds one person to ten a minute', () => {
		for (let turn = 0; turn < PARTICIPANTS_LIMIT_PER_USER; turn++) {
			assert.equal(asks(limiter, 'a', '203.0.113.7'), true);
		}
		assert.equal(asks(limiter, 'a', '203.0.113.7'), false);
		assert.equal(
			asks(limiter, 'b', '203.0.113.7'),
			true,
			'somebody else of the address is not held',
		);
	});

	it('holds an address to what twelve people can ask', () => {
		let allowed = 0;
		for (let person = 0; person < 12; person++) {
			for (let turn = 0; turn < PARTICIPANTS_LIMIT_PER_USER; turn++) {
				if (asks(limiter, `user-${person}`, '203.0.113.7')) allowed++;
			}
		}
		assert.equal(allowed, 12 * PARTICIPANTS_LIMIT_PER_USER);
		assert.equal(
			asks(limiter, 'user-13', '203.0.113.7'),
			false,
			'the thirteenth person is over the address',
		);
		assert.equal(
			asks(limiter, 'user-13', '198.51.100.9'),
			true,
			'another address is not held',
		);
	});

	it('is what the socket handlers use, not a number written in place', () => {
		const source = readFileSync(
			join(process.cwd(), 'src/server/SocketHandlerManager.ts'),
			'utf8',
		);
		assert.match(source, /PARTICIPANTS_LIMIT_PER_ADDRESS/);
		assert.doesNotMatch(source, /checkSocketRateLimits\(socket, 10, 10,/);
	});
});
