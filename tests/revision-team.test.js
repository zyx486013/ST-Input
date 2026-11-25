import assert from 'node:assert/strict';
import test from 'node:test';
import { getChatMessages } from '../prompts.js';
import { prepareReplyPolish } from '../reply-polish.js';
import { approvedChanges, buildRevisionStage, parseRevisionStage, revisionStageNeeded, revisionStages } from '../revision-team.js';

const source = {
    history: getChatMessages([{ mes: '她差点拨出去。她又复述了接线员的回答。\n\n<StatusBlock>精力=10</StatusBlock>' }]),
    historyCount: 0, polishExample: '文风范文', polishNotes: '保留结尾。', rewrite: true,
};
const request = prepareReplyPolish(source);
const reply = data => ({ text: JSON.stringify(data), finishReason: 'stop' });
const quote = '她差点拨出去。';
const review = { facts: ['她提起了通话。'], issues: [{ quote, problem: '与接线员的回答相冲突。' }] };
const choices = [{ quote, issue: '是否真的拨了电话', options: [
    { title: '有通话', change: '把差点拨出去改成已经通话。' },
    { title: '无通话', change: '去掉对接线员回答的复述。' },
] }];
const plan = { opening: '从她对通话的复述切入。', beats: ['电话与复述。'], choices };

test('routes the stages and requires exact evidence from the regex-processed draft', () => {
    assert.deepEqual(revisionStages('review', true), ['review']);
    assert.deepEqual(revisionStages('preserve', false), ['review', 'plan', 'write']);
    assert.deepEqual(revisionStages('adjust', true), ['review', 'plan', 'write', 'audit', 'repair', 'verify']);
    assert.deepEqual(parseRevisionStage('review', 'review', reply(review), request.narrative), review);
    assert.throws(() => parseRevisionStage('review', 'review', reply({ ...review, issues: [{ ...review.issues[0], quote: '原稿没有这句话' }] }), request.narrative), /引文与原文不符/);
    assert.throws(() => parseRevisionStage('review', 'review', { text: '{}', finishReason: 'length' }, request.narrative), /输出长度上限/);
});

test('preserve mode drops proposed plot changes and only opted-in choices reach the style editor', () => {
    const results = { review };
    const planning = buildRevisionStage('plan', 'adjust', request, results, []);
    assert.match(planning[1].content, /<editorial_review>[\s\S]+与接线员的回答相冲突/);
    assert.doesNotMatch(planning[1].content, /文风范文|精力=10/);
    assert.deepEqual(parseRevisionStage('plan', 'preserve', reply(plan), request.narrative).choices, []);
    const selectedPlan = parseRevisionStage('plan', 'adjust', reply(plan), request.narrative);
    assert.deepEqual(approvedChanges(selectedPlan.choices, [-1]), []);
    const approved = approvedChanges(selectedPlan.choices, [0]);
    const { prompt } = prepareReplyPolish({ ...source, teamPlan: {
        outline: { opening: selectedPlan.opening, beats: selectedPlan.beats }, approved, materials: request.revisionMaterials,
    } });
    assert.match(prompt[0].content, /只有 <approved_changes> 中用户选定的条目才可调整/);
    assert.doesNotMatch(prompt[0].content, /<summary>重排场记/);
    assert.match(prompt[1].content, /文风范文[\s\S]+<revision_plan>[\s\S]+<approved_changes>[\s\S]+把差点拨出去改成已经通话/);
    assert.doesNotMatch(prompt[1].content, /去掉对接线员回答的复述|精力=10/);
});

test('final review accepts evidence from either draft and receives only confirmed changes', () => {
    const write = '她打了电话，事后复述了接线员的回答。';
    const issues = { issues: [{ quote: '她打了电话', problem: '稿中把未定的事实定了下来。' }] };
    const prompt = buildRevisionStage('audit', 'preserve', request, { write }, []);
    assert.match(prompt[1].content, /<approved_changes>\n> \[\]\n<\/approved_changes>/);
    assert.match(prompt[1].content, /<revised_draft>\n> 她打了电话/);
    assert.deepEqual(parseRevisionStage('audit', 'preserve', reply(issues), request.narrative, write), issues);
});

test('a clean review sends the draft straight to the style editor', () => {
    assert.equal(revisionStageNeeded('plan', { review }), true);
    assert.equal(revisionStageNeeded('plan', { review: { ...review, issues: [] } }), false);
    const { prompt } = prepareReplyPolish({ ...source, teamPlan: { approved: [], materials: request.revisionMaterials } });
    assert.match(prompt[0].content, /无场记时按原稿组织/);
    assert.doesNotMatch(prompt[1].content, /<revision_plan>|undefined/);
    assert.match(prompt[1].content, /<approved_changes>/);
});

test('only a concrete audit finding starts repairs, and only an actual repair is reviewed', () => {
    const write = '她打了电话。\n\n她拉开窗帘。';
    const audit = { issues: [{ quote: '她打了电话。', problem: '把原稿的未遂改成了已完成。' }] };
    assert.equal(revisionStageNeeded('repair', { audit: { issues: [] } }), false);
    assert.equal(revisionStageNeeded('repair', { audit }), true);
    const empty = parseRevisionStage('repair', 'preserve', reply({ edits: [] }), request.narrative, write);
    assert.equal(revisionStageNeeded('verify', { repair: empty }), false);
    const repair = parseRevisionStage('repair', 'preserve', reply({ edits: [
        { before: '她打了电话。', after: quote },
    ] }), request.narrative, write);
    assert.deepEqual(repair, {
        text: quote + '\n\n她拉开窗帘。',
        edits: [{ before: '她打了电话。', after: quote }],
    });
    assert.equal(revisionStageNeeded('verify', { repair }), true);
    const prompt = buildRevisionStage('verify', 'preserve', request, { write, audit, repair }, [], source.polishExample);
    assert.match(prompt[1].content, /<revised_draft>\n> 她差点拨出去。/);
    assert.match(prompt[1].content, /<audit_issues>[\s\S]+"id":1,[\s\S]+未遂改成了已完成/);
    assert.match(prompt[1].content, /<applied_edits>\n> \[{"id":1,"before":"她打了电话。","after":"她差点拨出去。"}\]/);
    assert.match(prompt[1].content, /<style_sample>/);
});

test('partly successful repairs pass when they introduce no regressions', () => {
    const write = '她打了电话。她拉开窗帘。';
    const wrongCall = { quote: '她打了电话。', problem: '把未遂写成了已完成。' };
    const extraAction = { quote: '她拉开窗帘。', problem: '加了额外动作。' };
    const audit = { issues: [wrongCall, extraAction] };
    const repair = { text: quote + extraAction.quote, edits: [{ before: wrongCall.quote, after: quote }] };
    const verify = data => parseRevisionStage('verify', 'preserve', reply(data), request.narrative, write, { audit, repair });

    assert.deepEqual(verify({ remaining: [2], introduced: [] }), {
        remaining: [extraAction], introduced: [], fixed: 1, accepted: true,
    });
    assert.equal(verify({ remaining: [], introduced: [] }).accepted, true);
    assert.equal(verify({ remaining: [1, 2], introduced: [] }).accepted, false);
    assert.throws(() => verify({ remaining: [1, 1], introduced: [] }), /编号重复/);
    assert.throws(() => verify({ remaining: [3], introduced: [] }), /编号无效/);
    assert.throws(() => verify({ remaining: [], introduced: [{ edit: 1, ...extraAction }] }), /引文与所指的返工片段不符/);

    const introduced = { quote: wrongCall.quote, problem: '返工删去了必须保留的台词。' };
    assert.deepEqual(verify({ remaining: [2], introduced: [{ edit: 1, ...introduced }] }), {
        remaining: [extraAction], introduced: [introduced], fixed: 1, accepted: false,
    });
});

test('patches use exact, unique, non-overlapping anchors in the original candidate', () => {
    const draft = '开门。关窗。开门。';
    const parse = edits => parseRevisionStage('repair', 'preserve', reply({ edits }), request.narrative, draft);
    assert.throws(() => parse([{ before: '开门。', after: '' }]), /唯一出现/);
    assert.throws(() => parse([{ before: '回头。', after: '' }]), /唯一出现/);
    assert.throws(() => parse([
        { before: '开门。关窗', after: '站住。' },
        { before: '关窗。', after: '合窗。' },
    ]), /重叠/);
    const edits = [
        { before: '开门。关窗', after: '开门。等雨' },
        { before: '。开门。', after: '。坐下。' },
    ];
    assert.deepEqual(parse(edits.toReversed()), { text: '开门。等雨。坐下。', edits });
});
