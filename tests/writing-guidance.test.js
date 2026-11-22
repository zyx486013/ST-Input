import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPrompt, getChatMessages, parseResult } from '../prompts.js';
import { appendGuidance, GUIDANCE_KEY, readGuidance, saveGuide } from '../writing-guidance.js';

const issue = {
    category: '逻辑',
    evidence: '因此现象一定由 A 引起',
    issue: '把仅有的相关性写成确定因果。',
    guidance: '区分观察到的相关性和已证实的因果关系。',
};
const chat = getChatMessages([
    { is_user: true, mes: '请解释这个现象' },
    { mes: 'A 和现象同时出现。\n因此现象一定由 A 引起。' },
    { is_user: true, mes: '这是未回答的新问题' },
]);

test('review isolates the latest reply from the draft and later user messages', () => {
    const [system, user] = buildPrompt({ mode: 'review', draft: '私有的未发草稿', history: chat, historyCount: 8 });
    assert.match(system.content, /逐字引文/);
    assert.match(user.content, /请解释这个现象[\s\S]*待分析的最新模型回复[\s\S]*因此现象一定由 A 引起/);
    assert.doesNotMatch(user.content, /私有的未发草稿|这是未回答的新问题/);

    const [, noHistory] = buildPrompt({ mode: 'review', draft: '', history: chat, historyCount: 0 });
    assert.doesNotMatch(noHistory.content, /请解释这个现象/);
    assert.match(noHistory.content, /因此现象一定由 A 引起/);
    assert.throws(() => buildPrompt({ mode: 'review', draft: '', history: [], historyCount: 8 }), /没有可分析/);
});

test('review accepts only finding quotes present in the reply and distinguishes no findings', () => {
    const reply = chat[1].text;
    const madeUp = { ...issue, evidence: '此处是编造引文' };
    assert.deepEqual(parseResult(JSON.stringify({ issues: [madeUp, issue, issue] }), 'review', false, reply), {
        review: [issue],
    });
    assert.throws(() => parseResult(JSON.stringify({ issues: [madeUp] }), 'review', false, reply), /找不到/);
    assert.deepEqual(parseResult('{"issues":[]}', 'review', false, reply), { review: [] });
});

test('confirmed guidance is scoped to the given chat and appends without duplication', () => {
    const empty = readGuidance({});
    const saved = saveGuide(empty, issue);
    const stored = { [GUIDANCE_KEY]: { ...saved, enabled: true } };
    assert.deepEqual(readGuidance({}), { enabled: false, items: [] });
    assert.deepEqual(readGuidance(stored), { enabled: true, items: saved.items });
    assert.equal(saveGuide(saved, issue), saved);
    const draft = appendGuidance('接着展开说明', saved.items);
    assert.match(draft, /接着展开说明[\s\S]*区分观察到的相关性/);
    assert.doesNotMatch(draft, /把仅有的相关性写成确定因果/);
    assert.equal(appendGuidance(draft, saved.items), draft);
    const withIssue = appendGuidance(draft, saved.items, true);
    assert.match(withIssue, /把仅有的相关性写成确定因果/);
    assert.equal(appendGuidance(withIssue, saved.items, true), withIssue);
});
