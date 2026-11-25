import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPolishResponse } from '../polish-stream.js';
import { parsePolishedReply } from '../reply-polish.js';

const extractors = {
    extractText: data => data.choices[0].message.content,
    extractDelta: data => data.choices?.[0]?.delta?.content ?? data.delta?.text,
};
const encode = value => new TextEncoder().encode(value);
const event = data => `data: ${JSON.stringify(data)}\r\n\r\n`;
const delta = content => event({ choices: [{ index: 0, delta: { content } }] });

test('delivers visible prose before the stream ends, including across UTF-8 chunk boundaries', async () => {
    let write;
    const response = new Response(new ReadableStream({ start: controller => { write = controller; } }));
    let notify;
    const first = new Promise(resolve => { notify = resolve; });
    const partials = [];
    const thinking = [];
    let notifyThinking;
    const firstThought = new Promise(resolve => { notifyThinking = resolve; });
    const result = readPolishResponse(response, {
        ...extractors,
        onText: text => {
            partials.push(text);
            notify();
        },
        onReasoning: text => {
            thinking.push(text);
            notifyThinking();
        },
        outputTokens: 16384,
    });
    write.enqueue(encode(event({ choices: [{ index: 0, delta: { reasoning_content: '仅推理' } }] })));
    await firstThought;
    assert.deepEqual(thinking, ['仅推理']);
    assert.deepEqual(partials, []);
    const firstPacket = encode(delta('舟'));
    const char = firstPacket.indexOf(encode('舟')[0]);
    write.enqueue(firstPacket.slice(0, char + 1));
    write.enqueue(firstPacket.slice(char + 1));
    await first;
    assert.deepEqual(partials, ['舟']);
    write.enqueue(encode(delta('行。')));
    write.enqueue(encode(event({ choices: [{ index: 0, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'));
    write.close();
    assert.deepEqual(await result, { text: '舟行。', finishReason: 'stop', outputTokens: 16384, reasoning: '仅推理' });
});

test('keeps token cutoff and rejects a stream that ends without a completion marker', async () => {
    const cutoff = new Response(delta('未完') + event({ choices: [{ finish_reason: 'length' }] }));
    const result = await readPolishResponse(cutoff, { ...extractors, outputTokens: 16384 });
    assert.throws(() => parsePolishedReply(result.text, result.finishReason, result.outputTokens), /16384 tokens/);

    const partials = [];
    await assert.rejects(readPolishResponse(new Response(delta('未完')), {
        ...extractors, onText: text => { partials.push(text); },
    }), /完整稿返回前中断/);
    assert.deepEqual(partials, ['未完']);
});

test('handles Claude message metadata and a normal JSON reply without resending the request', async () => {
    const claude = new Response(event({ type: 'message_start', message: { id: 'test' } })
        + event({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Claude 摘要' } })
        + event({ type: 'content_block_delta', delta: { text: '正文' } })
        + event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })
        + event({ type: 'message_stop' }));
    assert.deepEqual(await readPolishResponse(claude, extractors), { text: '正文', finishReason: 'end_turn', outputTokens: undefined, reasoning: 'Claude 摘要' });
    const json = new Response(JSON.stringify({ choices: [{ message: { content: '同一请求的正文' }, finish_reason: 'stop' }] }));
    assert.deepEqual(await readPolishResponse(json, extractors), { text: '同一请求的正文', finishReason: 'stop', outputTokens: undefined });
});

test('shows only readable reasoning records and preserves prose in a non-streaming reply', async () => {
    const json = new Response(JSON.stringify({ choices: [{
        message: {
            content: '正文',
            reasoning_details: [
                { type: 'reasoning.summary', summary: '先核对场景。' },
                { type: 'reasoning.encrypted', data: 'opaque', text: '不可展示' },
                { type: 'reasoning.text', text: '接着核对对白。', signature: 'opaque' },
            ],
        },
        finish_reason: 'stop',
    }] }));
    assert.deepEqual(await readPolishResponse(json, extractors), {
        text: '正文', finishReason: 'stop', outputTokens: undefined, reasoning: '先核对场景。接着核对对白。',
    });
});

test('reports Cloudflare HTML timeouts and rejects errors reported inside a stream', async () => {
    await assert.rejects(readPolishResponse(new Response('<html>A timeout occurred</html>', { status: 524 }), extractors), /Cloudflare 524/);
    const bad = new Response(delta('未完') + event({ error: { message: 'rate limit' } }));
    await assert.rejects(readPolishResponse(bad, extractors), /rate limit/);
});
