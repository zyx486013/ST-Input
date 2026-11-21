const CUSTOM_REQUEST_FIELDS = ['custom_include_headers', 'custom_include_body', 'custom_exclude_body'];

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

function customRequestParameters(st, profile) {
    const baseUrl = apiRoot(profile['api-url']);
    if (!baseUrl || !profile.model?.trim()) {
        throw new Error('这条 SillyTavern 连接未保存 API 地址或模型。请在 ST 里选中它，填好后点「更新」，再试一次。');
    }

    const preset = profile.preset
        ? st.getPresetManager?.('openai')?.getCompletionPresetByName(profile.preset)
        : null;
    const active = st.chatCompletionSettings;
    const options = [preset, active].find(settings => apiRoot(settings?.custom_url) === baseUrl);

    // SillyTavern can inherit Custom parameters from the active settings while using
    // a different profile URL. Pass only options belonging to the selected endpoint.
    return Object.fromEntries(CUSTOM_REQUEST_FIELDS.map(field => {
        const value = typeof options?.[field] === 'string' ? options[field] : '';
        return [field, value ? (st.substituteParams?.(value) ?? value) : ''];
    }));
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

export async function completeWithSillyTavern(st, messages, connection, profileId, signal, maxTokens, { withDetails = false } = {}) {
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
        if (api?.source === 'custom') overrides = customRequestParameters(st, profile);
    }

    try {
        if (useProfile) {
            const result = await service.sendRequest(profileId, messages, maxTokens, {
                stream: false, extractData: !withDetails, includePreset: true, signal,
            }, overrides);
            return withDetails ? completionDetails(st, result, selectedApi) : result.content;
        }
        if (withDetails) {
            const request = { prompt: messages, api: st.mainApi };
            const limit = Number(st.chatCompletionSettings?.openai_max_tokens);
            if (st.mainApi === 'openai' && maxTokens > limit) request.responseLength = maxTokens;
            return completionDetails(st, await st.generateRawData(request), st.mainApi);
        }
        return await st.generateRaw({ prompt: messages, trimNames: false });
    } catch (error) {
        if (signal?.aborted) throw error;
        const label = useProfile ? '指定连接调用失败' : '当前聊天连接调用失败';
        throw new Error(`${label}。${explainFailure(error)}`, { cause: error });
    }
}
