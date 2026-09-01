import * as assert from 'assert';
import { estimateTokens, truncateToolResult, trimMessages, ChatMessage } from '../../src/agent/context';

describe('estimateTokens', () => {
    it('estimates 0 for empty text', () => {
        assert.strictEqual(estimateTokens(''), 0);
    });
    it('estimates roughly length/4', () => {
        assert.strictEqual(estimateTokens('a'.repeat(16)), 4);
    });
});

describe('truncateToolResult', () => {
    it('returns text unchanged when short', () => {
        assert.strictEqual(truncateToolResult('hello'), 'hello');
    });
    it('truncates long text with marker', () => {
        const out = truncateToolResult('x'.repeat(100), 20);
        assert.ok(out.includes('truncated'));
        assert.ok(out.length < 100);
    });
});

describe('trimMessages', () => {
    it('keeps system messages and drops oldest when over budget', () => {
        const msgs: ChatMessage[] = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'u1' + 'x'.repeat(200) },
            { role: 'assistant', content: 'a1' + 'x'.repeat(200) },
            { role: 'user', content: 'u2' + 'x'.repeat(200) },
        ];
        const out = trimMessages(msgs, 80);
        assert.ok(out[0].role === 'system');
        assert.ok(out.some(m => m.content.startsWith('u2')), 'should keep last user msg');
        assert.ok(!out.some(m => m.content.startsWith('u1')), 'should drop oldest user msg');
    });
    it('keeps all messages when under budget', () => {
        const msgs: ChatMessage[] = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ];
        assert.strictEqual(trimMessages(msgs, 100).length, 2);
    });
    it('keeps the newest message even when it alone exceeds the budget', () => {
        const msgs: ChatMessage[] = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'x'.repeat(400) },  // 100 tokens, over an 80 budget
        ];
        const out = trimMessages(msgs, 80);
        assert.strictEqual(out.length, 2);  // system + the over-budget user msg
        assert.ok(out.some(m => m.content.startsWith('x')));
    });
    it('drops older messages when a recent oversized one is kept', () => {
        const msgs: ChatMessage[] = [
            { role: 'user', content: 'old' },
            { role: 'assistant', content: 'a'.repeat(400) },  // oversized, kept (newest)
        ];
        const out = trimMessages(msgs, 80);
        assert.strictEqual(out.length, 1);
        assert.ok(out[0].content.startsWith('a'));
    });
});
