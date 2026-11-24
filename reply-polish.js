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

const DEEP_REVISION_CORE = `### 一、核心铁律：废文留骨，严禁轻改摸鱼
1. **原稿文字作废**：将【待大修的回复】仅视为一份粗糙的“剧情信息底稿”，**其原有的句式结构、修辞手法、段落排布一律作废**。严禁保留原稿的句子骨架只换几个近义词、改标点或微调语序！除了【本次精修要求】明确指定保留的句子或限定不改的部分外，其余正文必须推倒重来，确保重写后的行文找不到原稿的翻译腔与惯用句式。
2. **严守剧情事实（留骨）**：重写前先从底稿中提取不可篡改的事实清单——谁做了什么、事情的先后因果、物件的归属与位置、对白传递的核心信息、人物当前的知情边界，以及结尾落点。【最近聊天｜从旧到新】与【指定参考消息】仅供核对人称、称呼与关系。
3. **禁加戏，准转译**：
   - **严禁剧情超纲**：不得编造底稿没有的新事件、新承诺、新背景设定、无依据的天气日期，不得替用户角色做下一步反应。
   - **强制笔法转译**：底稿中粘稠的心理剖析、空洞的情绪形容词（如“眼神复杂”“心中五味杂陈”）、拖沓的解释说明，必须全部砍掉，转译为镜头推拉、干脆的肢体动作、停顿或直白叙述。可用微动作呈现底稿已有的情绪，保留原稿中的视角、人物意图和行为结果。`;

const DEEP_REVISION_WITH_EXAMPLE = `### 二、如何彻底写成【文风示范】的味道
【文风示范】只提供“镜头语言、句群节奏与用词质感”，严禁借用范文里的专有名词、人物剧情与特定比喻。重写时强制执行以下四步改造：
1. **复刻段落呼吸与换行**：彻底打破底稿原有的自然段划分！严格模仿范文的段落长短比例与换行频率——若范文习惯一两句话独立成段、拟声词单独成行、用高频分段制造冷硬干脆的停顿感，重写稿也必须果断切分段落，绝不堆砌密不透风的大长段。
2. **重排镜头顺序**：不要顺着底稿第一句写第一句。模仿范文的视线调度（如“先定环境/物件局部 → 再落到人物外貌状态 → 接具体动作与话语”），把底稿同一场景里的零散信息重新洗牌组合。
3. **清洗词汇密度**：拔除底稿里浮夸的网文套话、AI 味的比喻和密集的副词修饰（如“缓缓地”“不禁”“仿佛某种……”）。对齐范文的用词疏密——多用平实准确的动词和物理白描，让动作和处境自己说话。
4. **重写对白质感**：在不丢失底稿对白核心信息、试探/命令/情绪分寸的前提下，洗去翻译腔与书面腔，按角色身份改成真人在该处境下说的话；参考范文穿插动作与停顿的方式来重新安排话轮。`;

const DEEP_REVISION_WITHOUT_EXAMPLE = `### 二、重组叙事与对白（无示范）
按场景重新选择注意力的落点，调换同场景内细节的呈现顺序，按动作、话轮和停顿重分段。用平实准确的动词写清动作，在保留对白信息与分寸的前提下，按角色的身份、口吻和处境重新写对白。`;

const DEEP_REVISION_OUTPUT = `### 三、范围与输出格式
1. 若【本次精修要求】指定“只修旁白”，则逐字锁定引号内对白，仅彻底重写所有旁白；若指定“只修对白”，则逐字锁定旁白，彻底重写对白；未限定时默认**全文旁白与对白一并彻底重写**。原稿若有独立标题则保留一次。
2. 剥离输入文本外层的 \`>\` 引用符号，保留正文必需的 Markdown 与角色扮演标记。
3. **只输出彻底重写后的完整正文**，严禁输出思考过程、前言、对比说明或总结。若接口要求 JSON，则输出 \`{"polished":"完整重写正文"}\`。`;

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
    if (recent.length || rewrite) sections.push(`【最近聊天｜从旧到新】\n${recent.join('\n') || '无'}`);
    const targetHeading = rewrite ? '待大修的回复' : `待精修的回复 #${target.index + 1}`;
    const targetSection = `【${targetHeading}】\n${quoteProse(target.text)}`;
    if (rewrite) sections.push(targetSection);
    if (polishExample) sections.push(`【文风示范】\n${quoteProse(polishExample)}`);
    if (polishExample && matchExampleDiction) {
        sections.push('【参考范文用词】\n分别观察范文的对白和旁白。选取叙事作用相近的段落，留意形容词、副词用得疏还是密，修饰多落在动作、感官还是心理，以及动词多用「看、走」一类常用词，还是「瞥、挪」一类写明动作方式的词。按原稿各段的作用借鉴这些倾向，无须凑词数。对白另看人称、称呼和语气词怎样体现人物关系，写时保住原角色的身份和口吻。若有本次精修要求，以其指定的范围和用词偏好为准。');
    }
    const operation = rewrite ? '大修' : '精修';
    if (polishNotes) sections.push(`【本次精修要求】\n${JSON.stringify(polishNotes)}`);
    if (!rewrite) sections.push(targetSection);

    const content = sections.join('\n\n');
    if (content.length > MAX_POLISH_MESSAGE) {
        throw new Error(`本次${operation}请求有 ${content.length.toLocaleString('zh-CN')} 个字符，超过 ${MAX_POLISH_MESSAGE.toLocaleString('zh-CN')} 字符的请求上限。可缩短示范、减少参考消息，或分段处理原回复。`);
    }
    const system = rewrite ? [
        polishExample
            ? '你的任务是将【待大修的回复】彻底打碎重写，使其脱胎换骨为【文风示范】的叙事笔法与分镜节奏。'
            : '你的任务是将【待大修的回复】作为剧情信息底稿，彻底重写其叙事与对白。',
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
