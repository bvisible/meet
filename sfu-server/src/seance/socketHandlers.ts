// //// Neoffice — added file (no upstream equivalent)
// Séance note-taking: the socket events. Each one is answered with
// `{ success: true, ...view }` or `{ success: false, error: <code> }`; the
// codes are in SeanceError. Nothing here can break a call: every handler is
// wrapped, and an unexpected error only costs the person who asked.
//
//   seance:start      {token}            host / co-host, start token from the instance
//   seance:consent    {token}            the person, consent token from the instance
//   seance:decline    {}                 the person says no (nothing is captured anyway)
//   seance:withdraw   {erase?: boolean}  the person stops, and may ask to be erased
//   seance:stop       {}                 host / co-host ends the séance
//   seance:get_state  {}                 where things stand (page reload, late joiner)
//
// Pushed to the room: `seance:state` (who is captured) and `seance:ended`.

import type { Socket } from 'socket.io';
import { loggers } from '../utils/logger';
import type { SeanceManager, SocketContext } from './SeanceManager';
import { SeanceError } from './tokens';

const log = loggers.seance;

const EVENTS_PER_MINUTE = 30;

type Callback = (response: Record<string, unknown>) => void;

function contextOf(socket: Socket): SocketContext {
	if (socket.scope !== 'full') throw new SeanceError('not_allowed');
	if (!socket.roomId || socket.roomId !== socket.meetingId) {
		throw new SeanceError('not_in_room');
	}
	return {
		userId: socket.userId,
		userName: socket.userName,
		isHost: socket.isHost === true,
		isCohost: socket.isCohost === true,
		isGuest: socket.isGuest === true,
		e2eeRequired: socket.e2eeRequired === true,
		tenant: socket.tenant || '',
		rawMeetingId: socket.rawMeetingId || '',
		roomId: socket.meetingId,
	};
}

export function registerSeanceSocketHandlers(
	socket: Socket,
	manager: SeanceManager,
): void {
	let windowStart = Date.now();
	let count = 0;

	const handle = (
		event: string,
		work: (ctx: SocketContext, data: Record<string, unknown>) => unknown,
	): void => {
		socket.on(event, async (data: unknown, callback?: Callback) => {
			const reply: Callback =
				typeof callback === 'function' ? callback : () => undefined;
			try {
				const now = Date.now();
				if (now - windowStart > 60_000) {
					windowStart = now;
					count = 0;
				}
				if (++count > EVENTS_PER_MINUTE) {
					throw new SeanceError('rate_limited');
				}
				const payload =
					data && typeof data === 'object'
						? (data as Record<string, unknown>)
						: {};
				const result = await work(contextOf(socket), payload);
				reply({ success: true, ...(result as Record<string, unknown>) });
			} catch (error) {
				if (error instanceof SeanceError) {
					log.debug('%s refused: %s', event, error.code);
					reply({ success: false, error: error.code });
				} else {
					log.error('%s failed: %s', event, (error as Error).message);
					reply({ success: false, error: 'internal_error' });
				}
			}
		});
	};

	handle('seance:start', (ctx, data) => manager.start(ctx, data.token));
	handle('seance:consent', (ctx, data) => manager.consent(ctx, data.token));
	handle('seance:decline', (ctx) => manager.decline(ctx));
	handle('seance:withdraw', (ctx, data) =>
		manager.withdraw(ctx, data.erase === true),
	);
	handle('seance:stop', (ctx) => manager.stop(ctx));
	handle('seance:get_state', (ctx) => manager.getState(ctx));
}
