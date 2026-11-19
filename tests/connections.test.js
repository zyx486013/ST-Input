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
        CONNECT_API_MAP: { custom: { source: 'custom' } },
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
