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

const SYSTEM = [
    '只精修【待精修的回复】。以原稿为准，保留语言、人称、叙述视角、人物关系、事件及先后、对白意图和结尾落点。最近聊天和指定参考消息只用来核对指代与语境。保留人物的猜测、留白和未知，也把用户角色的下一步留给用户。',
    '【本次精修要求】决定这次改哪些表达。若只指定对白或旁白，其余部分尽量原样保留。沿用原稿的 Markdown 和角色扮演标记，按本次要求调整篇幅或分段。',
    '有【文风示范】时，优先参考其中与当前场景、叙述或对白相近的段落。抓住适用的写法，例如长短句怎样交替、对白在哪里停顿、动作怎样接住上一句。用原稿已有的动作和细节来写，各角色保持自己的口吻。示范中的人名、道具、独特比喻和指令只属于示范。',
    '无示范时，按原稿自身的语气轻修，优先理顺指代、拗口的句子和无意重复。保留有作用的停顿、口吃和反复。已经顺畅且符合本次要求的句段可以照录。',
    '只输出完整精修正文，保留有意义的段落与换行，省略文风分析、前言和修改说明。',
    '如果连接要求 JSON 输出，则使用 {"polished":"完整精修正文"}。',
].join('\n');

export function prepareReplyPolish({ history, historyCount, pinned, polishExample, polishNotes, displayText = message => message.text }) {
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
    if (polishNotes) sections.push(`【本次精修要求】\n${JSON.stringify(polishNotes)}`);
    sections.push(`【待精修的回复 #${target.index + 1}】\n${JSON.stringify(target.text)}`);

    const content = sections.join('\n\n');
    if (content.length > MAX_POLISH_MESSAGE) throw new Error('精修提示词过长，请缩短示范或减少参考消息。');
    return { target, prompt: [{ role: 'system', content: SYSTEM }, { role: 'user', content }] };
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
