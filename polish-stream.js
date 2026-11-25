import { extractVisibleReasoning } from './server/visible-reasoning.mjs';

export const TIMEOUT_524_MESSAGE = 'Cloudflare 524。代理等待响应超时。可降低推理强度后重试，或通过直连、SSH 转发访问 SillyTavern。';

export class PolishStreamError extends Error {}

function checkApiError(data) {
    const error = data?.error ?? data?.detail?.error;
    if (!error && typeof data?.message !== 'string' && !data?.quota_error) return;
    const code = error?.status ?? error?.code ?? data?.status;
    const message = typeof error === 'string' ? error : error?.message ?? data?.message;
    throw new Error([code, data?.quota_error ? 'insufficient_quota' : message].filter(Boolean).join(' '));
}

function finishReasonOf(data) {
    return data?.choices?.[0]?.finish_reason
        ?? data?.stop_reason
        ?? data?.delta?.stop_reason
        ?? data?.delta?.finish_reason
        ?? data?.candidates?.[0]?.finishReason
        ?? data?.stop_type;
}

export async function readPolishResponse(response, { extractText, extractDelta, outputTokens, onText, onReasoning }) {
    if (response.status === 524) {
        await response.body?.cancel().catch(() => {});
        throw new PolishStreamError(TIMEOUT_524_MESSAGE);
    }
    if (!response.ok) {
        const data = await response.json().catch(() => null);
        try {
            checkApiError(data);
        } catch (error) {
            throw new Error(`HTTP ${response.status}`, { cause: error });
        }
        throw new Error(`HTTP ${response.status}`);
    }
    if (!response.body) throw new PolishStreamError('模型没有返回精修内容。');

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let jsonResponse;
    let text = '';
    let reasoning = '';
    let finishReason;
    let ended = false;
    let reachedEof = false;
    try {
        while (!ended) {
            const { done, value } = await reader.read();
            reachedEof = done;
            if (done) break;
            buffer += value;
            // ST's streaming proxy may omit the upstream Content-Type header.
            const start = buffer.trimStart()[0];
            if (jsonResponse === undefined && start) jsonResponse = start === '{' || start === '[';
            if (jsonResponse !== false) continue;

            const packets = buffer.split(/\r\n\r\n|\r\r|\n\n/);
            buffer = packets.pop();
            for (const packet of packets) {
                const payload = packet.split(/\r\n|\r|\n/)
                    .filter(line => line.startsWith('data:'))
                    .map(line => line.slice(5).replace(/^ /, '')).join('\n');
                if (!payload.trim()) continue;
                if (payload.trim() === '[DONE]') {
                    ended = true;
                    break;
                }
                let data;
                try {
                    data = JSON.parse(payload);
                } catch {
                    throw new PolishStreamError('精修流式响应格式有误。');
                }
                checkApiError(data);
                if (data.choices?.[0]?.index > 0) continue;
                finishReason = finishReasonOf(data) ?? finishReason;
                const thought = extractVisibleReasoning(data);
                if (thought) {
                    reasoning += thought;
                    onReasoning?.(reasoning);
                }
                const delta = extractDelta(data);
                if (typeof delta === 'string' && delta) {
                    text += delta;
                    onText?.(text);
                }
                if (data.type === 'message_stop' || data.type === 'message-end') ended = true;
            }
        }

        if (jsonResponse) {
            let data;
            try {
                data = JSON.parse(buffer);
            } catch {
                throw new PolishStreamError('模型返回的精修响应不完整。');
            }
            checkApiError(data);
            reasoning = extractVisibleReasoning(data);
            if (reasoning) onReasoning?.(reasoning);
            text = extractText(data);
            if (text) onText?.(text);
            finishReason = finishReasonOf(data);
        } else if (!ended && !finishReason) {
            throw new PolishStreamError('精修连接在完整稿返回前中断。');
        }
        if (/^(content_filter|safety|blocked)$/i.test(finishReason ?? '')) {
            throw new PolishStreamError('模型提前停止，未返回完整稿件。');
        }
        return { text, finishReason, outputTokens, ...(reasoning ? { reasoning } : {}) };
    } finally {
        if (!reachedEof) await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
