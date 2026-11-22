import assert from 'node:assert/strict';
import test from 'node:test';
import { getChatMessages } from '../prompts.js';
import { MAX_EXAMPLE, migratePolishExample, parsePolishedReply, prepareReplyPolish, samePolishTarget, writePolishedReply } from '../reply-polish.js';

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

test('adds optional diction guidance only with an example and keeps the handwritten notes', () => {
    const source = { history: getChatMessages([{ mes: original }]), historyCount: 0, polishNotes: '只改旁白' };
    const prompt = (polishExample, matchExampleDiction) =>
        prepareReplyPolish({ ...source, polishExample, matchExampleDiction }).prompt[1].content;
    assert.equal(prompt('', true), prompt('', false));
    assert.equal(prompt('范文', false), prompt('范文', undefined));
    assert.doesNotMatch(prompt('范文', false), /【参考范文用词】/);
    assert.match(prompt('范文', true), /【参考范文用词】[\s\S]+【本次精修要求】\n"只改旁白"/);
});

test('rewrites with or without an example and sends the same target and requirements as polishing', () => {
    const source = { history: getChatMessages([{ mes: original }]), historyCount: 0, polishNotes: '只改对白' };
    for (const polishExample of ['', '示范原文\n示范结尾']) {
        const options = { ...source, polishExample, matchExampleDiction: true };
        const polish = prepareReplyPolish(options);
        const rewrite = prepareReplyPolish({ ...options, rewrite: true });
        assert.match(polish.prompt[0].content, /按原稿自身的语气轻修/);
        assert.match(rewrite.prompt[0].content, /本次采用重写方式/);
        assert.doesNotMatch(rewrite.prompt[0].content, /只精修|完整精修正文|轻修|句段可以照录/);
        assert.match(rewrite.prompt[0].content, /只输出完整重写正文/);
        assert.equal(rewrite.prompt[0].content.includes('通读【文风示范】'), Boolean(polishExample));
        assert.equal(rewrite.prompt[1].content.includes('【参考范文用词】'), Boolean(polishExample));
        assert.equal(rewrite.prompt[1].content, polish.prompt[1].content.replace('【待精修的回复 #', '【待重写的回复 #'));
        assert.deepEqual(rewrite.target, polish.target);
    }
});

test('uses display-transformed text for the target and context, keeping the original for restoration', () => {
    const raw = '<hidden>' + '秘密'.repeat(4500) + '</hidden>**正文**';
    const history = getChatMessages([
        { mes: '<hidden>隐藏参考</hidden>参考稿', is_user: true },
        { mes: '<hidden>隐藏上下文</hidden>上文' },
        { mes: raw },
        { mes: '后来消息', is_user: true },
    ]);
    const displayText = message => message.text.replace(/<hidden>.*?<\/hidden>/gs, '');
    const source = { history, historyCount: 2, pinned: 0, polishExample: '范文', polishNotes: '', displayText };
    const { target, prompt } = prepareReplyPolish(source);
    assert.deepEqual([target.index, target.text, target.rawText], [2, '**正文**', raw]);
    assert.match(prompt[1].content, /参考稿/);
    assert.match(prompt[1].content, /上文/);
    assert.doesNotMatch(prompt[1].content, /隐藏|秘密|后来消息/);
    assert.ok(prompt[1].content.endsWith(JSON.stringify('**正文**')));

    history[2].text = '<hidden>全部隐藏</hidden>';
    assert.throws(() => prepareReplyPolish(source), /正则处理后没有可精修的正文/);
});

test('includes long examples up to the limit verbatim alongside the full source reply', () => {
    const suffix = '\n「示范结尾。」  ';
    const polishExample = ' 夜'.repeat(Math.floor((MAX_EXAMPLE - suffix.length) / 2)).padEnd(MAX_EXAMPLE - suffix.length) + suffix;
    const reply = '原'.repeat(8000);
    const source = { history: getChatMessages([{ mes: reply }]), historyCount: 0, polishExample, polishNotes: '保留对白' };
    const { prompt } = prepareReplyPolish(source);
    assert.ok(prompt[1].content.length > 32000);
    assert.ok(prompt[1].content.includes(`【文风示范】\n${JSON.stringify(polishExample)}\n\n`));
    assert.ok(prompt[1].content.endsWith(JSON.stringify(reply)));
    assert.throws(() => prepareReplyPolish({ ...source, polishExample: polishExample + '字' }), /文风示范超过 32,000 字/);
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
    const legacyExample = '  旧示范\n\n对白。'.repeat(1100);
    const settings = { polishExample: legacyExample, other: true };
    assert.equal(migratePolishExample(settings), true);
    assert.deepEqual(settings, {
        polishExamples: [{ name: '原文风示范', text: legacyExample }],
        polishExampleSelection: '原文风示范',
        other: true,
    });
    assert.equal(migratePolishExample(settings), false);
    settings.polishExample = '旧字段';
    settings.polishExamples = [];
    assert.equal(migratePolishExample(settings), true);
    assert.deepEqual(settings.polishExamples, []);
});

test('applies only the selected swipe and restores the exact raw text even after display regex', async () => {
    const raw = '<hidden>' + '字'.repeat(12001) + '</hidden>' + original;
    const message = {
        mes: raw, swipe_id: 1, swipes: ['旧稿', raw],
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
    const target = { message, index: 1, swipeId: 1, text: original, rawText: raw, chatId, chatLength: 2 };
    assert.ok(samePolishTarget(st, target));
    await writePolishedReply(st, target, revised, raw, () => st);
    assert.equal(message.mes, revised);
    assert.deepEqual(message.swipes, ['旧稿', revised]);
    assert.deepEqual(message.extra, { reasoning: '原推理' });
    assert.deepEqual(message.swipe_info, [{ extra: { display_text: '旧稿译文' } }, { extra: {} }]);
    assert.equal(st.chatMetadata.tainted, true);
    assert.deepEqual(calls, [['render', 1, revised], ['edited', 1], ['render', 1, revised], ['updated', 1], ['save']]);

    await writePolishedReply(st, target, raw, revised, () => st);
    assert.equal(message.mes, raw);
    assert.deepEqual(message.swipes, ['旧稿', raw]);

    st.chat.push({ mes: '继续', is_user: true });
    await assert.rejects(writePolishedReply(st, target, revised, raw, () => st), /已变化/);
    st.chat.pop();
    message.swipe_id = 0;
    assert.equal(samePolishTarget(st, target), false);
    message.swipe_id = 1;
    chatId = 'other-chat';
    assert.equal(samePolishTarget(st, target), false);
    assert.equal(message.mes, raw);
});
