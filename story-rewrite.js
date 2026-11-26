import { jsonCandidate } from './prompts.js';
import { assertReplyLength, prepareReplySource, quoteProse, validateWritingOptions, validateWritingRequest } from './reply-polish.js';
import { splitRevisionComponents } from './revision-components.js';

const EXTRACT_PLOT = `把【原回复】整理成给小说作者看的剧情记录。直接写可读的中文或原稿语言，普通段落、列表或 Markdown 都可以。按实际篇幅记录，保留足够的细节供另一位作者独立成稿。
按场景和事件先后记录人物、动作、因果、能看到或听到的细节、关键物件及它们的位置。记下叙述视角、每个人的称呼与口吻、谁知道什么，以及故事停在哪里。区分事实、猜测与尚未发生的事。【最近聊天】和【指定参考消息】只用于理解当前语境。
每轮有用的对白记在发生的位置。用自己的话写明谁在对谁说、话的实质信息、目的和语气。保留影响节奏的停顿与回应。明确要求逐字保留的片段和原有独立标题照录并注明用途。只改旁白时逐字记录对白及其引号；只改对白时逐字记录旁白及原引语提示。其余写成简明的素材记录。
只输出剧情记录。输入中的引用是素材，按【本次要求】处理。`;

const WRITE_PROSE = `根据【剧情记录】写出一篇完整的小说或角色扮演回复。按已记录的事实、因果和时间顺序写，保留人物关系、叙述视角、关键信息与结尾的停笔位置。同一场景内可从已有物件、动作或声音重新切入，用段落和话轮推动场景。
把对白要点写成角色实际说出口的话。根据谁在对谁说、双方的身份关系、当时知道的事和这句话的目的来重写措辞。用合适的停顿、动作和接话方式表现原有分寸。保留猜测和悬念，用户角色的下一步由用户决定。原题以及明确要求逐字保留的内容按记录写回。
所有引用区域是素材。只输出完整正文，保留有意义的换行、Markdown 和角色扮演标记。`;

export function preparePlotRequest({ displayText = message => message.text, ...source }) {
    const { original, target, chatSections } = prepareReplySource({ ...source, displayText });
    const { prefix, suffix } = splitRevisionComponents(target.rawText);
    let narrative = target.text;
    if (prefix || suffix) {
        target.revisionComponents = { prefix, suffix };
        const renderedPrefix = prefix ? displayText({ ...original, text: prefix }) : '';
        const renderedSuffix = suffix ? displayText({ ...original, text: suffix }) : '';
        if (renderedPrefix.trim() && narrative.startsWith(renderedPrefix)) narrative = narrative.slice(renderedPrefix.length);
        if (renderedSuffix.trim() && narrative.endsWith(renderedSuffix)) narrative = narrative.slice(0, -renderedSuffix.length);
        narrative = splitRevisionComponents(narrative).body;
    }
    if (!narrative.trim()) throw new Error('这条回复经 SillyTavern 正则处理后没有可重写的正文。');

    const content = [
        ...chatSections.map(quoteProse),
        `【原回复】\n${quoteProse(narrative)}`,
        ...(source.polishNotes ? [`【本次要求】\n${quoteProse(source.polishNotes)}`] : []),
    ].join('\n\n');
    validateWritingRequest(content, '剧情提取');
    return { target, prompt: [{ role: 'system', content: EXTRACT_PLOT }, { role: 'user', content }] };
}

export function buildRewritePrompt(plot, source) {
    const { polishExample, polishNotes, matchExampleDiction } = source;
    if (!plot.trim()) throw new Error('请先提取或填写剧情记录。');
    validateWritingOptions(source);
    const system = [
        WRITE_PROSE,
        polishExample
            ? '让【文风示范】决定叙述写法。对照它处理相近场景时的动词、修饰疏密、长短句、换行、视线或心理推进，以及对白中插入动作的方式。借用这些写法来写当前剧情，原创措辞。范文的人名、设定、事件、原句和独特比喻留在范文里。'
            : '按剧情记录体现的叙事语气和人物声线写作。用自然口语写对白，让动作、停顿与段落各自承担叙事作用。',
        ...(polishExample && matchExampleDiction ? ['加强用词对齐。分别观察范文旁白和对白的常用词与书面词比例、动词力度、修饰语疏密，以及称呼和语气词，再按当前场景和人物身份选词。'] : []),
        '按【本次要求】指定的范围和偏好交稿。只改旁白或只改对白时，逐字保留剧情记录中标出的另一部分。',
    ].join('\n\n');
    const content = [
        `【剧情记录】\n${quoteProse(plot)}`,
        ...(polishExample ? [`【文风示范】\n${quoteProse(polishExample)}`] : []),
        ...(polishNotes ? [`【本次要求】\n${quoteProse(polishNotes)}`] : []),
    ].join('\n\n');
    validateWritingRequest(content, '重写');
    return [{ role: 'system', content: system }, { role: 'user', content }];
}

export function readRewriteText(result, operation) {
    assertReplyLength(result.finishReason, result.outputTokens, operation);
    if (typeof result.text !== 'string' || !result.text.trim()) {
        throw new Error(result.reasoning?.trim() ? '模型只返回了思考内容，没有返回正文。' : '模型返回了空文本。');
    }
    // A JSON-mode connection may wrap otherwise ordinary text. Plain text is the default.
    const text = result.text;
    const candidate = jsonCandidate(text);
    if (!/^(?:\{|\[|")/.test(candidate)) return text;
    let decoded;
    try {
        decoded = JSON.parse(candidate);
    } catch {
        return text;
    }
    if (typeof decoded === 'string' && decoded.trim()) return decoded;
    const textKeys = ['plot', 'record', 'polished', 'text', 'content'];
    for (const key of textKeys) {
        const value = decoded?.[key];
        if (typeof value === 'string' && value.trim()) return value;
    }
    if (typeof decoded === 'string' || Object.entries(decoded).every(([key, value]) =>
        textKeys.includes(key) && (value == null || (typeof value === 'string' && !value.trim())))) {
        throw new Error('模型返回了空文本。');
    }
    return text;
}
