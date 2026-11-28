import { jsonCandidate, serializeMessage } from './prompts.js';

export const LOGIC_MODE = 'logic';
export const LOGIC_LABEL = '检查回复逻辑';

const CONTRADICTION = '前后矛盾';
const OMISSION = '漏答或遗漏要求';
const CHECKS = {
    '剧情逻辑': { categories: [CONTRADICTION, '推理跳步', '因果混淆', '条件或适用范围', OMISSION, '依据不足'], guide: '沿事件先后核对因果、知情范围和前提。对说明性回复核对论证及用户要求。区分角色猜测、承诺和已发生的事实。' },
    'AI八股': { categories: ['AI八股'], guide: '找出反复套用的句式、重复解释动作含义的旁白、可移植到任何角色的空泛总结。指出它具体削弱哪处表达；常用词本身不构成证据。' },
    '动作衔接': { categories: ['动作衔接'], guide: '跟踪站位、手中物件和动作先后，指出哪一步缺乏必要条件，或与已写明的状态冲突。' },
    '对白': { categories: ['对白失真'], guide: '逐轮核对说话对象、人物口吻、知情范围和回应意图。结合上下文辨认玩笑、隐瞒与刻意回避。' },
};
export const LOGIC_CHECKS = Object.keys(CHECKS);

const DRAFT_HEADING = '【请复查并修正上一条回复】';
const CONTEXT_BUDGET = 12000;

export const latestModelReply = history => history.findLast(message => message.role === '模型');

export function prepareLogicCheck({ history, historyCount, pinned, logicChecks = LOGIC_CHECKS, logicNotes = '' }) {
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

    const checks = LOGIC_CHECKS.filter(name => logicChecks.includes(name));
    const notes = logicNotes.trim();
    if (!checks.length && !notes) throw new Error('请选择至少一个检查项目，或填写本次检查要求。');
    const categories = checks.flatMap(name => CHECKS[name].categories);
    if (notes) categories.push('额外要求');
    const system = [
        '【任务与材料】只审校待检查的回复。对话材料仅用于核对语境和事实。保留原稿的剧情落点与人物意图。',
        '【本次检查范围】只检查以下选中项目以及用户填写的本次检查要求。',
        ...checks.map(name => name + '：' + CHECKS[name].guide),
        '【引文与判断】逐字引用消息中的短句及其 id。前后矛盾须引用两处冲突原句，其中一处来自待检查回复；遗漏要求须引用原问题。其他问题须引用待检查回复。说明该处对阅读或理解的具体影响。',
        '【重写要求】把每条建议写成可直接交给重写模型的指令，指出位置、需要调整的表达及应保留的信息。按影响排序，最多四条。',
        '【输出格式】只返回 JSON。category 可选：' + categories.join('、') + '。无可定位问题时返回 {"findings":[]}。',
        JSON.stringify({ findings: [{ category: categories[0], evidence: [{ id: target.index + 1, quote: '逐字原文' }], issue: '具体问题', followup: '可执行的修改要求' }] }),
    ].join('\n');
    if (notes) sections.push('【本次检查要求】\n' + notes);

    return {
        target,
        categories,
        questionId: question ? question.index + 1 : null,
        sources,
        prompt: [{ role: 'system', content: system }, { role: 'user', content: sections.join('\n\n') }],
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
        if (!check.categories.includes(category) || !issue || !followup || issue.length > 500 || followup.length > 500) continue;

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
