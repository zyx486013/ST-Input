import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeWithSillyTavern } from '../connections.js';

const prompt = [
    { role: 'system', content: '整理草稿' },
    { role: 'user', content: '草稿内容' },
];

function setup({ preset, active, failure, url = 'https://assistant.example.com/v1' } = {}) {
    const profile = {
        id: 'assistant', api: 'custom', model: 'fixture-model', preset: '助手预设', 'api-url': url,
    };
    const sent = [];
    const st = {
        CONNECT_API_MAP: { custom: { selected: 'openai', source: 'custom' } },
        chatCompletionSettings: active,
        getPresetManager: () => ({ getCompletionPresetByName: () => preset }),
        substituteParams: value => value.replace('{{user}}', '我'),
        ConnectionManagerRequestService: {
            getProfile(id) {
                if (id !== profile.id) throw new Error('Profile not found');
                return profile;
            },
            async sendRequest(...args) {
                sent.push(args);
                if (failure) throw failure;
                return { content: '整理结果' };
            },
        },
    };
    return { st, sent };
}

test('passes the saved preset and scoped custom fields to the profile request', async () => {
    const { st, sent } = setup({
        preset: {
            custom_url: 'https://assistant.example.com/v1/',
            custom_include_headers: 'X-App: {{user}}',
            custom_include_body: 'max_completion_tokens: 100',
            custom_exclude_body: '- max_tokens',
        },
        active: {
            custom_url: 'https://main.example.com/v1',
            custom_include_headers: 'X-Other: private',
        },
    });
    const signal = new AbortController().signal;
    assert.equal(await completeWithSillyTavern(st, prompt, 'profile', 'assistant', signal, 1600), '整理结果');
    assert.deepEqual(sent[0], ['assistant', prompt, 1600, {
        stream: false, extractData: true, includePreset: true, signal,
    }, {
        custom_include_headers: 'X-App: 我',
        custom_include_body: 'max_completion_tokens: 100',
        custom_exclude_body: '- max_tokens',
    }]);
});

test('falls back to the Custom settings only when their endpoint matches', async () => {
    const { st, sent } = setup({ active: {
        custom_url: 'https://assistant.example.com/v1', custom_include_headers: 'X-App: assistant',
    } });
    await completeWithSillyTavern(st, prompt, 'profile', 'assistant');
    assert.equal(sent.at(-1)[4].custom_include_headers, 'X-App: assistant');

    st.chatCompletionSettings.custom_url = 'https://assistant.example.com/v2';
    await completeWithSillyTavern(st, prompt, 'profile', 'assistant');
    assert.deepEqual(sent.at(-1)[4], {
        custom_include_headers: '', custom_include_body: '', custom_exclude_body: '',
    });
});

test('explains nested authentication errors and preserves user cancellations', async () => {
    const wrapped = new Error('API request failed', { cause: new Error('Unauthorized: test credential') });
    const { st } = setup({ failure: wrapped });
    await assert.rejects(completeWithSillyTavern(st, prompt, 'profile', 'assistant'), error => {
        assert.match(error.message, /鉴权失败/);
        assert.doesNotMatch(error.message, /test credential/);
        return true;
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(completeWithSillyTavern(st, prompt, 'profile', 'assistant', controller.signal), error => error === wrapped);
});

test('identifies incomplete saved connections before sending a request', async () => {
    const { st, sent } = setup({ url: '' });
    await assert.rejects(completeWithSillyTavern(st, prompt, 'profile', 'assistant'), /未保存 API 地址或模型/);
    assert.equal(sent.length, 0);
});

test('keeps the finish reason for polishing through a saved connection', async () => {
    const { st, sent } = setup();
    st.ConnectionManagerRequestService.sendRequest = async (...args) => {
        sent.push(args);
        return { choices: [{ message: { content: '只收到一部分' }, finish_reason: 'length' }] };
    };
    st.extractMessageFromData = (data, api) => {
        assert.equal(api, 'openai');
        return data.choices[0].message.content;
    };
    const result = await completeWithSillyTavern(st, prompt, 'profile', 'assistant', undefined, 2400, { withDetails: true });
    assert.deepEqual(result, { text: '只收到一部分', finishReason: 'length', outputTokens: 4096 });
    assert.equal(sent[0][3].extractData, false);
});

test('honors the saved and custom output budgets, and applies a manual override only for polishing', async () => {
    const customBody = { max_completion_tokens: 7000, max_tokens: 300, reasoning_effort: 'medium' };
    const preset = {
        openai_max_tokens: 6144,
        custom_url: 'https://assistant.example.com/v1',
        custom_include_body: JSON.stringify(customBody),
        custom_exclude_body: '- max_tokens',
    };
    const { st, sent } = setup({ preset });
    st.extractMessageFromData = data => data.content;
    const yaml = { parse: JSON.parse, stringify: JSON.stringify };
    const auto = await completeWithSillyTavern(st, prompt, 'profile', 'assistant', undefined, 2400, { withDetails: true, yaml });
    const manual = await completeWithSillyTavern(st, prompt, 'profile', 'assistant', undefined, 2400, {
        withDetails: true, requestedPolishTokens: 8192, yaml,
    });
    await completeWithSillyTavern(st, prompt, 'profile', 'assistant', undefined, 1600);
    assert.equal(auto.outputTokens, 7000);
    assert.equal(manual.outputTokens, 8192);
    for (const [index, limit] of [[0, 7000], [1, 8192]]) {
        assert.equal(sent[index][2], limit);
        assert.deepEqual(JSON.parse(sent[index][4].custom_include_body), { ...customBody, max_tokens: limit, max_completion_tokens: limit });
        assert.equal(sent[index][4].custom_exclude_body, '- max_tokens');
    }
    assert.equal(sent[2][2], 1600);
    assert.equal(sent[2][4].custom_include_body, preset.custom_include_body);
    assert.deepEqual(JSON.parse(preset.custom_include_body), customBody);
});

test('uses a larger saved preset budget for a non-custom profile', async () => {
    const { st, sent } = setup({ preset: { openai_max_tokens: 12288 } });
    st.CONNECT_API_MAP.custom.source = 'openai';
    st.extractMessageFromData = data => data.content;
    const result = await completeWithSillyTavern(st, prompt, 'profile', 'assistant', undefined, 2400, { withDetails: true });
    assert.equal(sent[0][2], 12288);
    assert.equal(result.outputTokens, 12288);
    assert.equal(sent[0][4], undefined);
});

test('updates the effective token limit in custom include lists in SillyTavern order', async () => {
    const { st, sent } = setup({ preset: {
        custom_url: 'https://assistant.example.com/v1',
        custom_include_body: JSON.stringify([{ max_completion_tokens: 9000, reasoning_effort: 'medium' }, { max_completion_tokens: 500 }]),
    } });
    st.extractMessageFromData = data => data.content;
    const result = await completeWithSillyTavern(st, prompt, 'profile', 'assistant', undefined, 2400, {
        withDetails: true, yaml: { parse: JSON.parse, stringify: JSON.stringify },
    });
    assert.equal(result.outputTokens, 4096);
    assert.deepEqual(JSON.parse(sent[0][4].custom_include_body), { reasoning_effort: 'medium', max_completion_tokens: 4096 });
});

test('gives polishing extra output space on the current chat API while keeping the usual rewrite request', async () => {
    const requests = [];
    const st = {
        mainApi: 'openai',
        chatCompletionSettings: { openai_max_tokens: 300 },
        generateRaw: async request => { requests.push(request); return '普通草稿'; },
        generateRawData: async request => { requests.push(request); return { text: '精修正文', stop_reason: 'end_turn' }; },
        extractMessageFromData: data => data.text,
    };
    assert.equal(await completeWithSillyTavern(st, prompt, 'current'), '普通草稿');
    assert.deepEqual(await completeWithSillyTavern(st, prompt, 'current', '', undefined, 2400, { withDetails: true }), {
        text: '精修正文', finishReason: 'end_turn',
    });
    st.chatCompletionSettings.openai_max_tokens = 4096;
    await completeWithSillyTavern(st, prompt, 'current', '', undefined, 2400, { withDetails: true });
    assert.deepEqual(requests, [
        { prompt, trimNames: false },
        { prompt, api: 'openai', responseLength: 2400 },
        { prompt, api: 'openai' },
    ]);
});
