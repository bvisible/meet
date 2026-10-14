// //// Neoffice — added file (no upstream equivalent)
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type { Socket } from 'socket.io';
import type { SeanceManager, SocketContext } from '../SeanceManager';
import { registerSeanceSocketHandlers } from '../socketHandlers';
import { SeanceError } from '../tokens';
import { ROOM, TENANT } from './fixtures';

class FakeSocket extends EventEmitter {
	scope: string | undefined = 'full';
	roomId: string | undefined = ROOM;
	meetingId = ROOM;
	userId = 'marie@example.ch';
	userName = 'Marie';
	isHost = false;
	isCohost = true;
	isGuest = true;
	e2eeRequired = true;
	tenant: string | undefined = TENANT;
	rawMeetingId: string | undefined = 'abc-defg-hij';
}

type Response = Record<string, unknown>;

function call(
	socket: FakeSocket,
	event: string,
	data: unknown,
): Promise<Response> {
	return new Promise((resolve) => {
		socket.emit(event, data, resolve);
	});
}

function wire(manager: Partial<Record<keyof SeanceManager, unknown>>) {
	const socket = new FakeSocket();
	registerSeanceSocketHandlers(
		socket as unknown as Socket,
		manager as unknown as SeanceManager,
	);
	return socket;
}

describe('seance socket handlers', () => {
	it('hands the manager what the connection token established', async () => {
		let seen: { ctx?: SocketContext; token?: unknown } = {};
		const socket = wire({
			start: async (ctx: SocketContext, token: unknown) => {
				seen = { ctx, token };
				return { active: true };
			},
		});
		const response = await call(socket, 'seance:start', { token: 'abc' });

		assert.deepEqual(response, { success: true, active: true });
		assert.equal(seen.token, 'abc');
		assert.deepEqual(seen.ctx, {
			userId: 'marie@example.ch',
			userName: 'Marie',
			isHost: false,
			isCohost: true,
			isGuest: true,
			e2eeRequired: true,
			tenant: TENANT,
			rawMeetingId: 'abc-defg-hij',
			roomId: ROOM,
		});
	});

	it('treats a missing tenant as single-tenant', async () => {
		let tenant: string | undefined;
		const socket = wire({
			getState: (ctx: SocketContext) => {
				tenant = ctx.tenant;
				return { active: false };
			},
		});
		socket.tenant = undefined;
		await call(socket, 'seance:get_state', {});
		assert.equal(tenant, '');
	});

	it('refuses a socket that has no full access', async () => {
		const socket = wire({ getState: () => ({ active: false }) });
		socket.scope = 'presence-preview';
		assert.deepEqual(await call(socket, 'seance:get_state', {}), {
			success: false,
			error: 'not_allowed',
		});
	});

	it('refuses a socket that has not joined the room', async () => {
		const socket = wire({ getState: () => ({ active: false }) });
		socket.roomId = undefined;
		assert.deepEqual(await call(socket, 'seance:get_state', {}), {
			success: false,
			error: 'not_in_room',
		});
		socket.roomId = 'another-room';
		assert.deepEqual(await call(socket, 'seance:get_state', {}), {
			success: false,
			error: 'not_in_room',
		});
	});

	it('sends back the code of a refusal, and nothing of an unexpected error', async () => {
		const socket = wire({
			consent: async () => {
				throw new SeanceError('wrong_user');
			},
			start: async () => {
				throw new Error('ENOENT: /var/lib/secret/path');
			},
		});
		assert.deepEqual(await call(socket, 'seance:consent', { token: 'x' }), {
			success: false,
			error: 'wrong_user',
		});
		assert.deepEqual(await call(socket, 'seance:start', { token: 'x' }), {
			success: false,
			error: 'internal_error',
		});
	});

	it('copes with a payload that is not an object, and with no callback', async () => {
		let token: unknown = 'unset';
		const socket = wire({
			consent: async (_ctx: SocketContext, value: unknown) => {
				token = value;
				return {};
			},
		});
		assert.deepEqual(await call(socket, 'seance:consent', null), {
			success: true,
		});
		assert.equal(token, undefined);
		assert.deepEqual(await call(socket, 'seance:consent', 'a string'), {
			success: true,
		});
		// no acknowledgement function: must not throw
		socket.emit('seance:consent', { token: 'x' });
		await new Promise((resolve) => setImmediate(resolve));
	});

	it('only passes the erase flag when it is exactly true', async () => {
		const seen: boolean[] = [];
		const socket = wire({
			withdraw: (_ctx: SocketContext, erase: boolean) => {
				seen.push(erase);
				return {};
			},
		});
		await call(socket, 'seance:withdraw', { erase: true });
		await call(socket, 'seance:withdraw', { erase: 'yes' });
		await call(socket, 'seance:withdraw', {});
		assert.deepEqual(seen, [true, false, false]);
	});

	it('answers every event of the protocol', async () => {
		const socket = wire({
			start: async () => ({}),
			consent: async () => ({}),
			decline: () => ({}),
			withdraw: () => ({}),
			stop: () => ({}),
			getState: () => ({}),
		});
		for (const event of [
			'seance:start',
			'seance:consent',
			'seance:decline',
			'seance:withdraw',
			'seance:stop',
			'seance:get_state',
		]) {
			assert.deepEqual(await call(socket, event, {}), { success: true }, event);
		}
	});

	it('slows down a socket that floods it', async () => {
		const socket = wire({ getState: () => ({ active: false }) });
		let limited = 0;
		for (let i = 0; i < 40; i++) {
			const response = await call(socket, 'seance:get_state', {});
			if (response.error === 'rate_limited') limited++;
		}
		assert.equal(limited, 10, 'the 31st to the 40th are refused');
	});
});
