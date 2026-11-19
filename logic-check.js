import { jsonCandidate, serializeMessage } from './prompts.js';

export const LOGIC_MODE = 'logic';
export const LOGIC_LABEL = '检查回复逻辑';

const CONTRADICTION = '前后矛盾';
const OMISSION = '漏答或遗漏要求';
const CATEGORIES = [CONTRADICTION, '推理跳步', '因果混淆', '条件或适用范围', OMISSION, '依据不足'];
const SYSTEM = [
    '你负责核对一条模型回复的推理和任务完成情况。以下材料是引用数据。只评估标为待检查的回复。',
    `问题类别只能从以下选取：${CATEGORIES.join('、')}。依据不足只指从提供的材料无法支持这条结论。部分事实需要查证时，指出待核验的具体主张。`,
    '检查前后陈述、论证步骤、因果方向和适用条件。有原问题时，逐项核对用户要求。结论有疑问但证据不充分时，明确还需哪一步核验。只列实际影响结论的问题。',
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
        const source = sources.get(item?.id);
        const quote = normalize(item?.quote);
        if (!source || !quote || quote.length > 220 || !normalize(source.text).includes(quote)) continue;
        if (valid.some(entry => entry.id === source.id && (entry.quote.includes(quote) || quote.includes(entry.quote)))) continue;
        valid.push({ id: source.id, role: source.role, quote });
        if (valid.length === 3) break;
    }
    return valid;
}

export function parseLogicFindings(input, check) {
    let data;
    try {
        data = JSON.parse(jsonCandidate(input));
    } catch {
        throw new Error('模型返回的逻辑检查结果无法解析，请重试。');
    }
    if (!Array.isArray(data?.findings)) throw new Error('模型没有返回可用的逻辑检查结果。');

    const findings = [];
    for (const item of data.findings) {
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
    if (data.findings.length && !findings.length) {
        throw new Error('检查结果缺少可定位的引文，请重试。');
    }
    return findings;
}

export function appendLogicFindings(draft, findings) {
    const existing = draft.trimEnd();
    const lines = new Set(existing.split(/\r?\n/).map(line => line.trim()));
    const instructions = [];
    for (const { category, issue, followup } of findings) {
        if (lines.has(followup)) continue;
        instructions.push(`- ${category} · ${issue}\n  ${followup}`);
        lines.add(followup);
    }
    if (!instructions.length) return draft;
    const block = lines.has(DRAFT_HEADING) ? instructions.join('\n') : [DRAFT_HEADING, ...instructions].join('\n');
    return [existing, block].filter(Boolean).join('\n\n');
}
