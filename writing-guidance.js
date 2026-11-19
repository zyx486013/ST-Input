const MAX_GUIDES = 8;
const GUIDE_HEADING = '【下一条回复的写作指导】';
const REVIEW_CATEGORIES = new Set(['文风', '逻辑', '结构', '清晰度', '回应需求']);

export const GUIDANCE_KEY = 'st-input-writing-guidance';

function shorten(value, limit) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
}

function cleanGuide(item) {
    if (!REVIEW_CATEGORIES.has(item?.category)) return null;
    const issue = shorten(item.issue, 300);
    const guidance = shorten(item.guidance, 240);
    return issue && guidance ? { category: item.category, issue, guidance } : null;
}

function normalizeQuote(value) {
    return value.replace(/\s+/g, ' ').trim();
}

export function readReview(issues, reply) {
    if (!Array.isArray(issues)) throw new Error('模型没有返回可用的阅读分析。');
    const text = normalizeQuote(reply);
    const matched = [];
    for (const item of issues) {
        const guide = cleanGuide(item);
        const evidence = typeof item?.evidence === 'string' ? normalizeQuote(item.evidence) : '';
        if (!guide || !evidence || evidence.length > 220 || !text.includes(evidence)) continue;
        if (matched.some(previous => previous.guidance === guide.guidance)) continue;
        matched.push({ ...guide, evidence });
        if (matched.length === 4) break;
    }
    if (issues.length && !matched.length) throw new Error('模型给出的引文在原回复中找不到，请重试分析。');
    return matched;
}

export function readGuidance(metadata) {
    const saved = metadata?.[GUIDANCE_KEY];
    const items = Array.isArray(saved?.items) ? saved.items.map(cleanGuide).filter(Boolean).slice(0, MAX_GUIDES) : [];
    return { enabled: Boolean(saved?.enabled && items.length), items };
}

export function saveGuide(state, item) {
    const guide = cleanGuide(item);
    if (!guide) throw new Error('这条写作指导缺少有效内容。');
    if (state.items.some(existing => existing.guidance === guide.guidance)) return state;
    if (state.items.length >= MAX_GUIDES) throw new Error(`已保存 ${MAX_GUIDES} 条指导。移除一条后可以继续添加。`);
    return { ...state, items: [...state.items, guide] };
}

export function appendGuidance(draft, items, includeIssues = false) {
    const original = draft.trimEnd();
    const existingLines = new Set(original.split(/\r?\n/).map(line => line.trim()));
    const distinctItems = new Map(items.map(item => [item.guidance, item]));
    const additions = [];
    for (const { guidance, category, issue } of distinctItems.values()) {
        const instruction = `- ${guidance}`;
        const note = `- 此前回复的${category}问题：${issue}`;
        if (includeIssues && !existingLines.has(note)) additions.push(note);
        if (!existingLines.has(instruction)) additions.push(instruction);
    }
    if (!additions.length) return draft;

    const header = existingLines.has(GUIDE_HEADING)
        ? ''
        : `${GUIDE_HEADING}\n在符合本次任务明确要求的前提下，请按以下指导组织回复。\n`;
    return [original, header + additions.join('\n')].filter(Boolean).join(header ? '\n\n' : '\n');
}
