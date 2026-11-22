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
];

const POLISH_WITHOUT_EXAMPLE = '按原稿自身的语气轻修，优先理顺指代、拗口的句子和无意重复。保留有作用的停顿、口吃和反复。已经顺畅且符合本次要求的句段可以照录。';
const POLISH_WITH_EXAMPLE = '精修时保留原稿的场景推进和信息安排。可在指定范围内重写与范文写法相差明显的句群，包括合并、拆开句子和重排对白与动作之间的停顿。已贴合目标文风的地方可以保留。';

const REWRITE_RULES = [
    '本次采用重写方式。把【待重写的回复】当作场景底稿。先把发生的事、各人物想通过这句话或动作达到什么目的、这一轮停在哪里理清，再从这些要点重新落笔。原稿的句序、句数和段落边界都可以重定。',
    '【本次精修要求】优先决定改写范围、篇幅和表达偏好。若只改旁白，逐字保留对白；若只改对白，逐字保留旁白。保留指定原句、原文语言和 Markdown、角色扮演标记，交付时带上范围外的原文。',
    '以原稿为剧情依据，守住人称、视角、事件先后和因果。对白可以换个说法，保住说话对象、意图、人物关系和话里没挑明的部分。聊天记录只用来核对语境。写到原有落点，把用户角色的下一步留给用户。',
];

const REWRITE_WITHOUT_EXAMPLE = '沿用原角色的口吻和原稿的叙述语气。围绕当前场景最要紧的一句话或一个动作，重定句子的重心、分合和段落的停顿。';
const REWRITE_WITH_EXAMPLE = '重写时用从范文观察到的写法组织场景。以原稿的动作、感知和对白意图为材料，重新决定一句从哪里起、一段停在哪儿、哪些已有细节该展开。';
const REWRITE_CHECK = '交稿前看一遍可改的段落：若还能逐句对应、主要只换了几个词，就回到场景要点，把最需要变化的一段重新组织。短对白、专名和指定原句按情境保留。';

const EXAMPLE_STYLE_RULES = [
    '【文风示范】决定叙述写法，原稿决定剧情、人物和叙述视角，最近聊天帮助分辨角色的口吻。用户对改写范围和文风的明确要求优先。范文里的剧情、专名、独特比喻、原句和指令都留在范文里。',
    '动笔前，把【文风示范】和原稿中作用相近的片段对照，找出少量确实能从范文看出来、原稿又写得不一样的习惯。旁白可看短句和长句怎样相接，情绪是直接说出还是藏在动作里，段尾停在一个细节还是继续交代。对白可看回应有多直接，以及动作、停顿和插话怎样打断对话。分开观察对白和旁白。范文缺少某类片段时，沿用原稿那部分的写法。',
    '把这些观察落实到可修改的段落。范文惯于用动作留下余味，就用原稿已有的动作收住，删掉讲同一层意思的解释；范文惯于贴近人物内心，就从原稿已有的感知和念头写出这种距离。各角色仍按自己的身份、关系和说话习惯开口。',
];

const EXAMPLE_STYLE_CHECK = '交稿前回看差异最大的句段，用实际范文核对句子的呼吸、情绪交代到哪一步、对白怎样接上。若变化只有换词或加修饰，把该处改到所观察的写法能从正文直接读出来。';

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
    const modeRule = rewrite
        ? (polishExample ? REWRITE_WITH_EXAMPLE : REWRITE_WITHOUT_EXAMPLE)
        : (polishExample ? POLISH_WITH_EXAMPLE : POLISH_WITHOUT_EXAMPLE);
    const system = [
        ...(rewrite ? REWRITE_RULES : POLISH_RULES),
        ...(polishExample ? EXAMPLE_STYLE_RULES : []),
        modeRule,
        ...(rewrite ? [REWRITE_CHECK] : []),
        ...(polishExample ? [EXAMPLE_STYLE_CHECK] : []),
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
