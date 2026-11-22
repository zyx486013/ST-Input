const CUSTOM_REQUEST_FIELDS = ['custom_include_headers', 'custom_include_body', 'custom_exclude_body'];
const NATIVE_POLISH_FIELDS = new Set([
    'reasoning_effort', 'include_reasoning', 'verbosity', 'temperature', 'top_p', 'top_k',
    'frequency_penalty', 'presence_penalty', 'seed', 'stop',
]);

function apiRoot(value) {
    if (!value) return null;
    try {
        const url = new URL(value);
        url.pathname = url.pathname.replace(/\/+$/, '') || '/';
        return url.href;
    } catch {
        return null;
    }
}

function customRequestParameters(st, profile, preset) {
    const baseUrl = apiRoot(profile['api-url']);
    if (!baseUrl || !profile.model?.trim()) {
        throw new Error('这条 SillyTavern 连接未保存 API 地址或模型。请在 ST 里选中它，填好后点「更新」，再试一次。');
    }

    const active = st.chatCompletionSettings;
    const options = [preset, active].find(settings => apiRoot(settings?.custom_url) === baseUrl);

    // SillyTavern can inherit Custom parameters from the active settings while using
    // a different profile URL. Pass only options belonging to the selected endpoint.
    return Object.fromEntries(CUSTOM_REQUEST_FIELDS.map(field => {
        const value = typeof options?.[field] === 'string' ? options[field] : '';
        return [field, value ? (st.substituteParams?.(value) ?? value) : ''];
    }));
}

function preparePolishRequest(preset, overrides, suggested, requested, parameters, yaml, minimum) {
    const configured = Number(preset?.openai_max_tokens ?? preset?.genamt);
    let maxTokens = requested ?? Math.max(suggested, minimum, Number.isSafeInteger(configured) ? configured : 0);
    if (!overrides || !yaml) return maxTokens;

    let body;
    try {
        body = yaml.parse(overrides.custom_include_body || '');
    } catch {
        // SillyTavern handles invalid custom YAML in the saved connection.
        if (!Object.keys(parameters).length) return maxTokens;
    }
    if (Array.isArray(body)) {
        // SillyTavern merges YAML list entries in order, with later values taking precedence.
        body = Object.fromEntries(body.filter(item => item && typeof item === 'object' && !Array.isArray(item)).flatMap(Object.entries));
    }
    const tokenFields = ['max_tokens', 'max_completion_tokens'].filter(key => {
        const value = Number(body?.[key]);
        return Number.isSafeInteger(value) && value > 0;
    });
    if (tokenFields.length || Object.keys(parameters).length) {
        if (requested === undefined) maxTokens = Math.max(maxTokens, ...tokenFields.map(key => Number(body[key])));
        const limits = Object.fromEntries(tokenFields.map(key => [key, maxTokens]));
        overrides.custom_include_body = yaml.stringify({ ...(body && typeof body === 'object' ? body : {}), ...parameters, ...limits });
    }
    if (overrides.custom_exclude_body && Object.keys(parameters).length) {
        try {
            const excluded = yaml.parse(overrides.custom_exclude_body);
            const keys = Array.isArray(excluded) ? excluded : typeof excluded === 'string' ? [excluded] : Object.keys(excluded ?? {});
            const remaining = keys.filter(key => !Object.hasOwn(parameters, key));
            if (remaining.length !== keys.length) overrides.custom_exclude_body = yaml.stringify(remaining);
        } catch {
            // SillyTavern ignores invalid exclusion YAML.
        }
    }
    return maxTokens;
}

function checkPolishParameters(api, source, parameters) {
    const keys = Object.keys(parameters);
    if (keys.length && api !== 'openai') throw new Error('精修附加参数适用于 Chat Completion 连接。');
    if (source !== 'custom' && keys.some(key => !NATIVE_POLISH_FIELDS.has(key))) {
        throw new Error('此连接可设置推理强度和常见生成参数。其他 API 参数请使用自定义 Chat Completion 连接。');
    }
}

async function completeCurrentPolish(st, messages, maxTokens, requested, parameters, yaml) {
    const api = st.mainApi;
    const prompt = messages.map(message => ({ ...message }));
    if (api !== 'openai') {
        const data = await st.generateRawData({ prompt, api, responseLength: requested });
        return { ...completionDetails(st, data, api), outputTokens: requested };
    }

    const event = st.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
    let outputTokens;
    const configure = data => {
        // ST keeps the text message objects when it constructs its request.
        if (!data.messages?.some(message => prompt.includes(message))) return;
        const custom = data.chat_completion_source === 'custom';
        outputTokens = preparePolishRequest(st.chatCompletionSettings, custom ? data : undefined, maxTokens, requested, parameters, yaml, 0);
        if (Object.hasOwn(data, 'max_completion_tokens')) data.max_completion_tokens = outputTokens;
        if (Object.hasOwn(data, 'max_tokens') || !Object.hasOwn(data, 'max_completion_tokens')) data.max_tokens = outputTokens;
        if (!custom) Object.assign(data, parameters);
    };
    st.eventSource.on(event, configure);
    try {
        const data = await st.generateRawData({ prompt, api });
        return { ...completionDetails(st, data, api), outputTokens };
    } finally {
        st.eventSource.removeListener(event, configure);
    }
}

const KNOWN_FAILURES = [
    [/profile not found|could not find profile/i, '这条连接配置已删除或不可用，请重新选择。'],
    [/connection manager is not available/i, 'SillyTavern 的连接配置管理已关闭，请在「管理扩展」里启用它。'],
    [/\b(?:401|403)\b|unauth(?:orized|enticated)|authentication|api key|forbidden|invalid token/i, 'API 鉴权失败。请先在 ST 的 API 连接页选中这条配置，确认 Key 后点「更新」保存。'],
    [/\b429\b|too many requests|rate limit|quota/i, 'API 触发限流或额度不足。'],
    [/\b404\b|not found|model_not_found/i, 'API 地址或模型不存在，请检查这条已保存连接的地址和模型 ID。'],
    [/\b(?:408|504)\b|timed?\s*out|ETIMEDOUT/i, '连接 API 超时。'],
    [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network error|failed to fetch/i, '无法连接到 API 服务，请检查服务状态和地址。'],
    [/\b(?:400|422)\b|bad request|unprocessable|unsupported parameter|invalid request/i, 'API 拒绝了本次请求的参数。具体参数错误可在 SillyTavern 启动窗口查看。'],
    [/\b(?:500|502|503)\b|internal server error|bad gateway|service unavailable/i, 'API 服务暂时异常。'],
];

function explainFailure(error) {
    let cause = error;
    let explanation;
    for (let depth = 0; cause && depth < 5; depth++, cause = cause.cause) {
        const message = typeof cause === 'string' ? cause : cause.message;
        const match = KNOWN_FAILURES.find(([pattern]) => pattern.test(message ?? ''));
        if (match) explanation = match[1];
    }
    return explanation ?? '请查看 SillyTavern 启动窗口中这次请求的错误详情。';
}

function completionDetails(st, data, api) {
    const choice = data?.choices?.[0];
    return {
        text: st.extractMessageFromData(data, api),
        finishReason: choice?.finish_reason ?? data?.stop_reason ?? data?.stop_type,
    };
}

export async function completeWithSillyTavern(st, messages, connection, profileId, signal, maxTokens, { withDetails = false, requestedPolishTokens, parameters = {}, yaml } = {}) {
    const useProfile = connection === 'profile';
    const service = st.ConnectionManagerRequestService;
    if (useProfile && (!service || !profileId)) {
        throw new Error('请先选择一条 SillyTavern 连接配置。');
    }

    let overrides;
    let selectedApi;
    if (useProfile) {
        let profile;
        try {
            profile = service.getProfile(profileId);
        } catch (error) {
            throw new Error(explainFailure(error), { cause: error });
        }
        const api = st.CONNECT_API_MAP?.[profile.api];
        selectedApi = api?.selected;
        const preset = profile.preset && (withDetails || api?.source === 'custom')
            ? st.getPresetManager?.(selectedApi ?? 'openai')?.getCompletionPresetByName(profile.preset)
            : undefined;
        if (api?.source === 'custom') overrides = customRequestParameters(st, profile, preset);
        if (withDetails) {
            checkPolishParameters(selectedApi, api?.source, parameters);
            maxTokens = preparePolishRequest(preset, overrides, maxTokens, requestedPolishTokens, parameters, yaml, 4096);
            if (api?.source !== 'custom' && Object.keys(parameters).length) overrides = { ...parameters };
            // Match ST's native Chat Completion limit field for the OpenAI models it converts.
            const model = profile.model ?? '';
            const source = api?.source;
            if ((['openai', 'azure_openai', 'openrouter'].includes(source) && /gpt-(?:5|6-astra)/.test(model))
                || (['openai', 'azure_openai'].includes(source) && /^o[134]/.test(model))
                || (source === 'openrouter' && /^openai\/o[134]/.test(model))) {
                overrides = { ...overrides, max_tokens: undefined, max_completion_tokens: maxTokens };
            }
        }
    } else if (withDetails) {
        checkPolishParameters(st.mainApi, st.chatCompletionSettings?.chat_completion_source, parameters);
    }

    try {
        if (useProfile) {
            const result = await service.sendRequest(profileId, messages, maxTokens, {
                stream: false, extractData: !withDetails, includePreset: true, signal,
            }, overrides);
            return withDetails ? { ...completionDetails(st, result, selectedApi), outputTokens: maxTokens } : result.content;
        }
        if (withDetails) {
            return await completeCurrentPolish(st, messages, maxTokens, requestedPolishTokens, parameters, yaml);
        }
        return await st.generateRaw({ prompt: messages, trimNames: false });
    } catch (error) {
        if (signal?.aborted) throw error;
        const label = useProfile ? '指定连接调用失败' : '当前聊天连接调用失败';
        throw new Error(`${label}。${explainFailure(error)}`, { cause: error });
    }
}
