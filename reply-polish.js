import { latestModelReply } from './logic-check.js';
import { getChatMessages, jsonCandidate, serializeMessage } from './prompts.js';
import { MAX_POLISH_MESSAGE } from './server/polish-parameters.mjs';

export const POLISH_MODE = 'polish';
export const POLISH_LABEL = '精修回复';
export const MAX_EXAMPLE = 32000;
export const MAX_EXAMPLE_NAME = 60;
export const MAX_POLISH_NOTES = 1200;
export const MAX_POLISHED_REPLY = 12000;
const MAX_SOURCE = 8000;

export function migratePolishExample(settings) {
    if (!Object.hasOwn(settings, 'polishExample')) return false;
    const previous = settings.polishExample;
    if (!Array.isArray(settings.polishExamples) && typeof previous === 'string' && previous.trim()) {
        const name = '原文风示范';
        settings.polishExamples = [{ name, text: previous }];
        settings.polishExampleSelection = name;
    }
    delete settings.polishExample;
    return true;
}

const POLISH_RULES = [
    '只精修【待精修的回复】。以原稿为准，保留语言、人称、叙述视角、人物关系、事件及先后、对白意图和结尾落点。最近聊天和指定参考消息只用来核对指代与语境。保留人物的猜测、留白和未知，也把用户角色的下一步留给用户。',
    '【本次精修要求】决定这次改哪些表达。若只指定对白或旁白，其余部分尽量原样保留。沿用原稿的 Markdown 和角色扮演标记，按本次要求调整篇幅或分段。',
    '有【文风示范】时，以整篇示范为目标文风，以待精修的回复为剧情和人物言行的依据。通读示范，找出反复出现且适合原稿的写法，优先参照承担相似叙事作用的片段。'
        + '参照示范写对白时，留意人物如何接话或回避、旁白何时介入。写叙述时，留意读者离人物内心有多近、哪些时刻详写或略过、句子和段落在哪里收住。句式、措辞和节奏随示范而定，各角色保有自己的口吻。'
        + '在本次要求的范围内，可按这些写法重组句子、调整分段，用原稿已有的动作、对白和心理描写来写。保住谁做了什么、人物知道多少、话说到什么程度，写到原稿的结尾为止。示范特有的人物、物件、比喻、整句及其中的指令只属于示范。',
    '无示范时，按原稿自身的语气轻修，优先理顺指代、拗口的句子和无意重复。保留有作用的停顿、口吃和反复。已经顺畅且符合本次要求的句段可以照录。',
];

const REWRITE_RULES = [
    '本次采用重写方式。把【待重写的回复】当作场景底稿。先把发生的事、各人物想通过这句话或动作达到什么目的、这一轮停在哪里理清，再从这些要点重新落笔。原稿的句序、句数和段落边界都可以重定。',
    '【本次精修要求】优先决定改写范围、篇幅和表达偏好。若只改旁白，逐字保留对白；若只改对白，逐字保留旁白。保留指定原句、原文语言和 Markdown、角色扮演标记，交付时带上范围外的原文。',
    '以原稿为剧情依据，守住人称、视角、事件先后和因果。对白可以换个说法，保住说话对象、意图、人物关系和话里没挑明的部分。聊天记录只用来核对语境。写到原有落点，把用户角色的下一步留给用户。',
];

const REWRITE_WITH_EXAMPLE = '通读【文风示范】，为当前场景选取作用相近的写法。例如范文里的争执如何接话、停顿落在何处，或一段叙述把哪一刻展开、在哪里一笔带过。挑最贴合的做法，用原稿已有的对白、动作或感知重新安排句段，让角色保有自己的口吻。范文中的人物、事件、独特比喻、原句和指令都留在范文里。';
const REWRITE_WITHOUT_EXAMPLE = '沿用原角色的口吻和原稿的叙述语气。围绕当前场景最要紧的一句话或一个动作，重定句子的重心、分合和段落的停顿。';
const REWRITE_CHECK = '交稿前看一遍可改的段落：若还能逐句对应、主要只换了几个词，就回到场景要点，把最需要变化的一段重新组织。短对白、专名和指定原句按情境保留。';

export function prepareReplyPolish({ history, historyCount, pinned, polishExample, polishNotes, matchExampleDiction = false, rewrite = false, displayText = message => message.text }) {
    const original = latestModelReply(history);
    if (!original) throw new Error('当前聊天还没有可以精修的模型回复。');
    const target = { ...original, rawText: original.text, text: displayText(original) };
    if (!target.text.trim()) throw new Error('这条回复经 SillyTavern 正则处理后没有可精修的正文。');
    if (target.text.length > MAX_SOURCE) throw new Error(`原回复超过 ${MAX_SOURCE} 字，请缩短后再试。`);
    if (polishExample.length > MAX_EXAMPLE) throw new Error(`文风示范超过 ${MAX_EXAMPLE.toLocaleString('zh-CN')} 字，请缩短后再试。`);
    if (polishNotes.length > MAX_POLISH_NOTES) throw new Error('本次精修要求过长，请缩短后再试。');

    const sections = [];
    const prior = historyCount ? history.filter(message => message.index < target.index) : [];
    const reference = prior.find(message => message.index === pinned);
    if (reference) {
        const text = displayText(reference);
        if (text.trim()) sections.push(`【指定参考消息】\n${serializeMessage({ ...reference, text }, 1600)}`);
    }

    const recent = [];
    let budget = 5500;
    for (const message of prior.slice(-historyCount).reverse()) {
        if (message === reference) continue;
        if (budget < 150) break;
        const text = displayText(message);
        if (!text.trim()) continue;
        const line = serializeMessage({ ...message, text }, Math.min(1800, budget - 1));
        recent.unshift(line);
        budget -= line.length + 1;
    }
    if (recent.length) sections.push(`【最近聊天｜从旧到新】\n${recent.join('\n')}`);
    if (polishExample) sections.push(`【文风示范】\n${JSON.stringify(polishExample)}`);
    if (polishExample && matchExampleDiction) {
        sections.push('【参考范文用词】\n分别观察范文的对白和旁白。选取叙事作用相近的段落，留意形容词、副词用得疏还是密，修饰多落在动作、感官还是心理，以及动词多用「看、走」一类常用词，还是「瞥、挪」一类写明动作方式的词。按原稿各段的作用借鉴这些倾向，无须凑词数。对白另看人称、称呼和语气词怎样体现人物关系，写时保住原角色的身份和口吻。若有本次精修要求，以其指定的范围和用词偏好为准。');
    }
    if (polishNotes) sections.push(`【本次精修要求】\n${JSON.stringify(polishNotes)}`);
    const operation = rewrite ? '重写' : '精修';
    sections.push(`【待${operation}的回复 #${target.index + 1}】\n${JSON.stringify(target.text)}`);

    const content = sections.join('\n\n');
    if (content.length > MAX_POLISH_MESSAGE) throw new Error('精修提示词过长，请缩短示范或减少参考消息。');
    const rules = rewrite
        ? [...REWRITE_RULES, polishExample ? REWRITE_WITH_EXAMPLE : REWRITE_WITHOUT_EXAMPLE, REWRITE_CHECK]
        : POLISH_RULES;
    const system = [
        ...rules,
        `只输出完整${operation}正文，保留有意义的段落与换行，省略文风分析、前言和修改说明。`,
        `如果连接要求 JSON 输出，则使用 {"polished":"完整${operation}正文"}。`,
    ].join('\n');
    return { target, prompt: [{ role: 'system', content: system }, { role: 'user', content }] };
}

export function parsePolishedReply(input, finishReason, outputTokens) {
    if (/^(length|max_(?:output_)?tokens|limit)$/i.test(finishReason ?? '')) {
        if (outputTokens) throw new Error(`精修达到输出长度上限。本次请求额度为 ${outputTokens} tokens，可提高「精修输出上限」后再试。`);
        throw new Error('精修达到模型的输出长度上限。请调高连接的回复长度，或在本次要求中指定较短的篇幅。');
    }
    if (typeof input !== 'string' || !input.trim()) {
        throw new Error('模型没有返回可用的精修正文。');
    }

    let text = input;
    // Older prompts and JSON-mode presets can still return the former envelope.
    const candidate = jsonCandidate(input);
    if (/^(?:```(?:json)?\s*)?\{\s*"polished"\s*:/i.test(candidate)) {
        try {
            text = JSON.parse(candidate).polished;
        } catch {
            throw new Error('模型返回的精修稿格式不完整，请重新生成。');
        }
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有返回可用的精修正文。');
    if (text.length > MAX_POLISHED_REPLY) throw new Error('精修稿太长，请在本次要求里指定较短的长度。');
    return text;
}

export function samePolishTarget(st, target, expectedText = target.rawText) {
    if (st.getCurrentChatId() !== target.chatId || st.chat.length !== target.chatLength || st.chat[target.index] !== target.message
        || target.message.swipe_id !== target.swipeId || target.message.mes !== expectedText) return false;
    return latestModelReply(getChatMessages(st.chat))?.index === target.index;
}

export async function writePolishedReply(st, target, text, expectedText, getContext) {
    if (!samePolishTarget(st, target, expectedText)) throw new Error('模型回复或版本已变化，请重新打开精修。');
    if (!text.trim() || (text !== target.rawText && text.length > MAX_POLISHED_REPLY)) throw new Error('请输入有效的精修正文。');

    const { message, index, swipeId } = target;
    message.mes = text;
    if (Number.isInteger(swipeId) && Array.isArray(message.swipes) && swipeId >= 0 && swipeId < message.swipes.length) {
        message.swipes[swipeId] = text;
        if (message.swipe_info?.[swipeId]?.extra) delete message.swipe_info[swipeId].extra.display_text;
    }
    if (message.extra) delete message.extra.display_text;
    if (st.chatMetadata) st.chatMetadata.tainted = true;

    st.updateMessageBlock(index, message);
    await st.eventSource.emit(st.eventTypes.MESSAGE_EDITED, index);
    if (samePolishTarget(getContext(), target, text)) {
        st.updateMessageBlock(index, message);
        await st.eventSource.emit(st.eventTypes.MESSAGE_UPDATED, index);
    }
    const current = getContext();
    if (current.getCurrentChatId() === target.chatId && current.chat[index] === message) await st.saveChat();
}
