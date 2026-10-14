// //// Neoffice — added file (no upstream equivalent)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
	chunkFileName,
	ensureSeanceDir,
	HANDLE_PATTERN,
	listChunkFiles,
	parseChunkFileName,
	removeSeanceDir,
	seanceHandle,
} from '../spool';
import { makeSpoolDir } from './fixtures';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

function spool(): string {
	const dir = makeSpoolDir();
	dirs.push(dir);
	return dir;
}

describe('spool', () => {
	it('names a séance by a hash of its tenant and identifier', () => {
		const handle = seanceHandle('client.example', 'MTG-0001');
		assert.match(handle, HANDLE_PATTERN);
		assert.equal(handle, seanceHandle('client.example', 'MTG-0001'));
		assert.notEqual(handle, seanceHandle('other.example', 'MTG-0001'));
		assert.notEqual(handle, seanceHandle('client.example', 'MTG-0002'));
		// the separator makes ("a", "bc") and ("ab", "c") different
		assert.notEqual(seanceHandle('a', 'bc'), seanceHandle('ab', 'c'));
		// a fixed value, so that the instance (Python) computes the same one
		assert.equal(handle, '4b3462a48645daa357edb613da0c1122');
	});

	it('writes a chunk name that carries everything the manifest needs, and reads it back', () => {
		const name = chunkFileName(
			'0123456789abcdef',
			7,
			30000,
			29980,
			true,
			'nsc',
		);
		assert.equal(name, '0123456789abcdef-000007-30000-29980-f.nsc');
		assert.deepEqual(parseChunkFileName(name), {
			file: name,
			trackId: '0123456789abcdef',
			index: 7,
			startMs: 30000,
			durationMs: 29980,
			final: true,
			extension: 'nsc',
		});
		const plain = chunkFileName('0123456789abcdef', 1, 0, 30000, false, 'ogg');
		assert.equal(parseChunkFileName(plain)?.final, false);
		assert.equal(parseChunkFileName(plain)?.extension, 'ogg');
	});

	it('does not take anything else for a chunk', () => {
		for (const name of [
			'seance.json',
			'0123456789abcdef.json',
			'../0123456789abcdef-000001-0-1.nsc',
			'0123456789abcdef-1-0-1.nsc',
			'0123456789abcdeg-000001-0-1.nsc',
			'0123456789abcdef-000001-0-1.exe',
			'0123456789abcdef-000001-0-1.nsc.tmp',
		]) {
			assert.equal(parseChunkFileName(name), null, name);
		}
	});

	it('lists chunks in order, track by track', () => {
		const dir = spool();
		for (const [track, index] of [
			['bbbbbbbbbbbbbbbb', 2],
			['aaaaaaaaaaaaaaaa', 2],
			['aaaaaaaaaaaaaaaa', 1],
		] as const) {
			fs.writeFileSync(
				path.join(dir, chunkFileName(track, index, 0, 1, false, 'nsc')),
				'',
			);
		}
		fs.writeFileSync(path.join(dir, 'seance.json'), '{}');
		assert.deepEqual(
			listChunkFiles(dir).map((c) => `${c.trackId[0]}${c.index}`),
			['a1', 'a2', 'b2'],
		);
		assert.deepEqual(listChunkFiles(path.join(dir, 'missing')), []);
	});

	it('only creates directories named by a handle', () => {
		const dir = spool();
		const handle = seanceHandle('t', 's');
		assert.equal(ensureSeanceDir(dir, handle), path.join(dir, handle));
		assert.equal(fs.statSync(path.join(dir, handle)).mode & 0o777, 0o700);
		for (const bad of ['../x', 'x', handle.toUpperCase(), `${handle}/..`, '']) {
			assert.throws(() => ensureSeanceDir(dir, bad), /invalid handle/, bad);
		}
	});

	it('only removes directories named by a handle', () => {
		const dir = spool();
		const victim = path.join(dir, '..', `victim-${Date.now()}`);
		fs.mkdirSync(victim);
		dirs.push(victim);
		const handle = seanceHandle('t', 's');
		ensureSeanceDir(dir, handle);

		removeSeanceDir(dir, `../${path.basename(victim)}`);
		assert.ok(fs.existsSync(victim), 'a path is not a handle');
		removeSeanceDir(dir, handle);
		assert.equal(fs.existsSync(path.join(dir, handle)), false);
	});
});
