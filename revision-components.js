function componentRanges(text) {
    const ranges = [];
    const pending = new Map();
    const tags = /<(\/?)(details|(?:status|state|options?|choices?)(?:[-_]?(?:block|bar|panel))?)(?=[\s/>])(?:[^<>'"]|"[^"]*"|'[^']*')*>/gi;
    for (const match of text.matchAll(tags)) {
        const name = match[2].toLowerCase();
        if (match[1]) {
            const start = pending.get(name)?.pop();
            if (start !== undefined) ranges.push({ start, end: match.index + match[0].length });
        } else if (!match[0].endsWith('/>')) {
            if (!pending.has(name)) pending.set(name, []);
            pending.get(name).push(match.index);
        }
    }

    const fences = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\r\n]*)\r?\n([\s\S]*?)^[ \t]{0,3}\1[ \t]*(?=\r?$)/gm;
    for (const match of text.matchAll(fences)) {
        const label = match[2].trim();
        if (/^(?:status|state|options?|choices?)(?:[-_]?(?:block|bar|panel))?$/i.test(label)
            || /^(?:【(?:状态栏|选项栏|选项)】|(?:状态栏|选项栏)[：:])/.test(match[3].trimStart())) {
            ranges.push({ start: match.index, end: match.index + match[0].length });
        }
    }

    const options = /^(?:#{1,6}[ \t]+)?(?:【(?:选项|选项栏|行动选项)】|(?:选项|选项栏|行动选项)[：:])[ \t]*\r?\n(?:[ \t]*(?:[-*+]|\d+[.)、]|[A-Z][.)、])[ \t]*[^\r\n]+(?:\r?\n|$))+/gm;
    for (const match of text.matchAll(options)) {
        if (!text.slice(match.index + match[0].length).trim()) {
            ranges.push({ start: match.index, end: match.index + match[0].length });
        }
    }

    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    let previousEnd = 0;
    return ranges.filter(range => {
        if (range.start < previousEnd) return false;
        previousEnd = range.end;
        return true;
    });
}

export function splitRevisionComponents(text) {
    const ranges = componentRanges(text);
    let start = 0;
    let end = text.length;
    for (const range of ranges) {
        if (text.slice(start, range.start).trim()) break;
        start = range.end;
    }
    for (const range of ranges.reverse()) {
        if (range.start < start || text.slice(range.end, end).trim()) break;
        end = range.start;
    }
    if (start > 0) start += text.slice(start, end).match(/^\s*/)[0].length;
    if (end < text.length) end -= text.slice(start, end).match(/\s*$/)[0].length;
    return { prefix: text.slice(0, start), body: text.slice(start, end), suffix: text.slice(end) };
}

export function restoreRevisionComponents(text, components) {
    if (!components?.prefix && !components?.suffix) return text;
    const { body } = splitRevisionComponents(text);
    if (!body.trim()) throw new Error('模型只返回了状态组件。请重新大修正文。');
    return components.prefix + body.trim() + components.suffix;
}
