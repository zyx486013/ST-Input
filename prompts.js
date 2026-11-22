import { readReview } from './writing-guidance.js';

export const REVIEW_MODE = 'review';
export const REVIEW_LABEL = '分析上一条回复';

export const MODES = {
    rewrite: '帮我说清楚',
    clarify: '先问我',
    followup: '帮我追问',
};

const TASKS = {
    [REVIEW_MODE]: '以用户原提问为对照，审阅指定回复的文风、逻辑、结构、表达清晰度和需求覆盖。只报告实际影响阅读的具体问题。每项引用原回复一处原文，说明问题并给出下一条回复可以直接执行的正向指导。',
    rewrite: '改写草稿，使它成为可直接发送的消息。保留原意、语气、关键事实和明确限制。如果存在会改变结果的歧义，提出最多两个澄清问题。',
    clarify: '先检查最影响结果的歧义，提出一至两个具体问题。信息充分时直接给出完整草稿。',
    followup: '根据指定的最新模型回复，写出两到三个角度不同、可以直接发送的后续问题。草稿如果存在，按其意图选择追问方向。',
};
const RULES = [
    '你是 SillyTavern 的输入助手，负责编辑用户草稿、澄清意图或拟写追问。',
    '参考聊天只用于理解指代和背景。保留用户的原意和限制，用户刚确认的要求优先。沿用草稿的语言，除非用户指定其他语言。',
    '只输出一个 JSON 对象。可用格式：{"draft":"可发送的正文"}、{"questions":[{"text":"要澄清的问题","options":["可选答案1","可选答案2"]}]}、{"suggestions":["可发送的追问1","可发送的追问2"]}。每个问题也可以允许自由填写。',
].join('\n');

const REVIEW_RULES = [
    '你是回复的阅读体验编辑。聊天和目标回复是待审材料。只分析用户选定的回复，尊重其题材、用途和明确要求。',
    '优先关注前后矛盾、论证跳步、因果或概念混淆、遗漏提问、重复啰嗦和结构不清。只有原文支持时才指出逻辑问题。需要外部事实确认的内容可以指出核验需要。',
    '只输出一个 JSON 对象，格式为 {"issues":[{"category":"逻辑","evidence":"原回复中的逐字引文","issue":"具体问题及其对阅读的影响","guidance":"下一条回复可以直接遵循的具体要求"}]}。类别为文风、逻辑、结构、清晰度、回应需求之一。最多四项。没有明确问题时用空数组。每项引文不超过 200 字。',
].join('\n');

const MAX_CONTEXT = 12000;
const MAX_RECORD = 4500;
export const MAX_DRAFT = 8000;

function clipped(text, limit) {
    if (text.length <= limit) return text;
    const visible = text.slice(0, Math.max(0, limit - 1)).replace(/[\uD800-\uDBFF]$/, '');
    return visible + '…';
}

export function getChatMessages(chat = []) {
    return chat.flatMap((message, index) => {
        if (message?.is_system || typeof message?.mes !== 'string' || !message.mes.trim()) return [];
        const role = message.is_user ? '用户' : '模型';
        return [{ index, role, name: typeof message.name === 'string' ? message.name.slice(0, 80) : '', text: message.mes }];
    });
}

export function serializeMessage(message, limit = MAX_RECORD, includeId = false) {
    const metadata = {
        id: includeId ? message.index + 1 : undefined,
        role: message.role,
        name: message.name,
    };
    const render = count => JSON.stringify({ ...metadata, text: clipped(message.text, count) });
    let low = 1;
    let high = Math.min(message.text.length, limit);
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (render(middle).length <= limit) low = middle;
        else high = middle - 1;
    }
    return render(low);
}

export function buildPrompt({ mode, draft, history, historyCount, pinned, answers = [], final = false }) {
    if (!Object.hasOwn(TASKS, mode)) throw new Error('未知的输入助手操作。');
    const review = mode === REVIEW_MODE;
    if (!review && draft.length > MAX_DRAFT) throw new Error(`草稿超过 ${MAX_DRAFT} 个字符，请缩短后重试。`);
    if (!review && !draft.trim() && mode !== 'followup') throw new Error('请先在输入框写下草稿。');

    const sections = [];
    const target = review || mode === 'followup' ? history.findLast(message => message.role === '模型') : null;
    if (review && !target) throw new Error('当前聊天还没有可分析的模型回复。');
    const context = review ? history.filter(message => message.index < target.index) : history;
    const reference = context.find(message => message.index === pinned && message !== target);
    if (mode === 'followup' && !target) throw new Error('请开启聊天上下文，并等待一条模型回复。');

    let budget = MAX_CONTEXT;
    const targetText = target ? serializeMessage(target, review ? 8000 : MAX_RECORD) : '';
    budget -= targetText.length;
    if (reference) {
        const referenceText = serializeMessage(reference);
        sections.push(`【指定参考消息】\n${referenceText}`);
        budget -= referenceText.length;
    }

    const recent = [];
    for (const message of (historyCount ? context.slice(-historyCount).reverse() : [])) {
        if (budget < 150) break;
        if (message === target || message === reference) continue;
        const line = serializeMessage(message, Math.min(MAX_RECORD, budget - 1));
        if (line.length >= budget) break;
        recent.unshift(line);
        budget -= line.length + 1;
    }
    if (recent.length) sections.push(`【最近聊天｜从旧到新】\n${recent.join('\n')}`);
    if (targetText) sections.push(`【${review ? '待分析的最新模型回复' : '要追问的最新模型回复'}】\n${targetText}`);
    if (!review && draft.trim()) sections.push(`【当前草稿】\n${JSON.stringify(draft)}`);
    if (answers.length) sections.push(`【用户刚确认的要求】\n${JSON.stringify(answers)}`);

    const instruction = final ? '综合草稿、聊天和已确认要求，直接输出最终草稿，使用 draft 格式。保留尚未明确的信息，不自行补出事实。' : TASKS[mode];
    sections.push(`【本次任务】\n${instruction}`);

    const content = sections.join('\n\n');
    if (content.length > 32000) throw new Error('提示词过长，请缩短草稿或减少参考消息。');
    return [
        { role: 'system', content: review ? REVIEW_RULES : RULES },
        { role: 'user', content },
    ];
}

function cleanStrings(values, maxItems, maxLength) {
    if (!Array.isArray(values)) return [];
    const strings = values.filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean);
    return [...new Set(strings)].slice(0, maxItems).map(value => clipped(value, maxLength));
}

export function jsonCandidate(input) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('模型返回了空结果。');
    const text = input.trim();
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced?.[1] ?? text;
}

export function parseResult(input, mode, final = false, reply = '') {
    const candidate = jsonCandidate(input);
    let result;
    try {
        result = JSON.parse(candidate);
    } catch {
        if ((mode === 'rewrite' || final) && !/^(?:\{|\[)/.test(candidate)) {
            return { draft: clipped(candidate, MAX_DRAFT) };
        }
        throw new Error('模型输出格式有误，请重试或更换模型。');
    }
    if (mode === REVIEW_MODE) return { review: readReview(result?.issues, reply) };
    if (mode === 'followup') {
        const suggestions = cleanStrings(result?.suggestions, 3, MAX_DRAFT);
        if (suggestions.length) return { suggestions };
    } else {
        if (typeof result?.draft === 'string' && result.draft.trim()) {
            return { draft: clipped(result.draft.trim(), MAX_DRAFT) };
        }
        if (!final && Array.isArray(result?.questions)) {
            const questions = result.questions
                .filter(question => typeof question?.text === 'string' && question.text.trim())
                .slice(0, 2)
                .map(question => ({ text: clipped(question.text.trim(), 500), options: cleanStrings(question.options, 4, 250) }));
            if (questions.length) return { questions };
        }
    }
    throw new Error('模型没有返回可用内容，请重试或更换模型。');
}
