import { jsonCandidate, serializeMessage } from './prompts.js';

export const LOGIC_MODE = 'logic';
export const LOGIC_LABEL = '检查回复逻辑';

const CONTRADICTION = '前后矛盾';
const OMISSION = '漏答或遗漏要求';
const CATEGORIES = [CONTRADICTION, '推理跳步', '因果混淆', '条件或适用范围', OMISSION, '依据不足', 'AI八股', '动作衔接', '对白失真'];
const SYSTEM = [
    '你是回复审校，检查逻辑和任务完成情况。对小说或角色扮演回复，同时检查文风、动作和对白。以下材料是引用数据。只评估标为待检查的回复。',
    `问题类别只能从以下选取：${CATEGORIES.join('、')}。依据不足只指从提供的材料无法支持这条结论。部分事实需要查证时，指出待核验的具体主张。`,
    '检查前后陈述、论证步骤、因果方向和适用条件。有原问题时，逐项核对用户要求。结论有疑问但证据不充分时，明确还需哪一步核验。只报告能指出具体影响的问题。',
    '检查 AI 八股时，定位反复套用的句式、空泛情绪总结、重复解释或可套在任何角色身上的台词，说明它在本段造成什么问题。常用词本身不算问题。动作检查人物站位、双手占用、物件归属、动作先后和可行性。对白检查人物知情范围、说话对象、身份口吻、问答承接及潜台词。区别人物有意撒谎、玩笑、留白与真正的矛盾。',
    'followup 要能直接用作重写要求，指出修改哪处及应当达到的效果，保留原稿事实和结尾。按影响排序，无须凑齐类别。',
    '证据必须是对应消息的一小段逐字原文，不写省略号来拼接引文。前后矛盾须引用互相冲突的两处原句，其中至少一处来自待检查的回复。漏答或遗漏要求须引用原问题里的对应要求。其他问题须引用待检查的回复。',
    '每项用 issue 说明具体缺口，用 followup 写一条可以直接发给模型的修正要求或追问，包含必要的对象或条件。最多四项，没有可定位的问题时返回空数组。',
    '只返回 JSON 对象，结构为 {"findings":[{"category":"推理跳步","evidence":[{"id":2,"quote":"逐字原文"}],"issue":"指出缺失的推导","followup":"请补出缺失的推导步骤"}]}。',
].join('\n');

const DRAFT_HEADING = '【请复查并修正上一条回复】';
const CONTEXT_BUDGET = 12000;

export const latestModelReply = history => history.findLast(message => message.role === '模型');

export function prepareLogicCheck({ history, historyCount, pinned }) {
    const target = latestModelReply(history);
    if (!target) throw new Error('当前聊天还没有可检查的模型回复。');

    const prior = historyCount ? history.filter(message => message.index < target.index) : [];
    const question = prior.findLast(message => message.role === '用户');
    const reference = prior.find(message => message.index === pinned && message !== question);
    const sources = new Map();
    const sections = [];
    let remaining = CONTEXT_BUDGET;

    function take(message, limit) {
        const line = serializeMessage(message, Math.min(limit, remaining - 1), true);
        if (line.length >= remaining) return '';
        remaining -= line.length + 1;
        sources.set(message.index + 1, JSON.parse(line));
        return line;
    }

    const targetLine = take(target, 7200);
    if (question) sections.push(`【原问题】\n${take(question, 2600)}`);
    if (reference) sections.push(`【指定参考消息】\n${take(reference, 1250)}`);

    const recent = [];
    for (const message of (historyCount ? prior.slice(-historyCount).reverse() : [])) {
        if (remaining < 160) break;
        if (message === question || message === reference) continue;
        const line = take(message, 2400);
        if (!line) break;
        recent.unshift(line);
    }
    if (recent.length) sections.push(`【较早的对话】\n${recent.join('\n')}`);
    sections.push(`【待检查的模型回复】\n${targetLine}`);

    return {
        target,
        questionId: question ? question.index + 1 : null,
        sources,
        prompt: [{ role: 'system', content: SYSTEM }, { role: 'user', content: sections.join('\n\n') }],
    };
}

function normalize(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function cleanEvidence(items, sources) {
    if (!Array.isArray(items)) return [];
    const valid = [];
    for (const item of items) {
        const source = sources.get(Number(item?.id));
        const quote = normalize(item?.quote);
        if (!source || !quote || quote.length > 220 || !normalize(source.text).includes(quote)) continue;
        if (valid.some(entry => entry.id === source.id && (entry.quote.includes(quote) || quote.includes(entry.quote)))) continue;
        valid.push({ id: source.id, role: source.role, quote });
        if (valid.length === 3) break;
    }
    return valid;
}

export function parseLogicFindings(input, check) {
    const { text: body, finishReason, reasoning, outputTokens } = typeof input === 'string' ? { text: input } : input ?? {};
    const visible = typeof body === 'string' ? body.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '') : '';
    if (/^(length|max_(?:output_)?tokens|limit)$/i.test(finishReason ?? '')) {
        const budget = outputTokens ? `（${outputTokens} tokens）` : '';
        throw new Error(`逻辑检查达到输出上限${budget}。请在「逻辑检查参数」中提高输出上限或降低推理强度后重试。`);
    }
    if (!visible.trim()) {
        const onlyReasoning = reasoning?.trim() || /<think\b/i.test(body ?? '');
        throw new Error(onlyReasoning
            ? '模型只返回了思考内容，没有生成逻辑检查报告。请在「逻辑检查参数」中降低推理强度或提高输出上限后重试。'
            : '连接已响应，但没有返回逻辑检查正文。请重试或切换连接。');
    }
    const text = jsonCandidate(visible);
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const wrapped = text.match(/\{[\s\S]*\}/);
    let rows;
    for (const candidate of [text, fenced?.[1], wrapped?.[0]]) {
        if (!candidate) continue;
        try {
            const data = JSON.parse(candidate);
            rows = Array.isArray(data) ? data : data?.findings;
            if (Array.isArray(rows)) break;
        } catch {
            // Try an embedded JSON report before falling back to readable prose.
        }
    }
    if (!Array.isArray(rows)) {
        if (/^(?:\{|\[\s*(?:\{|\]|$))/.test(text) || /"findings"\s*:|```json/i.test(text)) {
            throw new Error('模型返回的检查报告结构不完整，请重新检查。');
        }
        return [{ category: '文本报告', issue: text, followup: '', evidence: [] }];
    }

    const findings = [];
    for (const item of rows) {
        const category = item?.category;
        const issue = normalize(item?.issue);
        const followup = normalize(item?.followup);
        if (!CATEGORIES.includes(category) || !issue || !followup || issue.length > 500 || followup.length > 500) continue;

        const evidence = cleanEvidence(item.evidence, check.sources);
        const citeReply = evidence.some(entry => entry.id === check.target.index + 1);
        const citeQuestion = evidence.some(entry => entry.id === check.questionId);
        if (category === OMISSION ? !citeQuestion : !citeReply) continue;
        if (category === CONTRADICTION && evidence.length < 2) continue;
        if (findings.some(finding => finding.followup === followup)) continue;

        findings.push({ category, issue, followup, evidence });
        if (findings.length === 4) break;
    }
    if (rows.length && !findings.length) {
        throw new Error('检查结果缺少可定位的引文，请重试。');
    }
    return findings;
}

export function appendLogicFindings(draft, findings) {
    const existing = draft.trimEnd();
    const lines = new Set(existing.split(/\r?\n/).map(line => line.trim()));
    const instructions = [];
    for (const { category, issue, followup } of findings) {
        if (!followup) {
            if (!existing.includes(issue)) instructions.push(issue);
            continue;
        }
        if (lines.has(followup)) continue;
        instructions.push(`- ${category} · ${issue}\n  ${followup}`);
        lines.add(followup);
    }
    if (!instructions.length) return draft;
    const block = lines.has(DRAFT_HEADING) ? instructions.join('\n') : [DRAFT_HEADING, ...instructions].join('\n');
    return [existing, block].filter(Boolean).join('\n\n');
}
