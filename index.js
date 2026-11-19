import { buildPrompt, getChatMessages, MAX_DRAFT, MODES, parseResult } from './prompts.js';

const KEY = 'st-input';
const SERVICE = '/api/plugins/st-input';
const DEFAULTS = { connection: 'current', profileId: '', history: true, historyCount: 8 };
const context = () => SillyTavern.getContext();
const settings = () => context().extensionSettings[KEY] ??= { ...DEFAULTS };

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

async function complete(messages, connection, profileId, signal, maxTokens = 1600) {
    if (connection === 'custom') {
        return (await service('generate', { method: 'POST', data: { messages }, signal })).text;
    }
    const st = context();
    if (connection === 'profile' && (!st.ConnectionManagerRequestService || !profileId)) {
        throw new Error('请先选择一条 SillyTavern 连接配置。');
    }
    try {
        if (connection === 'profile') {
            const result = await st.ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, {
                stream: false, extractData: true, includePreset: false, signal,
            });
            return result.content;
        }
        return await st.generateRaw({ prompt: messages, trimNames: false });
    } catch (error) {
        if (signal?.aborted) throw error;
        if (connection === 'profile') {
            throw new Error('指定连接调用失败。请在 SillyTavern 中核对该连接的模型、地址和 Key。');
        }
        throw new Error('当前聊天连接调用失败。请在 SillyTavern 的 API 连接中检查设置。');
    }
}

function mount() {
    const form = document.getElementById('send_form');
    const textarea = document.getElementById('send_textarea');
    const anchor = document.getElementById('rightSendForm');
    if (!form || !textarea || !anchor || document.getElementById('st-input-launch')) return;
    const config = { ...DEFAULTS, ...settings() };

    const panel = element('section');
    panel.id = 'st-input-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', '输入助手');
    panel.innerHTML = `
        <div class="st-input-bar">
            <strong>输入助手</strong>
            <span data-st="connection-label"></span>
            <button class="menu_button" type="button" data-st="close" aria-label="关闭输入助手">关闭</button>
        </div>
        <div class="st-input-actions" data-st="actions"></div>
        <div class="st-input-options">
            <label><input type="checkbox" data-st="history"> 使用聊天上下文</label>
            <label>最近消息数 <input type="number" class="text_pole" min="1" max="40" step="1" data-st="history-count"></label>
            <label class="st-input-reference">参考旧消息 <select class="text_pole" data-st="reference"></select></label>
        </div>
        <details data-st="preview">
            <summary>提示词预览</summary>
            <label>预览操作 <select class="text_pole" data-st="preview-mode"></select></label>
            <div class="st-input-preview" data-st="preview-content"></div>
        </details>
        <div role="status" aria-live="polite" class="st-input-status" data-st="status"></div>
        <div data-st="result"></div>
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
        </details>`;

    const ui = Object.fromEntries([...panel.querySelectorAll('[data-st]')].map(node => [node.dataset.st, node]));
    const launch = button('输入助手', () => setOpen(panel.hidden));
    launch.id = 'st-input-launch';
    launch.setAttribute('aria-controls', panel.id);
    launch.setAttribute('aria-expanded', 'false');
    anchor.before(launch);
    form.prepend(panel);

    let pending;
    let checking = false;
    let revision = 0;
    let undoDraft;
    let customConfig;
    let lastPrompt;

    const setStatus = message => { ui.status.textContent = message; };
    const setConfigStatus = message => { ui['config-status'].textContent = message; };
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

    for (const [mode, label] of Object.entries(MODES)) {
        const action = button(label, () => start(mode));
        action.dataset.mode = mode;
        ui.actions.append(action);
        ui['preview-mode'].append(new Option(label, mode));
    }
    const cancel = button('取消', () => clearRequest('已取消。'));
    cancel.hidden = true;
    ui.actions.append(cancel, undo);

    function writeDraft(value) {
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
    }

    function setOpen(open) {
        panel.hidden = !open;
        launch.setAttribute('aria-expanded', String(open));
        if (open) {
            refreshReferences();
            refreshProfiles();
            renderConnection();
            if (config.connection === 'custom' && !customConfig) loadCustom();
            ui.actions.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
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
        ui['connection-label'].textContent = {
            current: mainModel ? `当前连接 · ${mainModel}` : '当前聊天连接',
            profile: profile ? [profile.name, profile.model].filter(Boolean).join(' · ') : '选择连接配置',
            custom: customConfig?.model || '自定义 API',
        }[config.connection];
    }

    function updateBusy() {
        for (const action of ui.actions.querySelectorAll('[data-mode]')) action.disabled = Boolean(pending);
        cancel.hidden = !pending;
        for (const key of ['load-custom', 'load-models', 'save-custom', 'test']) ui[key].disabled = checking;
        for (const key of ['url', 'model', 'key', 'connection', 'profiles']) ui[key].disabled = checking;
        ui['clear-key'].disabled = checking || !customConfig?.hasKey;
    }

    function clearRequest(message = '') {
        revision += 1;
        pending?.controller.abort();
        ui.result.replaceChildren();
        lastPrompt = undefined;
        refreshPreview();
        setStatus(message);
    }

    function getSource(mode) {
        const history = config.history ? getChatMessages(context().chat) : [];
        const pinned = ui.reference.value ? Number(ui.reference.value) : undefined;
        return { mode, draft: textarea.value, history, historyCount: config.historyCount, pinned };
    }

    function showPrompt(prompt) {
        ui['preview-content'].textContent = prompt.map(message => `[${message.role}]\n${message.content}`).join('\n\n');
    }

    function refreshPreview() {
        if (!ui.preview.open) return;
        try {
            const mode = ui['preview-mode'].value;
            const prompt = lastPrompt?.mode === mode && lastPrompt.draft === textarea.value
                ? lastPrompt.messages : buildPrompt(getSource(mode));
            showPrompt(prompt);
        } catch (error) {
            ui['preview-content'].textContent = error.message;
        }
    }

    function start(mode) {
        ui['preview-mode'].value = mode;
        void run(getSource(mode));
    }

    async function run(source, answers = [], final = false) {
        if (pending) return;
        const currentRevision = ++revision;
        const chatId = context().getCurrentChatId();
        ui.result.replaceChildren();
        lastPrompt = undefined;
        setStatus('');
        try {
            const prompt = buildPrompt({ ...source, answers, final });
            lastPrompt = { mode: source.mode, draft: source.draft, messages: prompt };
            showPrompt(prompt);
            pending = { controller: new AbortController() };
            updateBusy();
            setStatus('正在处理…');
            const result = await complete(prompt, config.connection, config.profileId, pending.controller.signal);
            if (currentRevision !== revision || chatId !== context().getCurrentChatId()) return;
            setStatus(textarea.value === source.draft ? '' : '输入框已有新编辑。建议保留在面板中供你预览。');
            renderResult(parseResult(result, source.mode, final), source);
        } catch (error) {
            if (currentRevision === revision) setStatus(error.message);
        } finally {
            pending = undefined;
            updateBusy();
        }
    }

    function renderDraft(value, source) {
        const label = element('label', '建议草稿');
        const edited = element('textarea', null, 'text_pole st-input-draft');
        edited.value = value;
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
            undoDraft = { previous: textarea.value, inserted: edited.value };
            writeDraft(edited.value);
            undo.hidden = false;
            ui.result.replaceChildren();
            setStatus('已填入输入框。');
        });
        let expected = source.draft;
        ui.result.replaceChildren(label, fill);
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
            ui.result.replaceChildren(list);
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
        ui.result.replaceChildren(stack);
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
        if (!panel.hidden && !pending && !ui.result.childElementCount) refreshPreview();
    });

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
        undo.hidden = true;
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
}

globalThis.SillyTavern.getContext().eventSource.on(context().eventTypes.APP_READY, mount);
