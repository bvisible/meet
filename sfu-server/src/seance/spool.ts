// //// Neoffice — added file (no upstream equivalent)
// Séance note-taking: the on-disk side of the spool.
//
//   <spool>/<handle>/seance.json            who/what/when of the séance
//   <spool>/<handle>/<track>.json           one person's track (identity, consent, speech)
//   <spool>/<handle>/<track>-<n>-<start>-<dur>[-f].nsc   one sealed chunk
//
// The name of a chunk file carries everything the manifest needs (its rank,
// where it starts and how long it is, in milliseconds from the start of the
// track), so the manifest can always be rebuilt from the directory alone, even
// after the SFU restarted in the middle of a séance.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const HANDLE_PATTERN = /^[0-9a-f]{32}$/;
const CHUNK_FILE_PATTERN =
	/^([0-9a-f]{16})-(\d{6})-(\d{1,10})-(\d{1,9})(-f)?\.(nsc|ogg)$/;

interface ChunkFile {
	file: string;
	trackId: string;
	index: number;
	startMs: number;
	durationMs: number;
	final: boolean;
	extension: 'nsc' | 'ogg';
}

export function chunkFileName(
	trackId: string,
	index: number,
	startMs: number,
	durationMs: number,
	final: boolean,
	extension: 'nsc' | 'ogg',
): string {
	const rank = String(index).padStart(6, '0');
	return `${trackId}-${rank}-${Math.round(startMs)}-${Math.round(durationMs)}${final ? '-f' : ''}.${extension}`;
}

export function parseChunkFileName(file: string): ChunkFile | null {
	const match = CHUNK_FILE_PATTERN.exec(file);
	if (!match) return null;
	return {
		file,
		trackId: match[1],
		index: Number(match[2]),
		startMs: Number(match[3]),
		durationMs: Number(match[4]),
		final: match[5] === '-f',
		extension: match[6] as 'nsc' | 'ogg',
	};
}

/** Deterministic, opaque directory name of a séance (the same one the instance computes). */
export function seanceHandle(tenant: string, seanceId: string): string {
	return createHash('sha256')
		.update(`${tenant}\n${seanceId}`, 'utf8')
		.digest('hex')
		.slice(0, 32);
}

export function sha256Hex(data: Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

/** Writes through a temporary file so that a reader never sees half a file. */
export function writeFileAtomic(file: string, data: Buffer | string): void {
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, data, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

export function ensureSpoolDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	// Fail early (and loudly) when the directory cannot be written.
	fs.accessSync(dir, fs.constants.W_OK);
}

export function ensureSeanceDir(spoolDir: string, handle: string): string {
	if (!HANDLE_PATTERN.test(handle)) throw new Error('invalid handle');
	const dir = path.join(spoolDir, handle);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

export function listChunkFiles(dir: string): ChunkFile[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const chunks: ChunkFile[] = [];
	for (const name of names) {
		const parsed = parseChunkFileName(name);
		if (parsed) chunks.push(parsed);
	}
	return chunks.sort(
		(a, b) => a.trackId.localeCompare(b.trackId) || a.index - b.index,
	);
}

export function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
	} catch {
		return null;
	}
}

/** Removes a séance directory and everything in it. */
export function removeSeanceDir(spoolDir: string, handle: string): void {
	if (!HANDLE_PATTERN.test(handle)) return;
	fs.rmSync(path.join(spoolDir, handle), { recursive: true, force: true });
}

export function directorySize(dir: string): number {
	let total = 0;
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return 0;
	}
	for (const name of names) {
		try {
			total += fs.statSync(path.join(dir, name)).size;
		} catch {
			// removed meanwhile
		}
	}
	return total;
}
