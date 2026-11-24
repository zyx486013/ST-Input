import { appendGuidance, GUIDANCE_KEY, readGuidance, saveGuide } from './writing-guidance.js';
import { getRegexedString, regex_placement } from '/scripts/extensions/regex/engine.js';
import { createRawPrompt } from '/script.js';
import { createGenerationParameters, getStreamingReply, proxies } from '/scripts/openai.js';
import { completeWithSillyTavern } from './connections.js';
import { TIMEOUT_524_MESSAGE } from './polish-stream.js';
import { appendLogicFindings, latestModelReply, LOGIC_LABEL, LOGIC_MODE, parseLogicFindings, prepareLogicCheck } from './logic-check.js';
import { buildPrompt, getChatMessages, MAX_DRAFT, MODES, parseResult, REVIEW_LABEL, REVIEW_MODE } from './prompts.js';
import { MAX_POLISH_OUTPUT_TOKENS, MAX_STANDARD_MESSAGE, validatePolishParameters } from './server/polish-parameters.mjs';
import { MAX_EXAMPLE, MAX_EXAMPLE_NAME, MAX_POLISH_NOTES, migratePolishExample, parsePolishedReply, POLISH_LABEL, POLISH_MODE, prepareReplyPolish, samePolishTarget, writePolishedReply } from './reply-polish.js';

const KEY = 'st-input';
const SERVICE = '/api/plugins/st-input';
const DEFAULTS = { connection: 'current', profileId: '', history: true, historyCount: 8, fullscreen: true };
const context = () => SillyTavern.getContext();
const settings = () => context().extensionSettings[KEY] ??= { ...DEFAULTS };
const chatCompletion = { createRawPrompt, createGenerationParameters, getStreamingReply, getProxies: () => proxies };

function getPolishDisplayText(st, { index, text }) {
    const message = st.chat[index];
    let placement = regex_placement.AI_OUTPUT;
    if (message.is_user) placement = regex_placement.USER_INPUT;
    else if (message.extra?.type === 'narrator') placement = regex_placement.SLASH_COMMAND;

    // ST counts all non-system messages after this one, even if the prompt omits them.
    const depth = st.chat.slice(index + 1).filter(item => !item.is_system).length;
    const powerUser = st.powerUserSettings;
    const bias = !powerUser?.show_user_prompt_bias && !message.is_user && message.name && powerUser?.user_prompt_bias
        ? st.substituteParams(powerUser.user_prompt_bias)
        : '';
    const visibleText = bias && text.startsWith(bias) ? text.slice(bias.length) : text;
    return getRegexedString(visibleText, placement, { characterOverride: message.name, isMarkdown: true, depth });
}

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
}

function button(text, action) {
    const node = element('button', text, 'menu_button');
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
}

async function service(route, { method = 'GET', data, signal } = {}) {
    const response = await fetch(`${SERVICE}/${route}`, {
        method,
        body: data === undefined ? undefined : JSON.stringify(data),
        headers: context().getRequestHeaders(),
        credentials: 'same-origin',
        signal,
    });
    const result = await response.json().catch(() => null);
    if (response.status === 404) throw new Error('找不到配套服务端插件。请安装插件、启用 enableServerPlugins，然后重启 SillyTavern。');
    if (response.status === 524 || /\b524\b/.test(result?.error ?? '')) throw new Error(TIMEOUT_524_MESSAGE);
    if (!response.ok || !result) throw new Error(result?.error || `服务端请求失败（HTTP ${response.status}）。`);
    return result;
}

function getProfiles() {
    try {
        return context().ConnectionManagerRequestService?.getSupportedProfiles() ?? [];
    } catch {
        return [];
    }
}

async function complete(messages, connection, profileId, signal, maxTokens = 1600, options) {
    if (connection === 'custom') {
        const data = options?.withDetails ? {
            messages, withDetails: true, outputTokens: options.requestedPolishTokens, parameters: options.parameters,
        } : { messages };
        const result = await service('generate', { method: 'POST', data, signal });
        return options?.withDetails ? result : result.text;
    }
    return completeWithSillyTavern(context(), messages, connection, profileId, signal, maxTokens, options);
}

function mount() {
    const form = document.getElementById('send_form');
    const textarea = document.getElementById('send_textarea');
    const anchor = document.getElementById('rightSendForm');
    if (!form || !textarea || !anchor || document.getElementById('st-input-launch')) return;
    const stored = settings();
    if (migratePolishExample(stored)) context().saveSettingsDebounced();
    const config = { ...DEFAULTS, ...stored };
    config.polishExamples ??= [];

    const panel = element('dialog');
    panel.id = 'st-input-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', '输入助手');
    panel.innerHTML = `
        <div class="st-input-shell">
            <header class="st-input-bar">
                <strong>输入助手</strong>
                <span data-st="connection-label"></span>
                <button class="menu_button" type="button" data-st="layout"></button>
                <button class="menu_button" type="button" data-st="close" aria-label="关闭输入助手">关闭</button>
            </header>
            <nav class="st-input-nav" aria-label="选择工具">
                <button type="button" data-view="draft">写输入</button>
                <button type="button" data-view="polish">精修回复</button>
                <button type="button" data-view="logic">逻辑检查</button>
            </nav>
            <div class="st-input-work">
                <section data-workspace="draft">
                    <div class="st-input-actions" data-st="actions"></div>
                </section>
                <section data-workspace="logic" hidden>
                    <div class="st-input-actions">
                        <button class="menu_button st-input-primary" type="button" data-st="logic">检查回复逻辑</button>
                        <button class="menu_button" type="button" data-st="review">${REVIEW_LABEL}</button>
                    </div>
                    <details data-st="guidance" hidden>
                        <summary data-st="guidance-title">写作指导</summary>
                        <div class="st-input-config">
                            <div data-st="guidance-list"></div>
                            <label><input type="checkbox" data-st="guidance-enabled"> 整理和追问时附到建议草稿</label>
                            <div class="st-input-actions">
                                <button class="menu_button" type="button" data-st="insert-guides">把指导加入输入框</button>
                                <button class="menu_button" type="button" data-st="insert-issues">指出问题并加入指导</button>
                            </div>
                        </div>
                    </details>
                </section>
                <section id="st-input-polish" class="st-input-config" data-workspace="polish" data-st="polish" hidden>
                    <fieldset class="st-input-style-mode" data-st="polish-method">
                        <legend>修改方式</legend>
                        <label><input type="radio" name="st-input-polish-method" data-st="polish-light">精修</label>
                        <label title="保留原稿情节，重新组织整段旁白和对白"><input type="radio" name="st-input-polish-method" data-st="polish-rewrite">大修</label>
                    </fieldset>
                    <fieldset class="st-input-style-mode">
                        <legend>文风示范</legend>
                        <label><input type="radio" name="st-input-use-example" data-st="without-example">无示范</label>
                        <label><input type="radio" name="st-input-use-example" data-st="with-example">有示范</label>
                    </fieldset>
                    <div class="st-input-example-tools" data-st="example-tools" hidden>
                        <label>选择示范<select class="text_pole" data-st="polish-examples"></select></label>
                        <details data-st="example-editor">
                            <summary data-st="example-editor-label">编辑示范</summary>
                            <div class="st-input-config">
                                <label>示范正文<textarea class="text_pole st-input-draft" rows="3" data-st="polish-example" aria-describedby="st-input-example-count" placeholder="粘贴一段你认可的对白或叙述"></textarea></label>
                                <small id="st-input-example-count" data-st="example-count"></small>
                                <label>示范名称<input type="text" class="text_pole" maxlength="${MAX_EXAMPLE_NAME}" data-st="polish-example-name" placeholder="保存到列表时填写"></label>
                                <div class="st-input-actions">
                                    <button class="menu_button" type="button" data-st="polish-save-example">保存示范</button>
                                    <button class="menu_button" type="button" data-st="polish-delete-example" hidden>删除示范</button>
                                </div>
                            </div>
                        </details>
                    </div>
                    <div>
                        <div class="st-input-actions">
                            <label for="st-input-polish-notes">本次精修要求 <small>选填</small></label>
                            <button type="button" class="menu_button" data-st="polish-diction" aria-pressed="false" title="分别参考范文对白和旁白的修饰疏密、动词和语气词" hidden>参考范文用词</button>
                        </div>
                        <textarea id="st-input-polish-notes" class="text_pole st-input-draft" rows="2" maxlength="${MAX_POLISH_NOTES}" data-st="polish-notes" placeholder="例如：缩短对白，用动作表现犹豫"></textarea>
                    </div>
                    <div class="st-input-actions">
                        <button class="menu_button st-input-primary" type="button" data-st="polish-generate">开始精修</button>
                        <button class="menu_button" type="button" data-st="polish-undo" hidden>恢复原回复</button>
                    </div>
                </section>
                <div class="st-input-actions" data-st="request-actions"></div>
            </div>
            <div class="st-input-utilities">
                <details data-st="polish-options" hidden>
                    <summary>精修参数</summary>
                    <div class="st-input-config">
                        <label class="st-input-check" data-st="polish-stream-options" hidden><input type="checkbox" data-st="polish-stream">流式接收</label>
                        <label>输出上限（tokens） <input type="number" class="text_pole" min="1" max="${MAX_POLISH_OUTPUT_TOKENS}" step="1" placeholder="自动" data-st="polish-budget"></label>
                        <label data-st="polish-parameter-options">附加参数（YAML 或 JSON）
                            <textarea class="text_pole st-input-draft" rows="3" maxlength="8192" data-st="polish-parameters" placeholder="reasoning_effort: max"></textarea>
                        </label>
                    </div>
                </details>
                <details>
                    <summary>聊天上下文</summary>
                    <div class="st-input-config">
                        <label class="st-input-check"><input type="checkbox" data-st="history">使用聊天上下文</label>
                        <label>最近消息数 <input type="number" class="text_pole" min="1" max="40" step="1" data-st="history-count"></label>
                        <label>参考旧消息 <select class="text_pole" data-st="reference"></select></label>
                    </div>
                </details>
                <details data-st="settings">
                    <summary>连接设置</summary>
                    <div class="st-input-config">
                        <label>连接方式
                            <select class="text_pole" data-st="connection">
                                <option value="current">跟随当前聊天连接</option>
                                <option value="profile">使用 SillyTavern 已保存的连接</option>
                                <option value="custom">自定义 API</option>
                            </select>
                        </label>
                        <label data-st="profile-field">连接配置 <select class="text_pole" data-st="profiles"></select></label>
                        <div class="st-input-config" data-st="custom">
                            <label>API 地址 <input class="text_pole" data-st="url" type="url" autocomplete="off" placeholder="https://api.example.com/v1"></label>
                            <label>API Key <input class="text_pole" data-st="key" type="password" autocomplete="new-password" maxlength="4096"></label>
                            <label><input data-st="clear-key" type="checkbox"> 清除已保存的 Key</label>
                            <label>模型 ID <input class="text_pole" data-st="model" type="text" autocomplete="off" maxlength="240" list="st-input-models"></label>
                            <datalist id="st-input-models" data-st="model-list"></datalist>
                            <div class="st-input-actions">
                                <button class="menu_button" type="button" data-st="load-custom" hidden>读取服务端配置</button>
                                <button class="menu_button" type="button" data-st="load-models">获取模型</button>
                                <button class="menu_button" type="button" data-st="save-custom">保存自定义 API</button>
                            </div>
                        </div>
                        <div><button class="menu_button" type="button" data-st="test">测试连接</button></div>
                        <div role="status" aria-live="polite" class="st-input-status" data-st="config-status"></div>
                    </div>
                </details>
                <details data-st="preview">
                    <summary>提示词预览</summary>
                    <label>预览操作 <select class="text_pole" data-st="preview-mode"></select></label>
                    <div class="st-input-preview" data-st="preview-content"></div>
                </details>
            </div>
        </div>`;

    const ui = Object.fromEntries([...panel.querySelectorAll('[data-st]')].map(node => [node.dataset.st, node]));
    const launch = button('输入助手', () => setOpen(panel.hidden));
    launch.id = 'st-input-launch';
    launch.setAttribute('aria-controls', panel.id);
    launch.setAttribute('aria-expanded', 'false');
    anchor.before(launch);
    form.prepend(panel);

    let pending;
    let checking = false;
    let savingGuidance = false;
    let revision = 0;
    let undoDraft;
    let undoReply;
    let comparison;
    let writingReply = false;
    let customConfig;
    let lastPrompt;

    const views = [...panel.querySelectorAll('[data-view]')];
    const workspaces = [...panel.querySelectorAll('[data-workspace]')];
    if (!views.some(node => node.dataset.view === config.workspace)) config.workspace = 'draft';
    const outputs = new Map(workspaces.map(section => {
        const status = element('div', null, 'st-input-status');
        status.setAttribute('role', 'status');
        const result = element('div', null, 'st-input-result');
        section.append(status, result);
        return [section.dataset.workspace, { status, result }];
    }));
    const output = () => outputs.get(config.workspace);
    const setStatus = message => { output().status.textContent = message; };
    const setConfigStatus = message => { ui['config-status'].textContent = message; };
    const streamPreview = element('details', null, 'st-input-config');
    streamPreview.hidden = true;
    const streamTitle = element('summary', '流式预览');
    const streamText = element('textarea', null, 'text_pole st-input-draft');
    streamText.setAttribute('aria-label', '已收到的精修正文');
    streamText.readOnly = true;
    streamText.rows = 8;
    const copyStream = button('复制已收到的正文', async () => {
        try {
            await navigator.clipboard.writeText(streamText.value);
        } catch {
            streamText.focus();
            streamText.select();
        }
    });
    streamPreview.append(streamTitle, streamText, copyStream);
    outputs.get(POLISH_MODE).result.before(streamPreview);
    let streamFrame;
    let receivedText = '';
    function clearStreamPreview() {
        cancelAnimationFrame(streamFrame);
        receivedText = '';
        streamText.value = '';
        streamPreview.hidden = true;
    }

    function previewStreamText(text) {
        if (streamPreview.hidden) {
            streamTitle.textContent = '流式预览 · 正在接收';
            streamPreview.hidden = false;
            streamPreview.open = true;
            setStatus('正在接收正文…');
        }
        receivedText = text;
        cancelAnimationFrame(streamFrame);
        streamFrame = requestAnimationFrame(() => {
            streamText.value = receivedText;
        });
    }
    const saveSettings = () => {
        Object.assign(settings(), config);
        context().saveSettingsDebounced();
    };
    const undo = button('恢复原稿', () => {
        if (!undoDraft || textarea.value !== undoDraft.inserted) {
            setStatus('输入框已继续编辑，已保留当前文字。');
            return;
        }
        writeDraft(undoDraft.previous);
        undoDraft = undefined;
        undo.hidden = true;
        setStatus('已恢复原稿。');
    });
    undo.hidden = true;

    for (const [mode, label] of Object.entries({ ...MODES, [LOGIC_MODE]: LOGIC_LABEL, [REVIEW_MODE]: REVIEW_LABEL, [POLISH_MODE]: POLISH_LABEL })) {
        if (mode in MODES) {
            const action = button(label, () => start(mode));
            action.dataset.mode = mode;
            ui.actions.append(action);
        }
        ui['preview-mode'].append(new Option(label, mode));
    }
    const cancel = button('取消', () => clearRequest('已取消。', pending?.mode === POLISH_MODE));
    cancel.hidden = true;
    ui['request-actions'].append(cancel, undo);
    ui.logic.addEventListener('click', () => start(LOGIC_MODE));
    ui.review.addEventListener('click', () => start(REVIEW_MODE));
    for (const view of views) {
        view.addEventListener('click', () => {
            config.workspace = view.dataset.view;
            saveSettings();
            renderWorkspace();
        });
    }

    function writeDraft(value) {
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        if (!panel.hidden && config.fullscreen) setOpen(false);
        textarea.focus();
    }

    function replaceDraft(value) {
        undoDraft = { previous: textarea.value, inserted: value };
        writeDraft(value);
        undo.hidden = false;
    }

    function renderPanelLayout(open) {
        if (panel.open) panel.close();
        panel.classList.toggle('st-input-fullscreen', config.fullscreen);
        ui.layout.textContent = config.fullscreen ? '小窗口' : '全屏';
        if (config.fullscreen) document.body.append(panel);
        else form.prepend(panel);
        panel.hidden = !open;
        if (open && config.fullscreen) panel.showModal();
        else if (open) panel.show();
    }

    function setOpen(open) {
        renderPanelLayout(open);
        launch.setAttribute('aria-expanded', String(open));
        if (open) {
            refreshReferences();
            renderGuidance();
            refreshProfiles();
            renderConnection();
            if (config.connection === 'custom' && !customConfig) loadCustom();
            views.find(view => view.dataset.view === config.workspace)?.focus({ preventScroll: true });
        } else {
            ui.key.value = '';
            ui['clear-key'].checked = false;
            launch.focus({ preventScroll: true });
        }
    }

    function refreshReferences() {
        const selected = ui.reference.value;
        const chat = config.history ? getChatMessages(context().chat) : [];
        const options = [new Option('不指定', '')];
        for (const message of chat.reverse()) {
            const excerpt = message.text.trim().replace(/\s+/g, ' ').slice(0, 52);
            options.push(new Option(`#${message.index + 1} ${message.name || message.role} · ${excerpt}`, String(message.index)));
        }
        ui.reference.replaceChildren(...options);
        ui.reference.value = options.some(option => option.value === selected) ? selected : '';
        ui.reference.disabled = !config.history || !chat.length;
        ui['history-count'].disabled = !config.history;
    }

    function refreshProfiles() {
        const profiles = getProfiles();
        const options = [new Option(profiles.length ? '选择连接配置' : '没有可用的连接配置', '')];
        for (const profile of profiles) options.push(new Option(profile.name, profile.id));
        if (config.profileId && !profiles.some(profile => profile.id === config.profileId)) {
            options.push(new Option('原连接配置已不可用', config.profileId));
        }
        ui.profiles.replaceChildren(...options);
        ui.profiles.value = config.profileId;
    }

    function renderConnection() {
        ui['profile-field'].hidden = config.connection !== 'profile';
        ui.custom.hidden = config.connection !== 'custom';
        const st = context();
        const mainModel = st.mainApi === 'openai' ? st.getChatCompletionModel?.() : '';
        const profile = config.connection === 'profile' ? getProfiles().find(item => item.id === config.profileId) : null;
        const connectionApi = config.connection === 'profile' ? st.CONNECT_API_MAP?.[profile?.api]?.selected : st.mainApi;
        ui['polish-parameter-options'].hidden = config.connection !== 'custom' && connectionApi !== 'openai';
        ui['polish-stream-options'].hidden = config.connection === 'custom' || connectionApi !== 'openai';
        ui['connection-label'].textContent = {
            current: mainModel ? `当前连接 · ${mainModel}` : '当前聊天连接',
            profile: profile ? [profile.name, profile.model].filter(Boolean).join(' · ') : '选择连接配置',
            custom: customConfig?.model || '自定义 API',
        }[config.connection];
    }

    function updateBusy() {
        const busy = Boolean(pending) || writingReply;
        for (const action of ui.actions.querySelectorAll('[data-mode]')) action.disabled = busy;
        for (const view of views) view.disabled = busy;
        ui.logic.disabled = busy;
        ui.review.disabled = busy;
        ui['polish-method'].disabled = busy;
        ui['polish-stream'].disabled = busy;
        ui['polish-generate'].disabled = busy || (ui['with-example'].checked && !ui['polish-example'].value.trim());
        ui['polish-undo'].disabled = busy;
        const apply = output().result.querySelector('[data-polish-apply]');
        if (apply) apply.disabled = busy || apply.dataset.polishApply === 'false';
        cancel.hidden = !pending;
        for (const key of ['load-custom', 'load-models', 'save-custom', 'test']) ui[key].disabled = checking;
        for (const key of ['url', 'model', 'key', 'connection', 'profiles']) ui[key].disabled = checking;
        ui['clear-key'].disabled = checking || !customConfig?.hasKey;
    }

    function clearRequest(message = '', keepComparison = false) {
        revision += 1;
        pending?.controller.abort();
        if (!keepComparison) {
            clearStreamPreview();
            comparison = undefined;
            for (const { status, result } of outputs.values()) {
                result.replaceChildren();
                status.textContent = '';
            }
        } else if (receivedText) {
            streamTitle.textContent = '流式预览 · 未完成';
        }
        lastPrompt = undefined;
        refreshPreview();
        setStatus(message);
    }

    function getSource(mode) {
        const st = context();
        const history = config.history || mode === LOGIC_MODE || mode === POLISH_MODE || mode === REVIEW_MODE ? getChatMessages(st.chat) : [];
        const pinned = config.history && ui.reference.value ? Number(ui.reference.value) : undefined;
        const source = { mode, draft: textarea.value, history, historyCount: config.history ? config.historyCount : 0, pinned };
        if (mode in MODES) {
            const guidance = readGuidance(st.chatMetadata);
            source.guidance = guidance.enabled ? guidance.items : [];
        }
        if (mode === POLISH_MODE) {
            source.displayText = message => getPolishDisplayText(st, message);
            const example = ui['polish-example'].value;
            source.polishExample = ui['with-example'].checked && example.trim() ? example : '';
            source.polishNotes = ui['polish-notes'].value.trim();
            source.matchExampleDiction = config.matchExampleDiction;
            source.rewrite = config.polishRewrite === true;
        }
        return source;
    }

    function buildRequest(source, answers, final) {
        if (source.mode === LOGIC_MODE) return prepareLogicCheck(source);
        if (source.mode === POLISH_MODE) return prepareReplyPolish(source);
        const prompt = buildPrompt({ ...source, answers, final });
        const target = source.mode === REVIEW_MODE ? latestModelReply(source.history) : null;
        return { prompt, target };
    }

    function showPrompt(prompt) {
        ui['preview-content'].textContent = prompt.map(message => `[${message.role}]\n${message.content}`).join('\n\n');
    }

    function refreshPreview() {
        if (!ui.preview.open) return;
        try {
            const mode = ui['preview-mode'].value;
            const prompt = lastPrompt?.mode === mode && lastPrompt.draft === textarea.value
                ? lastPrompt.messages : buildRequest(getSource(mode)).prompt;
            showPrompt(prompt);
        } catch (error) {
            ui['preview-content'].textContent = error.message;
        }
    }

    function start(mode) {
        ui['preview-mode'].value = mode;
        void run(getSource(mode));
    }

    function renderWorkspace() {
        const current = config.workspace;
        for (const view of views) view.setAttribute('aria-pressed', String(view.dataset.view === current));
        for (const section of workspaces) section.hidden = section.dataset.workspace !== current;
        panel.classList.toggle('st-input-polish-open', current === POLISH_MODE);
        ui['polish-options'].hidden = current !== POLISH_MODE;
        ui['preview-mode'].value = current === 'draft'
            ? (lastPrompt?.mode in MODES ? lastPrompt.mode : 'rewrite') : current;
        refreshPreview();
    }

    function renderStyleMode() {
        ui['example-tools'].hidden = !ui['with-example'].checked;
        ui['polish-diction'].hidden = !ui['with-example'].checked;
        ui['polish-diction'].setAttribute('aria-pressed', String(Boolean(config.matchExampleDiction)));
        refreshPolishExamplePreview();
    }

    function refreshPolishExamplePreview() {
        if (lastPrompt?.mode === POLISH_MODE) lastPrompt = undefined;
        updateBusy();
        if (ui['preview-mode'].value === POLISH_MODE) refreshPreview();
    }

    function updateExampleLength() {
        const field = ui['polish-example'];
        const length = field.value.length;
        const count = `${length.toLocaleString('zh-CN')} / ${MAX_EXAMPLE.toLocaleString('zh-CN')} 字`;
        const error = length > MAX_EXAMPLE ? '示范超出字数上限，请缩短。' : '';
        ui['example-count'].textContent = error ? `${count} · ${error}` : count;
        field.setAttribute('aria-invalid', String(Boolean(error)));
        field.setCustomValidity(error);
    }

    function renderPolishExampleOptions() {
        const options = config.polishExamples.map(({ name }) => new Option(name, name));
        ui['polish-examples'].replaceChildren(new Option('新建示范', ''), ...options);
        ui['polish-examples'].value = config.polishExampleSelection ?? '';
        ui['polish-delete-example'].hidden = !config.polishExampleSelection;
        ui['example-editor-label'].textContent = config.polishExampleSelection ? '编辑示范' : '填写示范';
    }

    function loadPolishExample(name) {
        const selected = config.polishExamples.find(example => example.name === name);
        config.polishExampleSelection = selected?.name ?? '';
        ui['polish-example-name'].value = selected?.name ?? '';
        ui['polish-example'].value = selected?.text ?? '';
        renderPolishExampleOptions();
        ui['example-editor'].open = !selected;
        updateExampleLength();
        refreshPolishExamplePreview();
    }

    function savePolishExample() {
        if (!ui['polish-example'].reportValidity()) return;
        const name = ui['polish-example-name'].value.trim();
        const text = ui['polish-example'].value;
        if (!name || !text.trim()) {
            setStatus('请填写示范名称和正文。');
            return;
        }
        const active = config.polishExampleSelection;
        if (config.polishExamples.some(example => example.name === name && example.name !== active)) {
            setStatus('已有同名示范，请换个名称。');
            return;
        }
        const examples = [...config.polishExamples];
        const index = examples.findIndex(example => example.name === active);
        examples[index === -1 ? examples.length : index] = { name, text };
        config.polishExamples = examples;
        config.polishExampleSelection = name;
        ui['polish-example-name'].value = name;
        renderPolishExampleOptions();
        saveSettings();
        ui['example-editor'].open = false;
        ui['polish-examples'].focus();
        setStatus('已保存示范。');
    }

    function startPolish() {
        const source = getSource(POLISH_MODE);
        if (source.polishExample && !ui['polish-example'].validity.valid) {
            ui['example-editor'].open = true;
            ui['polish-example'].reportValidity();
            return;
        }
        const field = ui['polish-budget'];
        if (!field.validity.valid) {
            ui['polish-options'].open = true;
            field.reportValidity();
            return;
        }
        source.requestedPolishTokens = field.value ? field.valueAsNumber : undefined;
        const text = ui['polish-parameter-options'].hidden ? '' : ui['polish-parameters'].value.trim();
        if (text) {
            try {
                let parameters;
                try {
                    parameters = SillyTavern.libs.yaml.parse(text);
                } catch {
                    throw new Error('精修附加参数格式有误，请检查 YAML 或 JSON。');
                }
                source.parameters = validatePolishParameters(parameters);
            } catch (error) {
                ui['polish-options'].open = true;
                ui['polish-parameters'].focus();
                setStatus(error.message);
                return;
            }
        }
        ui['preview-mode'].value = POLISH_MODE;
        void run(source);
    }

    function chatIsGenerating(st) {
        return Boolean(st.streamingProcessor) || document.body.dataset.generating === 'true';
    }

    async function run(source, answers = [], final = false) {
        if (pending || writingReply) return;
        const currentRevision = ++revision;
        const st = context();
        const chatId = st.getCurrentChatId();
        const polish = source.mode === POLISH_MODE;
        if (polish) clearStreamPreview();
        else output().result.replaceChildren();
        lastPrompt = undefined;
        setStatus('');
        try {
            const request = buildRequest(source, answers, final);
            const { prompt, target } = request;
            const message = polish ? st.chat[target.index] : null;
            const snapshot = polish ? { ...target, message, chatId, chatLength: st.chat.length, swipeId: message.swipe_id } : null;
            if (polish && chatIsGenerating(st)) throw new Error('请等当前回复生成完毕，再开始精修。');
            lastPrompt = { mode: source.mode, draft: source.draft, messages: prompt };
            showPrompt(prompt);
            pending = { controller: new AbortController(), mode: source.mode };
            updateBusy();
            setStatus('正在处理…');
            const signal = pending.controller.signal;
            if (polish && config.connection === 'custom') {
                const needsParameters = source.requestedPolishTokens || Object.keys(source.parameters ?? {}).length;
                const messageLength = prompt[1].content.length;
                if (needsParameters || messageLength > MAX_STANDARD_MESSAGE) {
                    const saved = customConfig ?? await service('config', { signal });
                    signal.throwIfAborted();
                    if (messageLength > (saved.maxPolishMessage ?? MAX_STANDARD_MESSAGE)) {
                        throw new Error('本次请求超过当前自定义 API 服务端插件的长度上限。请更新配套插件并重启 SillyTavern。');
                    }
                    if (needsParameters && !saved.polishParameters) throw new Error('自定义 API 的精修参数需要新版服务端插件，请更新插件并重启 SillyTavern。');
                }
            }
            const maxTokens = polish ? Math.min(MAX_POLISH_OUTPUT_TOKENS, Math.max(2400, target.text.length + 800)) : target ? 2400 : undefined;
            const useStream = polish && config.polishStreaming !== false && !ui['polish-stream-options'].hidden;
            const result = await complete(prompt, config.connection, config.profileId, signal, maxTokens, {
                withDetails: polish,
                requestedPolishTokens: source.requestedPolishTokens,
                parameters: source.parameters,
                yaml: SillyTavern.libs?.yaml,
                chatCompletion: polish ? { ...chatCompletion, stream: useStream } : undefined,
                onText: useStream ? text => {
                    if (currentRevision === revision && !signal.aborted) previewStreamText(text);
                } : undefined,
            });
            if (currentRevision !== revision || chatId !== context().getCurrentChatId()) return;
            if (polish) {
                checkPolishSource(snapshot);
                const text = parsePolishedReply(result.text, result.finishReason, result.outputTokens);
                clearStreamPreview();
                showPolishedVersion(snapshot, source, text);
                return;
            }
            if (target) {
                setStatus('');
                if (source.mode === REVIEW_MODE) {
                    if (!reviewTargetChanged(target)) renderReview(parseResult(result, REVIEW_MODE, false, target.text).review, target);
                    return;
                }
                if (logicTargetChanged(target)) return;
                renderLogicFindings(parseLogicFindings(result, request), target);
                return;
            }
            setStatus(textarea.value === source.draft ? '' : '输入框已有新编辑。建议保留在面板中供你预览。');
            renderResult(parseResult(result, source.mode, final), source);
        } catch (error) {
            if (currentRevision === revision) {
                if (polish && receivedText) streamTitle.textContent = '流式预览 · 未完成';
                setStatus(error.message);
            }
        } finally {
            pending = undefined;
            updateBusy();
        }
    }

    function checkPolishSource(target) {
        const st = context();
        if (!samePolishTarget(st, target)) throw new Error('模型回复或版本已变化，请重新精修。');
        if (getPolishDisplayText(st, { index: target.index, text: target.rawText }) !== target.text) {
            throw new Error('正则处理后的回复已变化，请重新精修。');
        }
    }

    function showPolishedVersion(target, source, text) {
        const { polishExample, polishNotes: notes, rewrite } = source;
        if (comparison?.target.message !== target.message || comparison.target.text !== target.text
            || comparison.target.rawText !== target.rawText || comparison.target.swipeId !== target.swipeId || comparison.notes !== notes) {
            comparison = { target, notes, versions: new Map() };
        }
        const versionName = `${polishExample ? '有示范' : '无示范'}${rewrite ? '大修稿' : '稿'}`;
        comparison.versions.set(versionName, text);
        renderPolishComparison(comparison, versionName);
        setStatus(rewrite ? '大修稿已生成。' : '精修稿已生成。');
    }

    function renderPolishComparison(result, versionName) {
        const { target, versions } = result;
        const stack = element('div', null, 'st-input-config');
        const controls = element('div', null, 'st-input-actions');
        const version = element('select', null, 'text_pole');
        version.setAttribute('aria-label', '对比稿件');
        const baseline = element('select', null, 'text_pole');
        baseline.setAttribute('aria-label', '对照文本');
        baseline.append(new Option('对照原回复', 'original'));
        for (const name of versions.keys()) {
            version.append(new Option(name, name));
            if (name !== versionName) baseline.append(new Option(`对照${name}`, name));
        }
        version.value = versionName;
        version.addEventListener('change', () => renderPolishComparison(result, version.value));
        baseline.hidden = versions.size < 2;

        const editor = element('textarea', null, 'text_pole st-input-draft');
        editor.setAttribute('aria-label', '编辑精修稿');
        editor.rows = 6;
        editor.value = versions.get(versionName);
        editor.hidden = true;
        const edit = button('编辑精修稿', () => {
            editor.hidden = !editor.hidden;
            edit.textContent = editor.hidden ? '编辑精修稿' : '完成编辑';
            edit.setAttribute('aria-expanded', String(!editor.hidden));
            if (!editor.hidden) editor.focus();
        });
        edit.setAttribute('aria-expanded', 'false');
        controls.append(version, baseline, edit);

        const columns = element('div', null, 'st-input-compare');
        const original = element('pre', null, 'st-input-compare-text');
        original.tabIndex = 0;
        const revised = element('pre', null, 'st-input-compare-text');
        revised.tabIndex = 0;
        revised.setAttribute('aria-label', '精修稿');
        const originalColumn = element('section');
        const revisedColumn = element('section');
        const originalTitle = element('strong');
        originalColumn.append(originalTitle, original);
        revisedColumn.append(element('strong', `${versionName} · 下划线为新增`), revised);
        columns.append(originalColumn, revisedColumn);

        const actions = element('div', null, 'st-input-actions');
        const apply = button('替换聊天回复', () => void changeReply(target, versions.get(versionName), target.rawText));
        const copy = button('复制精修稿', async () => {
            try {
                await navigator.clipboard.writeText(versions.get(versionName));
                setStatus('已复制精修稿。');
            } catch {
                setStatus('无法访问剪贴板。可打开「编辑精修稿」手动复制。');
            }
        });
        actions.append(apply, copy);
        const summary = element('small', null, 'st-input-polish-summary');
        const differ = typeof globalThis.diff_match_patch === 'function' ? new globalThis.diff_match_patch() : null;
        if (differ) differ.Diff_Timeout = 0.06;

        function compare() {
            const text = versions.get(versionName);
            const before = versions.get(baseline.value) ?? target.text;
            const beforeName = baseline.value === 'original' ? '原回复' : baseline.value;
            originalTitle.textContent = `${beforeName} · 删除线为删改`;
            original.setAttribute('aria-label', beforeName);
            original.replaceChildren();
            revised.replaceChildren();
            if (!differ || text === before) {
                original.textContent = before;
                revised.textContent = text;
            } else {
                const differences = differ.diff_main(before, text);
                differ.diff_cleanupSemantic(differences);
                if (differences.some(([, part]) => /[\uD800-\uDFFF]/u.test(part))) {
                    original.append(element('del', before));
                    revised.append(element('ins', text));
                } else {
                    for (const [operation, part] of differences) {
                        if (operation === 0) {
                            original.append(part);
                            revised.append(part);
                        } else if (operation < 0) original.append(element('del', part));
                        else revised.append(element('ins', part));
                    }
                }
            }
            const canApply = text !== target.text && Boolean(text.trim());
            apply.dataset.polishApply = String(canApply);
            apply.disabled = !canApply || Boolean(pending) || writingReply;
            copy.disabled = !text.trim();
            summary.textContent = text === before ? '两份文字相同。' : `${beforeName} ${[...before].length} 字 · ${versionName} ${[...text].length} 字`;
        }

        let frame;
        editor.addEventListener('input', () => {
            versions.set(versionName, editor.value);
            if (frame) cancelAnimationFrame(frame);
            frame = requestAnimationFrame(compare);
        });
        baseline.addEventListener('change', compare);
        compare();
        stack.append(controls, editor, columns, summary, actions);
        output().result.replaceChildren(stack);
    }

    async function changeReply(target, text, expectedText, restoring = false) {
        if (pending || writingReply) return;
        const st = context();
        if (chatIsGenerating(st) || document.querySelector('#chat .edit_textarea')) {
            setStatus('请先结束聊天中的生成或编辑。');
            return;
        }
        const currentRevision = revision;
        writingReply = true;
        updateBusy();
        try {
            if (!restoring) checkPolishSource(target);
            await writePolishedReply(st, target, text, expectedText, context);
            if (!samePolishTarget(context(), target, text)) return;
            undoReply = restoring ? undefined : { target, applied: text };
            ui['polish-undo'].hidden = restoring;
            clearRequest(restoring ? '已恢复原回复。' : '已替换聊天回复，可点击「恢复原回复」撤销。');
        } catch (error) {
            if (currentRevision === revision) setStatus(error.message);
        } finally {
            writingReply = false;
            updateBusy();
        }
    }

    function logicTargetChanged(target) {
        const latest = latestModelReply(getChatMessages(context().chat));
        if (latest?.index === target.index && latest.text === target.text) return false;
        setStatus('最新回复已变化，请重新检查。');
        return true;
    }

    function reviewTargetChanged(target) {
        const latest = latestModelReply(getChatMessages(context().chat));
        if (latest?.index === target.index && latest.text === target.text) return false;
        setStatus('最新回复已变化，请重新分析。');
        return true;
    }

    function renderLogicFindings(findings, target) {
        if (!findings.length) {
            output().result.replaceChildren(element('p', '这次检查未发现可定位的逻辑问题。'));
            return;
        }
        const insert = selected => {
            if (logicTargetChanged(target)) return;
            const draft = appendLogicFindings(textarea.value, selected);
            if (draft === textarea.value) {
                setStatus('当前草稿已包含这些修正要求。');
                return;
            }
            replaceDraft(draft);
            setStatus('已加入输入框，可编辑或恢复原稿。');
        };
        const stack = element('div', null, 'st-input-config');
        for (const finding of findings) {
            const group = element('fieldset', null, 'st-input-question');
            group.append(element('legend', finding.category));
            for (const { role, id, quote } of finding.evidence) {
                const excerpt = element('blockquote', null, 'st-input-logic-evidence');
                excerpt.append(element('small', `${role} #${id}`), element('p', quote));
                group.append(excerpt);
            }
            group.append(
                element('p', finding.issue, 'st-input-logic-note'),
                element('p', finding.followup, 'st-input-logic-note'),
                button('加入草稿', () => insert([finding])),
            );
            stack.append(group);
        }
        if (findings.length > 1) stack.append(button('全部加入草稿', () => insert(findings)));
        output().result.replaceChildren(stack);
    }

    function renderDraft(value, source) {
        const label = element('label', '建议草稿');
        const edited = element('textarea', null, 'text_pole st-input-draft');
        edited.value = appendGuidance(value, source.guidance);
        edited.maxLength = MAX_DRAFT;
        edited.rows = 4;
        label.append(edited);
        const fill = button('填入输入框', () => {
            if (!edited.value.trim()) return;
            if (textarea.value !== expected) {
                expected = textarea.value;
                fill.textContent = '替换当前草稿';
                setStatus('输入框已有新编辑。再次点击即可替换。');
                return;
            }
            replaceDraft(edited.value);
            output().result.replaceChildren();
            setStatus('已填入输入框。');
        });
        let expected = source.draft;
        output().result.replaceChildren(label, fill);
    }

    function renderResult(result, source) {
        if (result.draft) {
            renderDraft(result.draft, source);
            return;
        }
        if (result.suggestions) {
            const list = element('div', null, 'st-input-suggestions');
            for (const suggestion of result.suggestions) {
                list.append(button(suggestion, () => renderDraft(suggestion, source)));
            }
            output().result.replaceChildren(list);
            return;
        }

        const fields = [];
        const stack = element('div', null, 'st-input-config');
        for (const question of result.questions) {
            const group = element('fieldset', null, 'st-input-question');
            const title = element('legend', question.text);
            const answer = element('input', null, 'text_pole');
            answer.type = 'text';
            answer.maxLength = 1000;
            answer.placeholder = '填写答案（可留空）';
            answer.setAttribute('aria-label', question.text);
            const choices = element('div', null, 'st-input-actions');
            for (const option of question.options) {
                choices.append(button(option, () => {
                    answer.value = option;
                    answer.focus();
                }));
            }
            group.append(title, choices, answer);
            stack.append(group);
            fields.push({ question: question.text, answer });
        }
        stack.append(button('按我的回答生成', () => {
            const answers = fields.map(({ question, answer }) => ({ question, answer: answer.value.trim() })).filter(pair => pair.answer);
            void run(source, answers, true);
        }));
        output().result.replaceChildren(stack);
    }

    function renderReview(review, target) {
        if (!review.length) {
            outputs.get(LOGIC_MODE).result.replaceChildren(element('p', '这次分析未发现明确影响阅读的问题。'));
            return;
        }
        const list = element('div', null, 'st-input-config');
        for (const item of review) {
            const group = element('fieldset', null, 'st-input-question');
            const quote = element('blockquote', item.evidence, 'st-input-logic-evidence');
            const save = button('保存指导', () => {
                if (reviewTargetChanged(target)) return;
                void updateGuidance(state => saveGuide(state, item), '已保存到当前聊天的写作指导。');
                ui.guidance.open = true;
            });
            save.dataset.guide = item.guidance;
            group.append(element('legend', item.category), quote, element('p', item.issue),
                element('p', item.guidance, 'st-input-guidance-text'), save);
            list.append(group);
        }
        outputs.get(LOGIC_MODE).result.replaceChildren(list);
        renderGuidance();
    }

    function renderGuidance() {
        const { enabled, items } = readGuidance(context().chatMetadata);
        ui.guidance.hidden = !items.length;
        ui['guidance-enabled'].checked = enabled;
        ui['guidance-enabled'].disabled = savingGuidance;
        ui['guidance-title'].textContent = `写作指导（${items.length}）`;
        const rows = items.map(item => {
            const row = element('div', null, 'st-input-guide');
            const remove = button('移除', () => {
                void updateGuidance(state => ({
                    ...state, items: state.items.filter(value => value.guidance !== item.guidance),
                }), '已移除这条指导。');
            });
            remove.disabled = savingGuidance;
            remove.setAttribute('aria-label', `移除指导：${item.guidance}`);
            row.append(element('p', item.guidance, 'st-input-guidance-text'), element('p', `${item.category} · ${item.issue}`), remove);
            return row;
        });
        ui['guidance-list'].replaceChildren(...rows);
        for (const save of outputs.get(LOGIC_MODE).result.querySelectorAll('[data-guide]')) {
            const saved = items.some(item => item.guidance === save.dataset.guide);
            save.disabled = saved || savingGuidance;
            save.textContent = saved ? '已保存' : '保存指导';
        }
    }

    async function updateGuidance(update, message = '') {
        if (savingGuidance) return;
        const st = context();
        const metadata = st.chatMetadata;
        if (!st.getCurrentChatId() || !metadata) {
            setStatus('请先打开一条聊天，再保存写作指导。');
            return;
        }
        const previous = metadata[GUIDANCE_KEY];
        try {
            const next = update(readGuidance(metadata));
            savingGuidance = true;
            metadata[GUIDANCE_KEY] = next;
            renderGuidance();
            await st.saveMetadata();
            if (context().chatMetadata === metadata && message) setStatus(message);
        } catch (error) {
            if (context().chatMetadata === metadata) {
                if (previous === undefined) delete metadata[GUIDANCE_KEY];
                else metadata[GUIDANCE_KEY] = previous;
                setStatus(error.message);
            }
        } finally {
            savingGuidance = false;
            renderGuidance();
        }
    }

    function insertGuidance(includeIssues) {
        const draft = appendGuidance(textarea.value, readGuidance(context().chatMetadata).items, includeIssues);
        if (draft === textarea.value) {
            setStatus('当前草稿已包含这些指导。');
            return;
        }
        replaceDraft(draft);
        setStatus('已加入输入框，可编辑或恢复原稿。');
    }

    function customForm() {
        const data = { baseUrl: ui.url.value.trim(), model: ui.model.value.trim() };
        if (ui['clear-key'].checked) data.key = '';
        else if (ui.key.value.trim()) data.key = ui.key.value.trim();
        return data;
    }

    function showSavedCustom(saved) {
        customConfig = saved;
        ui.url.value = saved.baseUrl;
        ui.model.value = saved.model;
        ui.key.value = '';
        ui.key.placeholder = saved.hasKey ? '已保存，留空继续使用' : '本地服务无需鉴权时可留空';
        ui['clear-key'].checked = false;
        ui['clear-key'].disabled = !saved.hasKey;
        ui['load-custom'].hidden = true;
        renderConnection();
    }

    async function check(action) {
        if (checking) return;
        checking = true;
        updateBusy();
        setConfigStatus('正在处理…');
        try {
            const message = await action();
            setConfigStatus(message);
        } catch (error) {
            setConfigStatus(error.message);
        } finally {
            checking = false;
            updateBusy();
        }
    }

    function loadCustom() {
        void check(async () => {
            showSavedCustom(await service('config'));
            return '';
        });
    }

    ui.close.addEventListener('click', () => setOpen(false));
    ui.layout.addEventListener('click', () => {
        config.fullscreen = !config.fullscreen;
        saveSettings();
        renderPanelLayout(true);
        ui.layout.focus({ preventScroll: true });
    });
    panel.addEventListener('cancel', event => {
        event.preventDefault();
        setOpen(false);
    });
    ui['with-example'].checked = config.polishUseExample ?? Boolean(config.polishExampleSelection);
    ui['without-example'].checked = !ui['with-example'].checked;
    for (const radio of [ui['with-example'], ui['without-example']]) {
        radio.addEventListener('change', () => {
            config.polishUseExample = ui['with-example'].checked;
            saveSettings();
            renderStyleMode();
        });
    }
    loadPolishExample(config.polishExampleSelection);
    ui['polish-diction'].addEventListener('click', () => {
        config.matchExampleDiction = !config.matchExampleDiction;
        saveSettings();
        renderStyleMode();
    });
    renderStyleMode();
    renderWorkspace();
    ui['polish-examples'].addEventListener('change', () => {
        const name = ui['polish-examples'].value;
        const active = config.polishExamples.find(example => example.name === config.polishExampleSelection);
        const dirty = ui['polish-example-name'].value !== (active?.name ?? '') || ui['polish-example'].value !== (active?.text ?? '');
        if (dirty && !globalThis.confirm('当前示范有未保存的修改，仍要切换吗？')) {
            ui['polish-examples'].value = config.polishExampleSelection;
            return;
        }
        loadPolishExample(name);
        saveSettings();
    });
    ui['polish-save-example'].addEventListener('click', savePolishExample);
    ui['polish-delete-example'].addEventListener('click', () => {
        config.polishExamples = config.polishExamples.filter(example => example.name !== config.polishExampleSelection);
        config.polishExampleSelection = '';
        renderPolishExampleOptions();
        saveSettings();
        setStatus('已删除保存的示范，正文保留在编辑框中。');
    });
    ui['polish-budget'].value = config.polishMaxTokens ?? '';
    ui['polish-stream'].checked = config.polishStreaming !== false;
    ui['polish-stream'].addEventListener('change', () => {
        config.polishStreaming = ui['polish-stream'].checked;
        saveSettings();
    });
    ui['polish-budget'].addEventListener('change', () => {
        const field = ui['polish-budget'];
        if (!field.validity.valid) return;
        config.polishMaxTokens = field.value ? field.valueAsNumber : null;
        saveSettings();
    });
    ui['polish-parameters'].value = config.polishParameters ?? '';
    ui['polish-parameters'].addEventListener('change', () => {
        config.polishParameters = ui['polish-parameters'].value;
        saveSettings();
    });
    ui['polish-example'].addEventListener('input', () => {
        updateExampleLength();
        refreshPolishExamplePreview();
    });
    ui['polish-notes'].addEventListener('input', refreshPolishExamplePreview);
    ui['polish-rewrite'].checked = config.polishRewrite === true;
    ui['polish-light'].checked = !ui['polish-rewrite'].checked;
    for (const radio of [ui['polish-light'], ui['polish-rewrite']]) radio.addEventListener('change', () => {
        const rewrite = ui['polish-rewrite'].checked;
        config.polishRewrite = rewrite;
        saveSettings();
        ui['polish-generate'].textContent = rewrite ? '开始大修' : '开始精修';
        refreshPolishExamplePreview();
    });
    if (ui['polish-rewrite'].checked) ui['polish-generate'].textContent = '开始大修';
    ui['polish-generate'].addEventListener('click', startPolish);
    ui['polish-undo'].addEventListener('click', () => {
        if (undoReply) void changeReply(undoReply.target, undoReply.target.rawText, undoReply.applied, true);
    });
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            setOpen(false);
        }
    });
    ui.history.checked = config.history;
    ui['history-count'].value = config.historyCount;
    ui.history.addEventListener('change', () => {
        config.history = ui.history.checked;
        saveSettings();
        refreshReferences();
        clearRequest();
    });
    ui['history-count'].addEventListener('change', () => {
        const count = Number(ui['history-count'].value);
        config.historyCount = Math.min(40, Math.max(1, Math.round(count || 8)));
        ui['history-count'].value = config.historyCount;
        saveSettings();
        clearRequest();
    });
    ui.reference.addEventListener('change', () => clearRequest());
    ui.preview.addEventListener('toggle', refreshPreview);
    ui['preview-mode'].addEventListener('change', refreshPreview);
    textarea.addEventListener('input', () => {
        if (!panel.hidden && !pending && !output().result.childElementCount) refreshPreview();
    });

    ui['guidance-enabled'].addEventListener('change', () => {
        void updateGuidance(state => ({ ...state, enabled: ui['guidance-enabled'].checked }));
    });
    ui['insert-guides'].addEventListener('click', () => insertGuidance(false));
    ui['insert-issues'].addEventListener('click', () => insertGuidance(true));

    ui.connection.value = config.connection;
    ui.connection.addEventListener('change', () => {
        config.connection = ui.connection.value;
        saveSettings();
        refreshProfiles();
        renderConnection();
        clearRequest();
        setConfigStatus('');
        if (config.connection === 'custom' && !customConfig) loadCustom();
    });
    ui.profiles.addEventListener('change', () => {
        config.profileId = ui.profiles.value;
        saveSettings();
        renderConnection();
        clearRequest();
    });
    ui.settings.addEventListener('toggle', () => {
        if (!ui.settings.open) return;
        refreshProfiles();
        if (config.connection === 'custom' && !customConfig) loadCustom();
    });
    ui['load-custom'].hidden = false;
    ui['load-custom'].addEventListener('click', loadCustom);
    ui['load-models'].addEventListener('click', () => void check(async () => {
        const { models } = await service('models', { method: 'POST', data: customForm() });
        ui['model-list'].replaceChildren(...models.map(model => new Option(model, model)));
        if (models.length === 1 && !ui.model.value) ui.model.value = models[0];
        return models.length ? `已获取 ${models.length} 个模型，可在模型 ID 输入框选择。` : 'API 没有返回模型列表，可以手动填入模型 ID。';
    }));
    ui['save-custom'].addEventListener('click', () => void check(async () => {
        showSavedCustom(await service('config', { method: 'PUT', data: customForm() }));
        clearRequest();
        return '已保存自定义 API。';
    }));
    ui.test.addEventListener('click', () => void check(async () => {
        if (config.connection === 'custom') {
            const { model, elapsed } = await service('test', { method: 'POST', data: customForm() });
            return `已收到 ${model} 的文本回复 · ${elapsed} ms`;
        }
        const startTime = performance.now();
        const reply = await complete([{ role: 'user', content: 'Reply with OK.' }], config.connection, config.profileId, undefined, 48);
        if (!reply?.trim()) throw new Error('API 已响应，但模型没有返回文本。');
        return `已收到模型回复 · ${Math.round(performance.now() - startTime)} ms`;
    }));

    const st = context();
    st.eventSource.on(st.eventTypes.CHAT_CHANGED, () => {
        undoDraft = undefined;
        undoReply = undefined;
        undo.hidden = true;
        ui['polish-undo'].hidden = true;
        ui['polish-notes'].value = '';
        ui.guidance.open = false;
        renderGuidance();
        ui.reference.value = '';
        if (!panel.hidden) refreshReferences();
        clearRequest();
    });
    const refreshChat = () => {
        if (!panel.hidden) refreshReferences();
    };
    st.eventSource.on(st.eventTypes.MESSAGE_RECEIVED, refreshChat);
    st.eventSource.on(st.eventTypes.MESSAGE_SENT, refreshChat);
    renderConnection();
    updateBusy();
}

globalThis.SillyTavern.getContext().eventSource.on(context().eventTypes.APP_READY, mount);
