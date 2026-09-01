import * as assert from 'assert';
import { hashWorkspacePath } from '../../src/agent/workspace';

describe('hashWorkspacePath', () => {
	it('is deterministic for the same path', () => {
		const p = 'C:/proj/CMG-VSCode';
		assert.strictEqual(hashWorkspacePath(p), hashWorkspacePath(p));
	});
	it('is case-insensitive on win32-like paths', () => {
		assert.strictEqual(hashWorkspacePath('C:/Foo/Bar'), hashWorkspacePath('c:/foo/bar'));
	});
	it('produces a stable hex value', () => {
		// The exact value is a lock-in of the hash algorithm; changing it later would orphan existing histories.
		assert.strictEqual(hashWorkspacePath('C:/proj/CMG-VSCode'), '0b466cd4');
	});
	it('handles empty string', () => {
		assert.strictEqual(hashWorkspacePath(''), '00000000');
	});
});
