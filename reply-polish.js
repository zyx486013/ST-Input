import { latestModelReply } from './logic-check.js';
import { getChatMessages, jsonCandidate, serializeMessage } from './prompts.js';
import { MAX_POLISH_MESSAGE } from './server/polish-parameters.mjs';

export const POLISH_MODE = 'polish';
export const POLISH_LABEL = '精修回复';
export const MAX_EXAMPLE = 32000;
export const MAX_EXAMPLE_NAME = 60;
export const MAX_POLISH_NOTES = 1200;

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

const DEEP_REVISION_CORE = `### 一、事实边界与原稿锚定
1. **定事实**：以【待大修的回复】为唯一剧情依据，理清谁做了什么、事件先后因果、物件位置归属、对白透露的信息及人物当前的知情范围。【最近聊天｜从旧到新】与【指定参考消息】仅供核对语境、称呼与人物关系。
2. **严留白**：分清人物的猜测、承诺与既成事实。原稿未交代的前置条件、后果、生理感受与心理活动一律留白，严禁自行脑补加戏、添加序幕或无依据的环境/日期铺垫。
3. **守落点**：保留原稿的叙述视角、独立标题（若有则保留一次）及结尾落点，把用户角色的下一步反应完全留给用户。

### 二、句群重组与防洗稿法则
1. **打破原句骨架**：以“一整段叙事”或“一轮完整对白”为单位打散重写。严禁顺着原稿语序逐句换近义词或机械切碎句子；必须用原稿已有的动作、物件、感知和念头，重新编排读者的注意力落点与句子先后。
2. **删繁就简**：删去原稿中重复的解释与空洞的总结，但必须将推动情节所需的信息自然融回动作或对白中。原稿中已经贴切干脆的短句或短对白可直接保留。
3. **对白重塑**：在不改变原意、试探/命令/玩笑分寸的前提下重新措辞，保住角色在原语境中的身份口吻、说话节奏及有实际作用的停顿、重复或口头禅。`;

const DEEP_REVISION_WITH_EXAMPLE = `### 三、范文迁移方法（核心）
【文风示范】仅决定“怎么写”，其剧情、专名、独特比喻和设定严禁带入正文。动笔前按以下维度拆解并复刻范文：
1. **段落呼吸与分镜**：严格对齐范文的段落长短、换行频率与停顿方式（例如范文若采用高频换行、单句成段或拟声词独立成段，改稿也须果断拆段；范文若用绵密长段，改稿则并段）。观察范文如何按“环境—人物—局部细节—动作反应”转移镜头，以及如何用上一句的细节勾出下一句。
2. **用词密度与质感**：对照范文中作用相近的片段，模仿其形容词与副词的疏密程度。看范文是偏向平实直白的常用词与物理白描，还是偏向精雕细琢的修饰；看情绪是直接写出心理，还是藏在肢体动作与物件状态里。
3. **按料裁衣**：先看原稿手里有什么材料（动作、物件、环境），再选范文对应的写法。若原稿缺乏某类材料（如未交代天气、时间），则换用范文处理人物动作或对话的写法，绝不为了凑范文句式而凭空造景。物件多次出现时，可在原稿依据内形成状态呼应。`;

const DEEP_REVISION_WITHOUT_EXAMPLE = `### 三、叙事质感（无示范）
沿用原角色的口吻和叙述语气。优先重组原稿里读起来拖沓、转折生硬、几句挤在一起的段落，让每段的重心和推进更清楚。`;

const DEEP_REVISION_OUTPUT = `### 四、范围控制与输出规范
1. **优先级**：【本次精修要求】的明确指令最高优先。若指定“只修旁白”则逐字保留对白；指定“只修对白”则逐字保留旁白；指定修改范围时，其余部分原样保留，最终交付完整一稿。
2. **格式清理**：输入内容若带有外层 \`>\` 引用标记，输出时须剥离该层 \`>\`，仅保留正文所需的原文语言、指定原句、有意义的 Markdown 与角色扮演标记。
3. **纯净输出**：只输出完整的大修正文，省略任何思考过程、文风分析、前言或修改说明。若连接要求 JSON 输出，则严格使用 \`{"polished":"完整大修正文"}\`。`;

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

export function prepareReplyPolish({ history, historyCount, pinned, polishExample, polishNotes, matchExampleDiction = false, rewrite = false, displayText = message => message.text }) {
    const original = latestModelReply(history);
    if (!original) throw new Error('当前聊天还没有可以精修的模型回复。');
    const target = { ...original, rawText: original.text, text: displayText(original) };
    if (!target.text.trim()) throw new Error('这条回复经 SillyTavern 正则处理后没有可精修的正文。');
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
    if (polishExample) sections.push(`【文风示范】\n${quoteProse(polishExample)}`);
    if (polishExample && matchExampleDiction) {
        sections.push('【参考范文用词】\n分别观察范文的对白和旁白。选取叙事作用相近的段落，留意形容词、副词用得疏还是密，修饰多落在动作、感官还是心理，以及动词多用「看、走」一类常用词，还是「瞥、挪」一类写明动作方式的词。按原稿各段的作用借鉴这些倾向，无须凑词数。对白另看人称、称呼和语气词怎样体现人物关系，写时保住原角色的身份和口吻。若有本次精修要求，以其指定的范围和用词偏好为准。');
    }
    const operation = rewrite ? '大修' : '精修';
    if (polishNotes) sections.push(`【本次精修要求】\n${JSON.stringify(polishNotes)}`);
    const targetHeading = rewrite ? '待大修的回复' : `待精修的回复 #${target.index + 1}`;
    sections.push(`【${targetHeading}】\n${quoteProse(target.text)}`);

    const content = sections.join('\n\n');
    if (content.length > MAX_POLISH_MESSAGE) {
        throw new Error(`本次${operation}请求有 ${content.length.toLocaleString('zh-CN')} 个字符，超过 ${MAX_POLISH_MESSAGE.toLocaleString('zh-CN')} 字符的请求上限。可缩短示范、减少参考消息，或分段处理原回复。`);
    }
    const system = rewrite ? [
        polishExample
            ? '大修【待大修的回复】，在严格守住原稿剧情事实的前提下，将其重写为【文风示范】的叙事质感。'
            : '大修【待大修的回复】，在严格守住原稿剧情事实的前提下，重新组织整段叙事和对白。',
        DEEP_REVISION_CORE,
        polishExample ? DEEP_REVISION_WITH_EXAMPLE : DEEP_REVISION_WITHOUT_EXAMPLE,
        DEEP_REVISION_OUTPUT,
    ].join('\n\n') : [
        ...POLISH_RULES,
        SOURCE_FIDELITY_RULE,
        ...(polishExample
            ? [...EXAMPLE_STYLE_RULES, POLISH_WITH_EXAMPLE, EXAMPLE_STYLE_CHECK]
            : [POLISH_WITHOUT_EXAMPLE]),
        SOURCE_FIDELITY_CHECK,
        '输入的逐行引文带有外层 > 标记。输出正文时去掉这一层，保留正文自身需要的 Markdown 标记。',
        '只输出完整精修正文，保留有意义的段落与换行，省略文风分析、前言和修改说明。',
        '如果连接要求 JSON 输出，则使用 {"polished":"完整精修正文"}。',
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
    return text;
}

export function samePolishTarget(st, target, expectedText = target.rawText) {
    if (st.getCurrentChatId() !== target.chatId || st.chat.length !== target.chatLength || st.chat[target.index] !== target.message
        || target.message.swipe_id !== target.swipeId || target.message.mes !== expectedText) return false;
    return latestModelReply(getChatMessages(st.chat))?.index === target.index;
}

export async function writePolishedReply(st, target, text, expectedText, getContext) {
    if (!samePolishTarget(st, target, expectedText)) throw new Error('模型回复或版本已变化，请重新打开精修。');
    if (!text.trim()) throw new Error('请输入有效的精修正文。');

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
