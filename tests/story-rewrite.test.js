import assert from 'node:assert/strict';
import test from 'node:test';
import { getChatMessages } from '../prompts.js';
import { prepareReplyPolish } from '../reply-polish.js';
import { revisionStages } from '../revision-team.js';
import { buildPlotExtraction, buildStoryRewrite, parseExtractedPlot, verifyStoryLocks } from '../story-rewrite.js';

const source = {
    history: getChatMessages([{ mes: '上文的独有文字。', is_user: true }, {
        mes: '渡口\n\n船夫翻出一枚铜钱。\n“这回免了。”\n\n<StatusBlock>精力=002</StatusBlock>',
    }]),
    historyCount: 1, rewrite: true, polishExample: '范文独有文本。', polishNotes: '',
    displayText: message => message.text.replace('翻出', '取出'),
};
const request = prepareReplyPolish(source);
const plot = {
    title: '渡口', viewpoint: '中文，第三人称', voices: ['船夫说话短促'],
    scenes: [{ setting: '渡口，时刻未交代', beats: [
        { event: '船夫拿出铜钱', dialogue: ['船夫 → 对方｜免收这次费用，语气随意'], locked: [] },
    ] }], ending: '船夫表示免收费用，留下对方的反应。',
};
const reply = data => ({ text: JSON.stringify(data), finishReason: 'stop' });

test('sends the regex-processed original only to extraction and the selected style only to composition', () => {
    assert.deepEqual(revisionStages('rewrite', true), ['extract', 'write']);
    const extraction = buildPlotExtraction(request);
    assert.match(extraction[1].content, /<draft_to_rewrite>[\s\S]+船夫取出一枚铜钱/);
    assert.match(extraction[1].content, /上文的独有文字/);
    assert.doesNotMatch(extraction[1].content, /范文独有文本|精力=002|^从 <draft_to_rewrite>/m);
    const extracted = parseExtractedPlot(reply({ ...plot, original: request.narrative }), request.narrative, '');
    assert.deepEqual(extracted, plot);
    const rewrite = buildStoryRewrite(extracted, { ...source, matchExampleDiction: true });
    assert.match(rewrite[0].content, /角色自己的话将 dialogue 写成直接对白/);
    assert.match(rewrite[0].content, /加强用词对齐/);
    assert.match(rewrite[1].content, /范文独有文本[\s\S]+<extracted_plot>[\s\S]+免收这次费用/);
    assert.doesNotMatch(rewrite[1].content, /<draft_to_rewrite>|<recent_chat>|上文的独有文字|船夫取出一枚铜钱|这回免了|精力=002/);
    assert.doesNotMatch(buildStoryRewrite(plot, { ...source, polishExample: '' })[1].content, /<style_sample>/);
});

test('rejects truncated extracts and verifies explicit in-order verbatim passages in the finished draft', () => {
    const excerpt = '“这回免了。”';
    const lockedPlot = structuredClone(plot);
    lockedPlot.scenes[0].beats[0].locked.push(excerpt);
    assert.throws(() => parseExtractedPlot(reply(lockedPlot), request.narrative, ''), /逐字保留片段缺少要求/);
    const parsed = parseExtractedPlot(reply(lockedPlot), request.narrative, '保留对白原话');
    assert.doesNotThrow(() => verifyStoryLocks(`渡口\n\n船夫把铜子亮给他看。${excerpt}`, parsed));
    assert.throws(() => verifyStoryLocks('渡口\n\n“少收你一趟钱。”', parsed), /遗漏或改动了逐字保留片段/);
    assert.throws(() => verifyStoryLocks(excerpt, parsed), /缺少原题/);
    assert.throws(() => parseExtractedPlot(reply({ ...plot, title: '船上' }), request.narrative, ''), /标题与原稿开头不符/);
    assert.throws(() => parseExtractedPlot({ ...reply(plot), finishReason: 'length' }, request.narrative, ''), /输出长度上限/);
});
