import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { isPolishTokenLimit, validatePolishParameters } from '../server/polish-parameters.mjs';
import { callUpstream, normalizeApiUrl, resolveApiHost } from '../server/upstream.mjs';

test('keeps the request fields and token limit separate from supplemental polish parameters', () => {
    assert.deepEqual(validatePolishParameters({ reasoning_effort: 'max' }), { reasoning_effort: 'max' });
    assert.throws(() => validatePolishParameters(['reasoning_effort: max']), /键值对象/);
    assert.throws(() => validatePolishParameters({ messages: [] }), /messages/);
    assert.throws(() => validatePolishParameters({ max_tokens: 8192 }), /max_tokens/);
    assert.equal(isPolishTokenLimit(8192), true);
    assert.equal(isPolishTokenLimit(65537), false);
});

test('accepts base URLs and complete chat routes and rejects embedded credentials', () => {
    assert.equal(normalizeApiUrl(' https://example.org/service/v1/chat/completions/ '), 'https://example.org/service/v1');
    assert.equal(normalizeApiUrl('https://example.org/'), 'https://example.org');
    assert.throws(() => normalizeApiUrl('https://name:pass@example.org/v1'));
    assert.throws(() => normalizeApiUrl('https://example.org/v1?token=secret'));
});

test('rejects private, link-local and mixed DNS records by default', async () => {
    await assert.rejects(resolveApiHost(new URL('https://127.0.0.1/v1')), /受限网络/);
    await assert.rejects(resolveApiHost(new URL('https://169.254.169.254/v1')), /受限网络/);
    await assert.rejects(resolveApiHost(new URL('https://[::ffff:169.254.169.254]/v1')), /受限网络/);
    await assert.rejects(resolveApiHost(new URL('https://example.org'), async () => [
        { address: '1.1.1.1', family: 4 },
        { address: '10.0.0.1', family: 4 },
    ]), /受限网络/);
});

test('requests an allowed local OpenAI endpoint, handles model lists and refuses redirects', async t => {
    const calls = [];
    const mock = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        calls.push({ url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/v1/models') {
            res.end(JSON.stringify({ data: [{ id: 'small' }, { id: 'small' }] }));
        } else if (req.url === '/v1/chat/completions') {
            const capped = JSON.parse(calls.at(-1).body).messages[0].content === '只有推理';
            res.end(JSON.stringify({ choices: [{
                message: { content: capped ? '' : '正常', ...(capped ? { reasoning_content: '可见推理' } : {}) },
                finish_reason: capped ? 'length' : 'stop',
            }] }));
        } else {
            res.writeHead(302, { Location: '/v1/models' }).end();
        }
    });
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    const previous = process.env.ST_INPUT_LOCAL_ORIGINS;
    const origin = `http://127.0.0.1:${mock.address().port}`;
    process.env.ST_INPUT_LOCAL_ORIGINS = origin;
    t.after(() => {
        mock.close();
        if (previous === undefined) delete process.env.ST_INPUT_LOCAL_ORIGINS;
        else process.env.ST_INPUT_LOCAL_ORIGINS = previous;
    });
    const config = { baseUrl: `${origin}/v1`, model: 'small', key: 'test-key' };
    assert.deepEqual(await callUpstream(config, 'models'), ['small']);
    const messages = [{ role: 'user', content: '测试' }];
    assert.equal(await callUpstream(config, 'generate', { messages }), '正常');
    assert.equal(calls[1].authorization, 'Bearer test-key');
    assert.deepEqual(JSON.parse(calls[1].body).messages, messages);
    assert.deepEqual(await callUpstream(config, 'generate', { messages, withDetails: true }), { text: '正常', finishReason: 'stop' });
    assert.deepEqual(await callUpstream(config, 'generate', {
        messages: [{ role: 'user', content: '只有推理' }], withDetails: true,
    }), { text: '', finishReason: 'length', reasoning: '可见推理' });
    assert.deepEqual(await callUpstream(config, 'generate', {
        messages, withDetails: true, outputTokens: 8192, parameters: { reasoning_effort: 'max' },
    }), { text: '正常', finishReason: 'stop', outputTokens: 8192 });
    assert.deepEqual(JSON.parse(calls.at(-1).body), {
        reasoning_effort: 'max', model: 'small', messages, stream: false, max_tokens: 8192,
    });
    await assert.rejects(callUpstream({ ...config, baseUrl: `${origin}/redirect` }, 'models'), /HTTP 302/);
    assert.equal(calls.length, 6);
});
