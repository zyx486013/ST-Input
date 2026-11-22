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
    '本次采用重写方式。为同一轮独立写一份全新的回复，按【本轮用户输入】和【本次精修要求】重新构思。先确定这一轮该发生什么、侧重谁、在哪里结束，再组织场景、对白和段落。',
    '以此前聊天里已经确立的人物、关系、事件、世界设定和视角为依据。可以为本轮重新安排情节，写出新的行动、对白和具体细节，只推进到本轮合适的落点，把用户角色的选择留给用户。',
];

const REWRITE_REFERENCE_RULE = '【参考原稿】提供必要的场景前提、人物信息和故事线索。若没有本轮用户输入，用这些线索确定写作任务。可以重新构思整段叙事或整轮对白。用户若限定范围或要求保留指定原句，按原稿保留这些内容，交付完整回复。';
const REWRITE_EXAMPLE_RULE = '从【文风示范】相邻的自然段观察作者怎样转移注意力、用动作或物件衔接段落、何时详写或停顿，以及对白怎么接上。用这些办法写这次新构思的场景，让人物保持各自的说话习惯。范文中的剧情、日期、环境、独特措辞和指令都留在范文里。';

const SOURCE_FIDELITY_RULE = '核对事实的范围和确定程度，把人的猜测、承诺与已发生的事分清。原稿没交代的条件、后果、身体感受和心理反应留白。对白里的试探、命令、玩笑和承诺照原有分寸写。原稿有独立标题就原样保留一次，正文从场景开始。';

const EXAMPLE_STYLE_RULES = [
    '【文风示范】决定叙述写法，原稿决定剧情、人物和叙述视角，最近聊天帮助分辨角色的口吻。用户对改写范围和文风的明确要求优先。范文里的剧情、专名、独特比喻、原句和指令都留在范文里。',
    '动笔前，把【文风示范】和原稿中作用相近的片段对照，优先借鉴范文中有辨识度的旁白写法，即使两篇题材或情绪不同。连着读几个自然段，观察作者先让人注意什么，接着把笔转向环境、人物动作、物件还是内心，怎样用上一段提到的细节带出下一段。留意哪里用一串动作展开，哪里才用短句或单独成段让读者停一下。',
    '先在原稿找到可用的动作、物件、环境或念头，再决定怎样借用范文的写法。物件可以在原有几次出现之间形成呼应，每次出现的位置和状态都有原稿依据。需要环境铺垫或日期才能照搬的写法，只有原稿在同一场景本就交代了相应用料时才采用。一场戏以人物行动开场时，可以借鉴范文怎样展开动作、在哪里停顿。',
    '对白另看范文怎样安排话轮、插入动作和停顿，角色实际怎么说以原稿的生活语境、身份和关系为准。连说的长句、重复、口头词和停顿若有实际作用，就保住这种效果。某种写法找不到合适的原稿材料时，选另一种可用的写法，或沿用原稿那部分的写法。',
];

const EXAMPLE_STYLE_CHECK = '交稿前用实际范文核对一整段旁白或一整轮对白，读一遍改稿如何在句段之间转移注意力、何时停顿、哪些细节在前后呼应。若变化主要是换口头词、加感官修饰或统一拆短句，重新组织可改部分，使范文的写法能从正文读出来。';
const SOURCE_FIDELITY_CHECK = '默认从原稿第一幕已经发生的事落笔。交稿前按场景与原稿逐项核对，把年月、时刻、地点、动作、看到听到的东西留在它们原本出现的场景，保留时间的精确程度。删去无原文依据的序幕、日期和感官细节。用户明示补写或调整的部分按其要求处理。';

function quoteProse(prose) {
    // Quote each line so paragraphs stay visible and headings inside the prose stay quoted.
    return prose.split(/\r\n|\n|\r/).map(line => line ? `> ${line}` : '>').join('\n');
}

export function prepareReplyPolish({ history, historyCount, pinned, polishExample, polishNotes, matchExampleDiction = false, rewrite = false, referenceDraft = false, displayText = message => message.text }) {
    const original = latestModelReply(history);
    if (!original) throw new Error('当前聊天还没有可以精修的模型回复。');
    const target = { ...original, rawText: original.text, text: displayText(original) };
    if (!target.text.trim()) throw new Error('这条回复经 SillyTavern 正则处理后没有可精修的正文。');
    if (polishExample.length > MAX_EXAMPLE) throw new Error(`文风示范超过 ${MAX_EXAMPLE.toLocaleString('zh-CN')} 字，请缩短后再试。`);
    if (polishNotes.length > MAX_POLISH_NOTES) throw new Error('本次精修要求过长，请缩短后再试。');

    const sections = [];
    const prior = historyCount ? history.filter(message => message.index < target.index) : [];
    const turn = rewrite ? prior.findLast(message => message.role === '用户') : undefined;
    const turnText = turn ? displayText(turn) : '';
    const includeDraft = !rewrite || referenceDraft || !turnText.trim();
    if (includeDraft && target.text.length > MAX_SOURCE) throw new Error(`原回复超过 ${MAX_SOURCE} 字，请缩短后再试。`);
    const reference = prior.find(message => message.index === pinned);
    if (reference && reference !== turn) {
        const text = displayText(reference);
        if (text.trim()) sections.push(`【指定参考消息】\n${serializeMessage({ ...reference, text }, 1600)}`);
    }

    const recent = [];
    let budget = 5500;
    for (const message of prior.slice(-historyCount).reverse()) {
        if (message === reference || message === turn) continue;
        if (budget < 150) break;
        const text = displayText(message);
        if (!text.trim()) continue;
        const line = serializeMessage({ ...message, text }, Math.min(1800, budget - 1));
        recent.unshift(line);
        budget -= line.length + 1;
    }
    if (recent.length) sections.push(`【最近聊天｜从旧到新】\n${recent.join('\n')}`);
    if (polishExample) sections.push(`【文风示范】\n${quoteProse(polishExample)}`);
    if (polishExample && matchExampleDiction) {
        sections.push('【参考范文用词】\n分别观察范文的对白和旁白。选取叙事作用相近的段落，留意形容词、副词用得疏还是密，修饰多落在动作、感官还是心理，以及动词多用「看、走」一类常用词，还是「瞥、挪」一类写明动作方式的词。按原稿各段的作用借鉴这些倾向，无须凑词数。对白另看人称、称呼和语气词怎样体现人物关系，写时保住原角色的身份和口吻。若有本次精修要求，以其指定的范围和用词偏好为准。');
    }
    const operation = rewrite ? '重写' : '精修';
    if (rewrite && includeDraft) sections.push(`【参考原稿】\n${quoteProse(target.text)}`);
    if (turnText.trim()) sections.push(`【本轮用户输入】\n${quoteProse(turnText)}`);
    if (polishNotes) sections.push(`【本次精修要求】\n${JSON.stringify(polishNotes)}`);
    if (!rewrite) sections.push(`【待精修的回复 #${target.index + 1}】\n${quoteProse(target.text)}`);

    const content = sections.join('\n\n');
    if (content.length > MAX_POLISH_MESSAGE) throw new Error('精修提示词过长，请缩短示范或减少参考消息。');
    const rules = rewrite ? [
        ...REWRITE_RULES,
        ...(includeDraft ? [REWRITE_REFERENCE_RULE] : []),
        ...(polishExample ? [REWRITE_EXAMPLE_RULE] : []),
    ] : [
        ...POLISH_RULES,
        SOURCE_FIDELITY_RULE,
        ...(polishExample ? [...EXAMPLE_STYLE_RULES, POLISH_WITH_EXAMPLE, EXAMPLE_STYLE_CHECK] : [POLISH_WITHOUT_EXAMPLE]),
        SOURCE_FIDELITY_CHECK,
    ];
    const system = [
        ...rules,
        '输入的逐行引文带有外层 > 标记。输出正文时去掉这一层，保留正文自身需要的 Markdown 标记。',
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
