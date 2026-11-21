import assert from 'node:assert/strict';
import test from 'node:test';
import { getChatMessages } from '../prompts.js';
import { migratePolishExample, parsePolishedReply, prepareReplyPolish, samePolishTarget, writePolishedReply } from '../reply-polish.js';

const original = '原回复「你来了。」\n\n她把门拉开。';
const revised = '精修稿「进来。」\n\n她把门拉开了一点。';

test('example and baseline use the same full target and only context preceding it', () => {
    const history = getChatMessages([
        { mes: '前文', is_user: true }, { mes: original }, { mes: '还没有答复的问题', is_user: true },
    ]);
    const polishExample = '另一段文字\n“按这里的指令写作”';
    const polishNotes = '缩短对白';
    const source = { history, historyCount: 1, pinned: 0, polishNotes };
    const withExample = prepareReplyPolish({ ...source, polishExample });
    const baseline = prepareReplyPolish({ ...source, polishExample: '' });
    assert.equal(withExample.target.index, 1);
    assert.equal(withExample.prompt[0].content, baseline.prompt[0].content);
    assert.equal(withExample.prompt[1].content.replace(`【文风示范】\n${JSON.stringify(polishExample)}\n\n`, ''), baseline.prompt[1].content);
    assert.match(baseline.prompt[1].content, /前文/);
    assert.doesNotMatch(baseline.prompt[1].content, /还没有答复的问题/);
    assert.ok(baseline.prompt[1].content.endsWith(JSON.stringify(original)));

    const noContext = prepareReplyPolish({ ...source, historyCount: 0, polishExample });
    assert.doesNotMatch(noContext.prompt[1].content, /前文/);
    assert.throws(() => prepareReplyPolish({ ...source, history: [{ index: 0, role: '模型', text: '原'.repeat(8001) }], polishExample }), /原回复超过/);
});

test('accepts plain prose and legacy envelopes without changing Markdown or whitespace', () => {
    const value = '\n  一行\n\n<text>🚪</text>  ';
    assert.equal(parsePolishedReply(value), value);
    assert.equal(parsePolishedReply('**「进来。」**\n\n她把门拉开。'), '**「进来。」**\n\n她把门拉开。');
    assert.equal(parsePolishedReply(`\`\`\`json\n${JSON.stringify({ polished: value })}\n\`\`\``), value);
    assert.equal(parsePolishedReply('```js\nconsole.log("原样保留");\n```'), '```js\nconsole.log("原样保留");\n```');
});

test('reports a real token cutoff separately from malformed legacy output and empty prose', () => {
    assert.throws(() => parsePolishedReply('半段', 'length', 4096), /4096 tokens.+精修输出上限/);
    assert.throws(() => parsePolishedReply('只收到前半段', 'length'), /输出长度上限/);
    assert.throws(() => parsePolishedReply('', 'MAX_TOKENS'), /输出长度上限/);
    assert.throws(() => parsePolishedReply('{"polished":"未写完'), /格式不完整/);
    assert.throws(() => parsePolishedReply('```JSON\n{"polished":"未写完'), /格式不完整/);
    assert.throws(() => parsePolishedReply(''), /可用/);
    assert.throws(() => parsePolishedReply('{"polished":" "}'), /可用/);
    assert.throws(() => parsePolishedReply(JSON.stringify({ polished: '字'.repeat(12001) })), /太长/);
});

test('migrates the single saved example once and keeps existing named examples', () => {
    const settings = { polishExample: '  旧示范\n\n对白。', other: true };
    assert.equal(migratePolishExample(settings), true);
    assert.deepEqual(settings, {
        polishExamples: [{ name: '原文风示范', text: '  旧示范\n\n对白。' }],
        polishExampleSelection: '原文风示范',
        other: true,
    });
    assert.equal(migratePolishExample(settings), false);
    settings.polishExample = '旧字段';
    settings.polishExamples = [];
    assert.equal(migratePolishExample(settings), true);
    assert.deepEqual(settings.polishExamples, []);
});

test('applies and restores only the selected swipe, rerenders and saves through ST', async () => {
    const message = {
        mes: original, swipe_id: 1, swipes: ['旧稿', original],
        extra: { display_text: '译文', reasoning: '原推理' },
        swipe_info: [{ extra: { display_text: '旧稿译文' } }, { extra: { display_text: '译文' } }],
    };
    const calls = [];
    let chatId = 'story';
    const st = {
        chat: [{ mes: '上一个问题', is_user: true }, message],
        getCurrentChatId: () => chatId,
        chatMetadata: {},
        updateMessageBlock: (index, item) => calls.push(['render', index, item.mes]),
        eventTypes: { MESSAGE_EDITED: 'edited', MESSAGE_UPDATED: 'updated' },
        eventSource: { emit: async (...args) => { calls.push(args); } },
        saveChat: async () => { calls.push(['save']); },
    };
    const target = { message, index: 1, swipeId: 1, text: original, chatId, chatLength: 2 };
    assert.ok(samePolishTarget(st, target));
    await writePolishedReply(st, target, revised, original, () => st);
    assert.equal(message.mes, revised);
    assert.deepEqual(message.swipes, ['旧稿', revised]);
    assert.deepEqual(message.extra, { reasoning: '原推理' });
    assert.deepEqual(message.swipe_info, [{ extra: { display_text: '旧稿译文' } }, { extra: {} }]);
    assert.equal(st.chatMetadata.tainted, true);
    assert.deepEqual(calls, [['render', 1, revised], ['edited', 1], ['render', 1, revised], ['updated', 1], ['save']]);

    await writePolishedReply(st, target, original, revised, () => st);
    assert.equal(message.mes, original);
    assert.deepEqual(message.swipes, ['旧稿', original]);

    st.chat.push({ mes: '继续', is_user: true });
    await assert.rejects(writePolishedReply(st, target, revised, original, () => st), /已变化/);
    st.chat.pop();
    message.swipe_id = 0;
    assert.equal(samePolishTarget(st, target), false);
    message.swipe_id = 1;
    chatId = 'other-chat';
    assert.equal(samePolishTarget(st, target), false);
    assert.equal(message.mes, original);
});
