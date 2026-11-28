import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendLogicFindings, parseLogicFindings, prepareLogicCheck } from '../logic-check.js';
import { getChatMessages } from '../prompts.js';

const history = getChatMessages([
    { mes: '这里是更早的背景。', name: '测试', is_user: false },
    { mes: '请分别说明工作日和周末的生效条件。', name: '用户', is_user: true },
    { mes: '该设置在工作日启用。\n该设置在工作日停用。', name: '模型', is_user: false },
    { mes: '这里是下一条未回答的提问。', name: '用户', is_user: true },
]);

const contradiction = {
    category: '前后矛盾', issue: '同一设置在工作日被描述为启用和停用。',
    followup: '请明确该设置在工作日的状态，并解释生效条件。',
    evidence: [{ id: 3, quote: '该设置在工作日启用。' }, { id: 3, quote: '该设置在工作日停用。' }],
};
const omission = {
    category: '漏答或遗漏要求', issue: '原问题要求解释周末，回复只涉及工作日。',
    followup: '请补充该设置在周末生效的条件。',
    evidence: [{ id: 2, quote: '请分别说明工作日和周末的生效条件。' }],
};
const fixture = (...findings) => JSON.stringify({ findings });

test('uses preceding user question and the latest reply, excluding the draft and unresponded messages', () => {
    const check = prepareLogicCheck({ history, historyCount: 1, draft: '私有草稿' });
    assert.deepEqual([...check.sources.keys()], [3, 2]);
    assert.match(check.prompt[1].content, /原问题[\s\S]*待检查的模型回复/);
    assert.doesNotMatch(check.prompt[1].content, /私有草稿|下一条未回答/);
    assert.equal(check.target.index, 2);
    assert.throws(() => prepareLogicCheck({ history: [], historyCount: 0 }), /没有可检查/);
});

test('validates both contradiction excerpts and requires the original question for an omission', () => {
    const check = prepareLogicCheck({ history, historyCount: 2 });
    const findings = parseLogicFindings(fixture(contradiction, omission), check);
    assert.equal(findings.length, 2);
    assert.deepEqual(findings[0].evidence.map(item => item.role), ['模型', '模型']);
    assert.equal(findings[1].evidence[0].role, '用户');
    const wrongQuote = { ...contradiction, evidence: [contradiction.evidence[0], { id: 3, quote: '这句并没有说过' }] };
    const overlapping = { ...contradiction, evidence: [contradiction.evidence[0], { id: 3, quote: '工作日启用' }] };
    assert.throws(() => parseLogicFindings(fixture(wrongQuote), check), /引文/);
    assert.throws(() => parseLogicFindings(fixture(overlapping), check), /引文/);

    const withoutContext = prepareLogicCheck({ history, historyCount: 0, pinned: 1 });
    assert.deepEqual([...withoutContext.sources.keys()], [3]);
    assert.throws(() => parseLogicFindings(fixture(omission), withoutContext), /引文/);
    assert.deepEqual(parseLogicFindings(fixture(), withoutContext), []);
});

test('appends selected corrections without replacing draft text or duplicating guidance', () => {
    const draft = '我还想问一个问题。  ';
    const withOne = appendLogicFindings(draft, [contradiction]);
    assert.match(withOne, /^我还想问一个问题。\n\n【请复查并修正上一条回复】/);
    assert.equal(appendLogicFindings(withOne, [contradiction]), withOne);
    const withBoth = appendLogicFindings(withOne, [contradiction, omission]);
    assert.equal(withBoth.match(/【请复查并修正上一条回复】/g).length, 1);
    assert.match(withBoth, /补充该设置在周末生效的条件/);
});

test('accepts fenced reports with a preamble, arrays, and plain Markdown', () => {
    const check = prepareLogicCheck({ history, historyCount: 2 });
    const style = { ...contradiction, category: 'AI八股' };
    for (const reply of ['报告如下：\n```json\n' + fixture(style) + '\n```', JSON.stringify([style])]) {
        assert.equal(parseLogicFindings(reply, check)[0].category, 'AI八股');
    }
    const report = '### 动作衔接\n人物仍拿着杯子，下一句却用同一只手开门。';
    const findings = parseLogicFindings(report, check);
    const inserted = appendLogicFindings('保留结尾', findings);
    assert.ok(inserted.includes(report));
    assert.equal(appendLogicFindings(inserted, findings), inserted);
    assert.throws(() => parseLogicFindings('{"findings":[', check), /不完整/);
});

test('distinguishes a truncated response, reasoning-only response, and empty response', () => {
    const check = prepareLogicCheck({ history, historyCount: 2 });
    assert.throws(() => parseLogicFindings({ text: '', finishReason: 'length', outputTokens: 4096 }, check), /4096 tokens/);
    assert.throws(() => parseLogicFindings({ text: '', reasoning: '正在分析' }, check), /只返回了思考/);
    assert.throws(() => parseLogicFindings({ text: '<think>正在分析</think>' }, check), /只返回了思考/);
    assert.throws(() => parseLogicFindings({ text: '' }, check), /没有返回逻辑检查正文/);
    assert.equal(parseLogicFindings({ text: fixture(contradiction), finishReason: 'stop' }, check).length, 1);
});
