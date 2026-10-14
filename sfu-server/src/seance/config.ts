// //// Neoffice — added file (no upstream equivalent)
// Séance note-taking: configuration, read once from the environment.

import path from 'node:path';

export interface SeanceConfig {
	/** Master switch. `SEANCE_TAP=0` turns the whole feature off. */
	enabled: boolean;
	/** Where sealed chunks wait for the instance to pick them up. */
	spoolDir: string;
	/** Length of a chunk of audio, in seconds. */
	chunkSeconds: number;
	/** People captured at the same time in one séance. */
	maxTracksPerSeance: number;
	/** A séance is ended by the SFU after this many seconds. */
	maxSeanceSeconds: number;
	/** How long an ended séance stays available for pick-up, in hours. */
	retentionHours: number;
	/** Disk budget of one séance. */
	maxSeanceBytes: number;
	/** Disk budget of the whole spool. */
	maxSpoolBytes: number;
	/** Development only: accept a start token without an encryption key. */
	allowPlaintext: boolean;
}

function positiveNumber(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadSeanceConfig(
	env: NodeJS.ProcessEnv = process.env,
): SeanceConfig {
	const flag = (env.SEANCE_TAP ?? '1').trim().toLowerCase();
	const enabled = !['0', 'false', 'off', 'no', ''].includes(flag);

	return {
		enabled,
		spoolDir:
			env.SEANCE_SPOOL_DIR || path.join(process.cwd(), 'spool', 'seance'),
		chunkSeconds: positiveNumber(env.SEANCE_CHUNK_SECONDS, 30),
		maxTracksPerSeance: Math.floor(positiveNumber(env.SEANCE_MAX_TRACKS, 40)),
		// 4 hours: the transcription box refuses anything longer.
		maxSeanceSeconds: positiveNumber(env.SEANCE_MAX_SECONDS, 4 * 3600),
		retentionHours: positiveNumber(env.SEANCE_RETENTION_HOURS, 24),
		maxSeanceBytes:
			positiveNumber(env.SEANCE_MAX_SEANCE_MB, 1024) * 1024 * 1024,
		maxSpoolBytes: positiveNumber(env.SEANCE_MAX_SPOOL_MB, 4096) * 1024 * 1024,
		allowPlaintext: env.SEANCE_ALLOW_PLAINTEXT === '1',
	};
}
