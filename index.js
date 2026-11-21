import { completeWithSillyTavern } from './connections.js';
import { appendLogicFindings, latestModelReply, LOGIC_LABEL, LOGIC_MODE, parseLogicFindings, prepareLogicCheck } from './logic-check.js';
import { buildPrompt, getChatMessages, MAX_DRAFT, MODES, parseResult } from './prompts.js';
import { MAX_EXAMPLE, MAX_POLISHED_REPLY, MAX_POLISH_NOTES, parsePolishedReply, POLISH_LABEL, POLISH_MODE, prepareReplyPolish, samePolishTarget, writePolishedReply } from './reply-polish.js';

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

async function complete(messages, connection, profileId, signal, maxTokens = 1600, options) {
    if (connection === 'custom') {
        const data = options?.withDetails ? { messages, withDetails: true } : { messages };
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
        <div id="st-input-polish" class="st-input-config" data-st="polish" hidden>
            <label>文风示范 <textarea class="text_pole st-input-draft" rows="3" maxlength="${MAX_EXAMPLE}" data-st="polish-example" placeholder="粘贴一段你认可的对白或叙述"></textarea></label>
            <label>本次精修要求 <textarea class="text_pole st-input-draft" rows="2" maxlength="${MAX_POLISH_NOTES}" data-st="polish-notes" placeholder="可留空，例如缩短对白，用动作表现犹豫"></textarea></label>
            <div class="st-input-actions">
                <button class="menu_button" type="button" data-st="polish-generate">按示范精修</button>
                <button class="menu_button" type="button" data-st="polish-baseline">无示范精修</button>
                <button class="menu_button" type="button" data-st="polish-undo" hidden>恢复原回复</button>
            </div>
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
    let undoReply;
    let comparison;
    let writingReply = false;
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

    for (const [mode, label] of Object.entries({ ...MODES, [LOGIC_MODE]: LOGIC_LABEL, [POLISH_MODE]: POLISH_LABEL })) {
        const action = button(label, () => mode === POLISH_MODE ? openPolish() : start(mode));
        action.dataset.mode = mode;
        if (mode === POLISH_MODE) {
            action.setAttribute('aria-expanded', 'false');
            action.setAttribute('aria-controls', 'st-input-polish');
        }
        ui.actions.append(action);
        ui['preview-mode'].append(new Option(label, mode));
    }
    const cancel = button('取消', () => clearRequest('已取消。', pending?.mode === POLISH_MODE));
    cancel.hidden = true;
    ui.actions.append(cancel, undo);

    function writeDraft(value) {
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
    }

    function replaceDraft(value) {
        undoDraft = { previous: textarea.value, inserted: value };
        writeDraft(value);
        undo.hidden = false;
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
        const busy = Boolean(pending) || writingReply;
        for (const action of ui.actions.querySelectorAll('[data-mode]')) action.disabled = busy;
        ui['polish-generate'].disabled = busy || !ui['polish-example'].value.trim();
        ui['polish-baseline'].disabled = busy;
        ui['polish-undo'].disabled = busy;
        const apply = ui.result.querySelector('[data-polish-apply]');
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
            comparison = undefined;
            ui.result.replaceChildren();
        }
        lastPrompt = undefined;
        refreshPreview();
        setStatus(message);
    }

    function getSource(mode) {
        const history = config.history || mode === LOGIC_MODE || mode === POLISH_MODE ? getChatMessages(context().chat) : [];
        const pinned = config.history && ui.reference.value ? Number(ui.reference.value) : undefined;
        const source = { mode, draft: textarea.value, history, historyCount: config.history ? config.historyCount : 0, pinned };
        if (mode === POLISH_MODE) {
            source.polishExample = ui['polish-example'].value.trim();
            source.polishNotes = ui['polish-notes'].value.trim();
        }
        return source;
    }

    function buildRequest(source, answers, final) {
        if (source.mode === LOGIC_MODE) return prepareLogicCheck(source);
        if (source.mode === POLISH_MODE) return prepareReplyPolish(source);
        return { prompt: buildPrompt({ ...source, answers, final }) };
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
        showPolishForm(false);
        comparison = undefined;
        ui['preview-mode'].value = mode;
        void run(getSource(mode));
    }

    function showPolishForm(open) {
        ui.polish.hidden = !open;
        panel.classList.toggle('st-input-polish-open', open);
        ui.actions.querySelector('[data-mode="polish"]').setAttribute('aria-expanded', String(open));
    }

    function openPolish() {
        if (!ui.polish.hidden) {
            showPolishForm(false);
            clearRequest();
            return;
        }
        showPolishForm(true);
        ui['preview-mode'].value = POLISH_MODE;
        clearRequest();
        ui['polish-example'].focus({ preventScroll: true });
    }

    function startPolish(withExample) {
        const source = getSource(POLISH_MODE);
        if (!withExample) source.polishExample = '';
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
        if (!polish) ui.result.replaceChildren();
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
            const maxTokens = polish ? Math.min(8192, Math.max(2400, target.text.length + 800)) : target ? 2400 : undefined;
            const result = await complete(prompt, config.connection, config.profileId, pending.controller.signal, maxTokens, { withDetails: polish });
            if (currentRevision !== revision || chatId !== context().getCurrentChatId()) return;
            if (polish) {
                if (!samePolishTarget(context(), snapshot)) throw new Error('模型回复或版本已变化，请重新精修。');
                showPolishedVersion(snapshot, Boolean(source.polishExample), source.polishNotes, parsePolishedReply(result.text, result.finishReason));
                return;
            }
            if (target) {
                setStatus('');
                if (logicTargetChanged(target)) return;
                renderLogicFindings(parseLogicFindings(result, request), target);
                return;
            }
            setStatus(textarea.value === source.draft ? '' : '输入框已有新编辑。建议保留在面板中供你预览。');
            renderResult(parseResult(result, source.mode, final), source);
        } catch (error) {
            if (currentRevision === revision) setStatus(error.message);
        } finally {
            pending = undefined;
            updateBusy();
        }
    }

    function showPolishedVersion(target, withExample, notes, text) {
        if (comparison?.target.message !== target.message || comparison.target.text !== target.text
            || comparison.target.swipeId !== target.swipeId || comparison.notes !== notes) {
            comparison = { target, notes, versions: new Map() };
        }
        comparison.versions.set(withExample, text);
        renderPolishComparison(comparison, withExample);
        setStatus('精修稿已生成。');
    }

    function renderPolishComparison(result, withExample) {
        const { target, versions } = result;
        const stack = element('div', null, 'st-input-config');
        const controls = element('div', null, 'st-input-actions');
        const version = element('select', null, 'text_pole');
        version.setAttribute('aria-label', '对比稿件');
        for (const [key, name] of [[true, '有示范稿'], [false, '无示范稿']]) {
            if (versions.has(key)) version.append(new Option(name, String(key)));
        }
        version.value = String(withExample);
        version.addEventListener('change', () => renderPolishComparison(result, version.value === 'true'));
        const baseline = element('select', null, 'text_pole');
        baseline.setAttribute('aria-label', '对照文本');
        baseline.append(new Option('对照原回复', 'original'));
        if (versions.has(!withExample)) {
            baseline.append(new Option(withExample ? '对照无示范稿' : '对照有示范稿', 'other'));
        } else baseline.hidden = true;

        const editor = element('textarea', null, 'text_pole st-input-draft');
        editor.setAttribute('aria-label', '编辑精修稿');
        editor.rows = 6;
        editor.maxLength = MAX_POLISHED_REPLY;
        editor.value = versions.get(withExample);
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
        revisedColumn.append(element('strong', '精修稿 · 下划线为新增'), revised);
        columns.append(originalColumn, revisedColumn);

        const actions = element('div', null, 'st-input-actions');
        const apply = button('替换聊天回复', () => void changeReply(target, versions.get(withExample), target.text));
        const copy = button('复制精修稿', async () => {
            try {
                await navigator.clipboard.writeText(versions.get(withExample));
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
            const text = versions.get(withExample);
            const otherVersion = baseline.value === 'other';
            const before = otherVersion ? versions.get(!withExample) : target.text;
            const beforeName = otherVersion ? (withExample ? '无示范稿' : '有示范稿') : '原回复';
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
            summary.textContent = text === before ? '两份文字相同。' : `${beforeName} ${[...before].length} 字 · 精修稿 ${[...text].length} 字`;
        }

        let frame;
        editor.addEventListener('input', () => {
            versions.set(withExample, editor.value);
            if (frame) cancelAnimationFrame(frame);
            frame = requestAnimationFrame(compare);
        });
        baseline.addEventListener('change', compare);
        compare();
        stack.append(controls, editor, columns, summary, actions);
        ui.result.replaceChildren(stack);
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

    function renderLogicFindings(findings, target) {
        if (!findings.length) {
            ui.result.replaceChildren(element('p', '这次检查未发现可定位的逻辑问题。'));
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
        ui.result.replaceChildren(stack);
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
            replaceDraft(edited.value);
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
    ui['polish-example'].value = typeof config.polishExample === 'string' ? config.polishExample.slice(0, MAX_EXAMPLE) : '';
    ui['polish-example'].addEventListener('change', () => {
        config.polishExample = ui['polish-example'].value;
        saveSettings();
    });
    for (const input of [ui['polish-example'], ui['polish-notes']]) {
        input.addEventListener('input', () => {
            if (lastPrompt?.mode === POLISH_MODE) lastPrompt = undefined;
            updateBusy();
            if (ui['preview-mode'].value === POLISH_MODE) refreshPreview();
        });
    }
    ui['polish-generate'].addEventListener('click', () => startPolish(true));
    ui['polish-baseline'].addEventListener('click', () => startPolish(false));
    ui['polish-undo'].addEventListener('click', () => {
        if (undoReply) void changeReply(undoReply.target, undoReply.target.text, undoReply.applied, true);
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
        undoReply = undefined;
        undo.hidden = true;
        ui['polish-undo'].hidden = true;
        ui['polish-notes'].value = '';
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
