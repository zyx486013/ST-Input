import assert from 'node:assert/strict';
import test from 'node:test';
import { getChatMessages } from '../prompts.js';
import { restoreRevisionComponents, splitRevisionComponents } from '../revision-components.js';
import { buildRewritePrompt, preparePlotRequest, readRewriteText } from '../story-rewrite.js';

const source = {
    history: getChatMessages([
        { mes: '上文的独有文字。', is_user: true },
        { mes: '渡口\n\n船夫翻出一枚铜钱。\n“这回免了。”\n\n<StatusBlock>精力=002</StatusBlock>' },
        { mes: '后来才说的话。', is_user: true },
    ]),
    historyCount: 1, pinned: 0, polishExample: '范文独有文本。', polishNotes: '保留结尾。',
    displayText: message => message.text.replace('翻出', '取出'),
};
const plot = '### 渡口\n- 船夫拿出铜钱。\n- 船夫很随意地告诉乘客，这次免收费用，等乘客回应。';

test('keeps the original and chat reference in extraction, then writes from editable plot text and the selected example', () => {
    const { target, prompt } = preparePlotRequest(source);
    assert.match(prompt[0].content, /普通段落、列表或 Markdown 都可以/);
    assert.match(prompt[0].content, /谁在对谁说、话的实质信息、目的和语气/);
    assert.match(prompt[1].content, /【原回复】[\s\S]+船夫取出一枚铜钱/);
    assert.match(prompt[1].content, /指定参考消息[\s\S]+上文的独有文字/);
    assert.doesNotMatch(prompt[1].content, /范文独有文本|精力=002|后来才说的话/);
    const prose = '船夫摆手：“这趟不收你的。”';
    assert.equal(restoreRevisionComponents(prose, target.revisionComponents), prose + '\n\n<StatusBlock>精力=002</StatusBlock>');

    const rewrite = buildRewritePrompt(plot.replace('很随意', '低声'), { ...source, matchExampleDiction: true });
    assert.match(rewrite[0].content, /把对白要点写成角色实际说出口的话/);
    assert.match(rewrite[0].content, /加强用词对齐/);
    assert.match(rewrite[1].content, /【剧情记录】\n> ### 渡口[\s\S]+低声地告诉乘客[\s\S]+【文风示范】\n> 范文独有文本/);
    assert.match(rewrite[1].content, /【本次要求】\n> 保留结尾/);
    assert.doesNotMatch(rewrite[1].content, /上文的独有文字|船夫取出一枚铜钱|这回免了|精力=002/);
    assert.doesNotMatch(buildRewritePrompt(plot, { ...source, polishExample: '' })[1].content, /【文风示范】/);
});

test('uses flexible text at both stages and reports genuinely empty or truncated results', () => {
    for (const value of [plot, '船夫拿出铜钱。随后告诉乘客这次免收。', '- 从渡口出发\n- 船夫免收费用']) {
        assert.equal(readRewriteText({ text: value, finishReason: 'stop' }, '剧情提取'), value);
    }
    assert.equal(readRewriteText({ text: JSON.stringify({ plot }) }, '剧情提取'), plot);
    const fenced = '\x60\x60\x60json\n' + JSON.stringify({ content: plot }) + '\n\x60\x60\x60';
    assert.equal(readRewriteText({ text: fenced }, '剧情提取'), plot);
    const rawJson = '{"scenes":["渡口"]}';
    assert.equal(readRewriteText({ text: rawJson }, '剧情提取'), rawJson);
    assert.equal(readRewriteText({ text: '# 渡口\n\n“这趟我请。”' }, '重写'), '# 渡口\n\n“这趟我请。”');
    assert.equal(readRewriteText({ text: '  渡口\n\n“这趟我请。”\n' }, '重写'), '  渡口\n\n“这趟我请。”\n');
    assert.throws(() => readRewriteText({ text: ' ', reasoning: '可见推理摘要' }, '剧情提取'), /只返回了思考内容/);
    for (const text of ['', '{}', '{"plot":"  "}']) {
        assert.throws(() => readRewriteText({ text }, '剧情提取'), /空文本/);
    }
    assert.throws(() => readRewriteText({ text: plot, finishReason: 'length', outputTokens: 128 }, '剧情提取'), /剧情提取达到输出长度上限.+128 tokens/);
    assert.throws(() => buildRewritePrompt(' ', source), /提取或填写剧情记录/);
});

test('preserves original edge components even when a display regex transforms or hides them', () => {
    const prefix = '  <details open>\r\n<summary>状态</summary><details>备用</details>\r\n</details>\r\n\r\n';
    const suffix = '\r\n\r\n<StatusBlock data-name="x > y">\r\n值 = 001\r\n</StatusBlock>\r\n\r\n【选项】\r\n1. 返回\r\n2. 等候\r\n';
    const raw = prefix + '原始正文。' + suffix;
    const displayText = ({ text }) => text.replace(/<StatusBlock\b[\s\S]+?<\/StatusBlock>/g, '')
        .replace(prefix.trim(), '<aside>显示状态</aside>').replace('原始正文。', '显示正文。');
    const { target, prompt } = preparePlotRequest({ history: getChatMessages([{ mes: raw }]), displayText });
    assert.equal(target.rawText, raw);
    assert.deepEqual(target.revisionComponents, { prefix, suffix });
    assert.match(prompt[1].content, /【原回复】\n> 显示正文。/);
    assert.doesNotMatch(prompt[1].content, /状态|选项|001|<aside>/);
    assert.equal(restoreRevisionComponents('新正文。\n<StatusBlock>模型改写的数值</StatusBlock>', target.revisionComponents),
        prefix + '新正文。' + suffix);
});

test('detects fenced edge components without dropping code or inline components in the story', () => {
    const prefix = '\x60\x60\x60text\n【状态栏】\n心情: 平静\n\x60\x60\x60\n\n';
    const body = '开头。\n\n<StatusBlock>详见原文</StatusBlock>\n\n继续。\n\n\x60\x60\x60js\nconsole.log("结尾");\n\x60\x60\x60';
    const suffix = '\n\n~~~choices\n- 继续\n~~~\n';
    assert.deepEqual(splitRevisionComponents(prefix + body + suffix), { prefix, body, suffix });
    assert.throws(() => restoreRevisionComponents(prefix.trimEnd(), { prefix, suffix }), /只返回了状态组件/);
});
