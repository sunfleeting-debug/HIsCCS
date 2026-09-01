import * as assert from 'assert';
import { isWithinWorkspace, isDangerousCommand } from '../../src/agent/security';

describe('isWithinWorkspace', () => {
	const root = 'C:/proj/app';
	it('accepts a file inside workspace', () => {
		assert.strictEqual(isWithinWorkspace(root, 'C:/proj/app/src/main.ts'), true);
	});
	it('accepts the workspace root itself', () => {
		assert.strictEqual(isWithinWorkspace(root, 'C:/proj/app'), true);
	});
	it('rejects a parent directory path', () => {
		assert.strictEqual(isWithinWorkspace(root, 'C:/proj/other.ts'), false);
	});
	it('rejects a sibling with prefix collision', () => {
		assert.strictEqual(isWithinWorkspace(root, 'C:/proj/app2/x.ts'), false);
	});
});

describe('isDangerousCommand', () => {
	it('blocks rm -rf /', () => {
		assert.strictEqual(isDangerousCommand('rm -rf /'), true);
	});
	it('blocks rm -rf ~', () => {
		assert.strictEqual(isDangerousCommand('rm -rf ~'), true);
	});
	it('allows ordinary rm of a file', () => {
		assert.strictEqual(isDangerousCommand('rm temp.txt'), false);
	});
	it('blocks git push --force', () => {
		assert.strictEqual(isDangerousCommand('git push --force origin main'), true);
	});
	it('allows git push', () => {
		assert.strictEqual(isDangerousCommand('git push origin main'), false);
	});
	it('blocks disk format', () => {
		assert.strictEqual(isDangerousCommand('format C:'), true);
	});
	it('blocks echo x > /dev/sda', () => {
		assert.strictEqual(isDangerousCommand('echo x > /dev/sda'), true);
	});
	it('blocks standalone > /dev/sdb redirect', () => {
		assert.strictEqual(isDangerousCommand('> /dev/sdb'), true);
	});
	it('blocks Remove-Item -Recurse -Force C:\\', () => {
		assert.strictEqual(isDangerousCommand('Remove-Item -Recurse -Force C:\\'), true);
	});
	it('blocks del /s /q C:\\', () => {
		assert.strictEqual(isDangerousCommand('del /s /q C:\\'), true);
	});
	it('allows Remove-Item temp.txt without force', () => {
		assert.strictEqual(isDangerousCommand('Remove-Item temp.txt'), false);
	});
	it('blocks Clear-Disk', () => {
		assert.strictEqual(isDangerousCommand('Clear-Disk -Number 0'), true);
	});
	it('blocks Format-Volume', () => {
		assert.strictEqual(isDangerousCommand('Format-Volume -DriveLetter C'), true);
	});
});
