import assert from 'node:assert/strict';
import test from 'node:test';
import { getChatMessages } from '../prompts.js';
import { prepareReplyPolish } from '../reply-polish.js';
import { approvedChanges, buildRevisionStage, parseRevisionStage, revisionStages } from '../revision-team.js';

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
    assert.deepEqual(revisionStages('adjust', true), ['review', 'plan', 'write', 'audit']);
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
