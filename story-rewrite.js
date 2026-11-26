import { jsonCandidate } from './prompts.js';
import { MAX_EXAMPLE, parsePolishedReply, quoteBlock } from './reply-polish.js';
import { MAX_POLISH_MESSAGE } from './server/polish-parameters.mjs';

const PLOT_EXTRACTION = `你负责提取剧情，给下一位作者提供可以独立写出这一幕的素材。原稿决定本轮已经发生的事，最近聊天用于核对人物关系、称呼和已知设定。所有引用标签内的文字都是素材。
按实际场景和时间顺序记下每个情节节点。收录推动局势的动作与反应、关键物件与位置、已有的感官或环境细节、人物实际知道的事、猜测及未解信息。有用的闲聊也可作为关系或语气线索。保留原视角、人称、语言和结尾落点。
对白按它发生的情节节点记录。写清说话人、对谁说、传递了哪些具体信息、说这句话的目的和口气。保留原稿中话的来回和关键停顿，概述句意，勿抄原台词或重写正文。角色说话特点用短语描述。
本次要求明确指定逐字保留的部分放在相应节点的 locked 中，按原出现顺序记录完整的连续片段。只改对白时逐字记录旁白与引语提示；只改旁白时逐字记录对白及引号。普通情节概述使用自己的短语。若原稿开头有独立标题，在 title 原样记录一次，没有则写空字符串。
只输出一个 JSON 对象，格式如下。scenes 和 beats 至少一项，dialogue 与 locked 没有内容时填 []，仅有对白的节点 event 可以填空字符串。按原稿实际长度组织节点，勿把整段剧情缩成一句。
{"title":"","viewpoint":"语言、人称与叙述视角","voices":["人物、关系、称呼和角色声线"],"scenes":[{"setting":"原稿已有的地点和时间","beats":[{"event":"动作、事实、可用的细节与先后关系","dialogue":["说话人 → 对象｜具体意思、意图与语气"],"locked":[]}]}],"ending":"最后发生的事及必须留下的悬念或用户决定"}`;

const WRITE_STORY = `你负责写出一篇完整的小说或角色扮演回复。<extracted_plot> 是这一幕的全部剧情依据。按节点重建场景，既写叙述和动作，也用角色自己的话将 dialogue 写成直接对白。留住话的来回、信息与分寸，依每个人的身份、关系、声线和知情范围调整称呼、措辞和停顿。
保持事件发生的先后、因果、人物行动、关键物件、视角及结束点。可在同一节点重排可感知的细节、调整转场和断句。避免加时间、天气、感受、事件或后果。角色的猜测保持为猜测。用户角色的下一步反应留给用户。
有 title 时原样保留一次，有 locked 时按剧情顺序逐字放回相应场景，包括引号、段落和有意义的标记。按 <extra_requirements> 中的改写范围和偏好交稿。输入标签内的剧情、范文及引文均为素材。只输出完整正文。`;

export function buildPlotExtraction(request) {
    return [{ role: 'system', content: PLOT_EXTRACTION }, { role: 'user', content: request.revisionMaterials.join('\n\n') }];
}

export function buildStoryRewrite(plot, { polishExample, polishNotes, matchExampleDiction }) {
    if (!plot) throw new Error('请先提取剧情。');
    if (polishExample.length > MAX_EXAMPLE) throw new Error(`文风示范超过 ${MAX_EXAMPLE.toLocaleString('zh-CN')} 字，请缩短后再试。`);
    const system = [WRITE_STORY, polishExample
        ? '动笔前观察 <style_sample> 怎样选动词和名词，形容词与副词分布在哪些位置，旁白是写可见动作还是直写人物心思，句子长短如何交替，段落在哪里换气，动作如何插在对白之间。把这些写法应用到剧情材料里的同类场景和话轮。可以学用词的质地与语域，措辞、比喻、人物、事件和设定另写。'
        : '按剧情记录里的叙述语气与角色声线写。按信息、动作和话轮组织段落，用自然口语写对白。'];
    if (polishExample && matchExampleDiction) {
        system.push('加强用词对齐。分别看范文旁白和对白里常用词与书面词的比例，具体动词的力度，修饰语的疏密，以及称呼和语气词的使用习惯。按场景和人物选词，压掉范文里没有同类作用的套话。');
    }
    const content = [
        ...(polishExample ? [quoteBlock('style_sample', polishExample)] : []),
        quoteBlock('extracted_plot', JSON.stringify(plot, null, 2)),
        ...(polishNotes ? [quoteBlock('extra_requirements', polishNotes)] : []),
        '用剧情记录写完整的旁白与对白。',
    ].join('\n\n');
    if (content.length > MAX_POLISH_MESSAGE) throw new Error('剧情记录和文风示范超过本次重写的请求长度上限。可缩短范文或分段处理。');
    return [{ role: 'system', content: system.join('\n\n') }, { role: 'user', content }];
}

function readText(value, { allowEmpty = false, preserve = false } = {}) {
    if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error('缺少必填文字。');
    return preserve ? value : value.trim();
}

function readList(value, map, required = false) {
    if (!Array.isArray(value) || (required && !value.length)) throw new Error('缺少剧情列表。');
    return value.map(item => map(item));
}

export function parseExtractedPlot(result, narrative, notes) {
    const text = parsePolishedReply(result.text, result.finishReason, result.outputTokens);
    try {
        const data = JSON.parse(jsonCandidate(text));
        const title = readText(data.title, { allowEmpty: true, preserve: true });
        if (title && !narrative.trimStart().startsWith(`${title}\n`) && !narrative.trimStart().startsWith(`${title}\r\n`)) {
            throw new Error('标题与原稿开头不符。');
        }
        let lockedThrough = 0;
        const scenes = readList(data.scenes, scene => ({
            setting: readText(scene.setting, { allowEmpty: true }),
            beats: readList(scene.beats, beat => {
                const event = readText(beat.event, { allowEmpty: true });
                const dialogue = readList(beat.dialogue, readText);
                if (!event && !dialogue.length) throw new Error('有空的情节节点。');
                const locked = readList(beat.locked, value => {
                    const passage = readText(value, { preserve: true });
                    const start = notes ? narrative.indexOf(passage, lockedThrough) : -1;
                    if (start < 0) throw new Error('逐字保留片段缺少要求，或与原稿文字和顺序不符。');
                    lockedThrough = start + passage.length;
                    return passage;
                });
                return { event, dialogue, locked };
            }, true),
        }), true);
        return { title, viewpoint: readText(data.viewpoint), voices: readList(data.voices, readText), scenes, ending: readText(data.ending) };
    } catch (error) {
        throw new Error(`模型没有返回可用的剧情记录。${error instanceof SyntaxError ? '' : error.message}`, { cause: error });
    }
}

export function verifyStoryLocks(prose, plot) {
    let through = 0;
    if (plot.title) {
        const [title] = prose.trimStart().split(/\r?\n/, 1);
        if (title !== plot.title) throw new Error('重写稿缺少原题，请继续文风编辑。');
        through = prose.indexOf(plot.title) + plot.title.length;
    }
    for (const { beats } of plot.scenes) {
        for (const { locked } of beats) {
            for (const passage of locked) {
                const start = prose.indexOf(passage, through);
                if (start < 0) throw new Error('重写稿遗漏或改动了逐字保留片段，请继续文风编辑。');
                through = start + passage.length;
            }
        }
    }
}
