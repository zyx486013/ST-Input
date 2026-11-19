import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPrompt, getChatMessages, parseResult } from '../prompts.js';

const history = getChatMessages([
    { is_user: true, name: '我', mes: '原始方案' },
    { is_system: true, mes: '内部提示' },
    { is_user: true, name: '我', mes: '最近问题' },
    { name: '模型', mes: '最新答复' },
]);
const source = { mode: 'rewrite', draft: '按那个来', history, historyCount: 2, pinned: 0 };

test('puts the draft and latest confirmation after chronological context and before the task', () => {
    const [system, user] = buildPrompt({
        ...source, final: true, answers: [{ question: '发送吗？', answer: '手动发送' }],
    });
    assert.equal(system.role, 'system');
    assert.equal(user.role, 'user');
    const order = ['原始方案', '最近问题', '最新答复', '按那个来', '手动发送', '本次任务'];
    let position = -1;
    for (const fragment of order) {
        const next = user.content.indexOf(fragment);
        assert.ok(next > position, fragment);
        position = next;
    }
    assert.doesNotMatch(user.content, /内部提示/);
});

test('preserves the latest model reply exactly once when a follow-up has no draft', () => {
    const [, user] = buildPrompt({ ...source, mode: 'followup', draft: '', pinned: 3 });
    assert.match(user.content, /要追问的最新模型回复/);
    assert.equal(user.content.match(/最新答复/g).length, 1);
    assert.doesNotMatch(user.content, /当前草稿/);
    assert.throws(() => buildPrompt({ ...source, mode: 'followup', draft: '', history: [] }), /聊天上下文/);
});

test('drops older history before the latest message and bounds serialized reference text', () => {
    const messages = getChatMessages([
        { mes: '最老的消息' },
        { mes: 'A'.repeat(30000) },
        { mes: 'B'.repeat(30000) },
        { mes: '最新标记' + '\\'.repeat(30000) },
    ]);
    const [, user] = buildPrompt({ ...source, pinned: 3, history: messages, historyCount: 4 });
    assert.match(user.content, /最新标记/);
    assert.doesNotMatch(user.content, /最老的消息/);
    assert.ok(user.content.length < 12500);
});

test('validates the shape and limits of each reply and accepts a plain rewrite', () => {
    assert.deepEqual(parseResult('整理后的问题', 'rewrite'), { draft: '整理后的问题' });
    assert.deepEqual(parseResult('```json\n{"draft":"正常答复"}\n```', 'clarify'), { draft: '正常答复' });
    assert.deepEqual(parseResult('{"questions":[{"text":"哪一个？","options":["A","A","B"]}]}', 'rewrite'), {
        questions: [{ text: '哪一个？', options: ['A', 'B'] }],
    });
    assert.deepEqual(parseResult('{"suggestions":["甲","乙","丙","丁"]}', 'followup'), { suggestions: ['甲', '乙', '丙'] });
    assert.throws(() => parseResult('{"questions":[]}', 'clarify'));
    assert.throws(() => parseResult('{"questions":[{"text":"哪一个？"}]}', 'rewrite', true));
});
