import * as jwt from 'jsonwebtoken';
import type { Socket } from 'socket.io';
import type { JWTPayload } from '../types';
import { loggers } from '../utils/logger';
import { PreviewSessionManager } from '../utils/previewSessionManager';

export class AuthManager {
	private jwtSecret: string;
	private sessionManager: PreviewSessionManager;

	constructor(jwtSecret: string) {
		this.jwtSecret = jwtSecret;
		this.sessionManager = new PreviewSessionManager();
	}

	authenticateSocket(socket: Socket): boolean {
		try {
			const token = socket.handshake.auth.token || socket.handshake.query.token;

			if (!token) {
				loggers.authManager.error('No authentication token provided');
				return false;
			}

			const decoded = jwt.verify(token, this.jwtSecret) as JWTPayload;

			if (decoded.scope === 'presence-preview' && decoded.session_id) {
				const clientIp = socket.handshake.address || 'unknown';
				const userAgent = socket.handshake.headers?.['user-agent'] || 'unknown';

				let session = this.sessionManager.getSession(decoded.session_id);
				if (!session) {
					// Create session and mark as used
					session = this.sessionManager.createSession(
						token,
						decoded.meeting_id,
						decoded.user_id,
						clientIp,
						userAgent,
					);
					this.sessionManager.markSessionAsUsed(session.sessionId);
					loggers.authManager.debug(
						'Created and marked as used new preview session %s for user %s',
						decoded.session_id,
						decoded.user_id,
					);
				} else {
					// validate existing session
					const sessionResult = this.sessionManager.validateAndUseSession(
						decoded.session_id,
						token,
						clientIp,
						userAgent,
					);

					if (!sessionResult.valid) {
						loggers.authManager.warn(
							'Preview session validation failed for user %s: %s',
							decoded.user_id,
							sessionResult.reason,
						);
						return false;
					}

					loggers.authManager.debug(
						'Preview session validated for user %s, session %s',
						decoded.user_id,
						decoded.session_id,
					);
				}
			}

			// Attach user info to socket
			socket.userId = decoded.user_id;
			socket.userName = decoded.user_name;
			// Multi-tenant isolation: when the JWT carries a `tenant`
			// claim, prefix the effective meetingId with it so that
			// mediasoup rooms are strictly separated across tenants.
			// Clients / Frappe sites with the same raw meeting_id but
			// different tenants get different rooms, and a JWT forged
			// for the wrong tenant cannot steer into another tenant's
			// room because `updateSocketToken` / `ensurePresenceAccess`
			// re-verify the tenant on every refresh.
			socket.rawMeetingId = decoded.meeting_id;
			socket.tenant = decoded.tenant;
			socket.meetingId = decoded.tenant
				? `${decoded.tenant}:${decoded.meeting_id}`
				: decoded.meeting_id;
			socket.isHost = decoded.is_host || false;
			socket.isCohost = decoded.is_cohost || false;
			socket.scope = decoded.scope || 'presence-preview';
			socket.currentToken = token;
			socket.tokenExpiresAt = decoded.exp ? decoded.exp * 1000 : undefined;
			this.scheduleTokenExpiry(socket);

			loggers.authManager.info(
				'Authenticated user: %s for meeting: %s (tenant=%s)',
				socket.userId,
				socket.meetingId,
				socket.tenant || '<none>',
			);
			return true;
		} catch (error) {
			loggers.authManager.error(
				'Authentication failed: %s',
				(error as Error).message,
			);
			return false;
		}
	}

	getUserAvatar(token: string): string | undefined {
		try {
			const decoded = jwt.decode(token) as JWTPayload;
			return decoded.user_avatar;
		} catch (_error) {
			return undefined;
		}
	}

	updateSocketToken(socket: Socket, token: string): void {
		const decoded = jwt.verify(token, this.jwtSecret) as JWTPayload;

		// Raw meeting_id + tenant must both match what was attached at
		// initial authentication. A refresh token from another tenant
		// with the same meeting_id is rejected here.
		if (
			!decoded.meeting_id ||
			decoded.meeting_id !== socket.rawMeetingId
		) {
			throw new Error('Token meeting mismatch');
		}

		if ((decoded.tenant || undefined) !== (socket.tenant || undefined)) {
			throw new Error('Token tenant mismatch');
		}

		if (!decoded.user_id || decoded.user_id !== socket.userId) {
			throw new Error('Token user mismatch');
		}

		socket.currentToken = token;
		socket.tokenExpiresAt = decoded.exp ? decoded.exp * 1000 : undefined;

		if (socket.handshake?.auth) {
			socket.handshake.auth.token = token;
		}

		loggers.authManager.info(
			'Updated token for socket %s (user %s)',
			socket.id,
			socket.userId,
		);

		this.scheduleTokenExpiry(socket);
	}

	isTokenExpired(socket: Socket): boolean {
		if (!socket.tokenExpiresAt) {
			return false;
		}

		return Date.now() >= socket.tokenExpiresAt;
	}

	triggerTokenExpiry(socket: Socket, reason: string): void {
		if (socket.disconnected) {
			return;
		}

		this.clearTokenExpiry(socket);

		const timestamp = new Date().toISOString();

		loggers.authManager.warn(
			'Disconnecting socket %s (user %s) due to expired token (%s)',
			socket.id,
			socket.userId,
			reason,
		);

		try {
			socket.emit('auth:expired', {
				timestamp,
				reason,
			});
			socket.emit('sfu_error', {
				error: 'Authentication token expired',
				timestamp,
			});
		} catch (emitError) {
			loggers.authManager.warn(
				'Failed to emit auth:expired for socket %s: %s',
				socket.id,
				(emitError as Error).message,
			);
		}

		setImmediate(() => {
			if (!socket.disconnected) {
				socket.disconnect(true);
			}
		});
	}

	cleanupSocket(socket: Socket): void {
		this.clearTokenExpiry(socket);
		socket.currentToken = undefined;
		socket.tokenExpiresAt = undefined;
	}

	private scheduleTokenExpiry(socket: Socket): void {
		this.clearTokenExpiry(socket);

		if (!socket.tokenExpiresAt) {
			return;
		}

		const delay = socket.tokenExpiresAt - Date.now();

		if (delay <= 0) {
			this.triggerTokenExpiry(socket, 'expired_before_timer');
			return;
		}

		socket.tokenExpiryTimer = setTimeout(() => {
			this.triggerTokenExpiry(socket, 'timer_elapsed');
		}, delay);
	}

	private clearTokenExpiry(socket: Socket): void {
		if (socket.tokenExpiryTimer) {
			clearTimeout(socket.tokenExpiryTimer);
			socket.tokenExpiryTimer = undefined;
		}
	}

	ensurePresenceAccess(socket: Socket): void {
		if (socket.scope !== 'presence-preview' && socket.scope !== 'full') {
			throw new Error('Insufficient scope for presence access');
		}

		// Validate that the socket's meeting ID matches the token's meeting ID
		// This prevents token reuse across different meetings
		const token = socket.currentToken;
		if (!token) {
			throw new Error('No token available for validation');
		}

		try {
			const decoded = jwt.verify(token, this.jwtSecret) as JWTPayload;
			if (decoded.meeting_id !== socket.rawMeetingId) {
				loggers.authManager.warn(
					'Meeting ID mismatch for user %s: token has %s, socket has %s',
					socket.userId,
					decoded.meeting_id,
					socket.rawMeetingId,
				);
				throw new Error('Token meeting ID does not match socket meeting ID');
			}
			if ((decoded.tenant || undefined) !== (socket.tenant || undefined)) {
				loggers.authManager.warn(
					'Tenant mismatch for user %s: token tenant=%s, socket tenant=%s',
					socket.userId,
					decoded.tenant || '<none>',
					socket.tenant || '<none>',
				);
				throw new Error('Token tenant does not match socket tenant');
			}
		} catch (error) {
			if (error instanceof jwt.JsonWebTokenError) {
				throw new Error('Invalid token for presence access validation');
			}
			throw error;
		}
	}

	ensureFullAccess(socket: Socket): void {
		if (socket.scope !== 'full') {
			throw new Error('Insufficient scope for full access');
		}
	}

	destroy(): void {
		this.sessionManager.destroy();
	}
}
