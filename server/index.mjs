import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { callUpstream, normalizeApiUrl, RequestError, resolveApiHost } from './upstream.mjs';
import { isPolishTokenLimit, MAX_POLISH_MESSAGE, MAX_STANDARD_MESSAGE, validatePolishParameters } from './polish-parameters.mjs';

export const info = {
    id: 'st-input',
    name: 'ST-Input Custom API',
    description: 'Server-side requests and credentials for the ST-Input custom endpoint.',
};

async function readConfig(file) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

async function saveConfig(file, config) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
    } finally {
        await rm(temporary, { force: true });
    }
}

function publicConfig({ baseUrl = '', model = '', key = '' }) {
    return { baseUrl, model, hasKey: Boolean(key), polishParameters: true, maxPolishMessage: MAX_POLISH_MESSAGE };
}

function readCandidate(input, saved, needsModel = true) {
    const baseUrl = normalizeApiUrl(input?.baseUrl);
    const model = typeof input.model === 'string' ? input.model.trim() : '';
    if ((needsModel && !model) || model.length > 240) throw new RequestError(400, '请填写有效的模型 ID。');
    let key = saved.baseUrl && new URL(saved.baseUrl).origin === new URL(baseUrl).origin ? saved.key : '';
    if (input.key !== undefined) {
        if (typeof input.key !== 'string' || input.key.length > 4096 || /[^\x21-\x7E]/.test(input.key.trim())) {
            throw new RequestError(400, 'API Key 格式有误。');
        }
        key = input.key.trim();
    }
    return { baseUrl, model, key: key ?? '' };
}

function readMessages(input) {
    const messages = input?.messages;
    const maxUserLength = input?.withDetails === true ? MAX_POLISH_MESSAGE : MAX_STANDARD_MESSAGE;
    if (!Array.isArray(messages) || messages.length !== 2 || messages[0]?.role !== 'system' || messages[1]?.role !== 'user'
        || messages.some((message, index) => typeof message.content !== 'string' || !message.content.trim()
            || message.content.length > (index === 1 ? maxUserLength : MAX_STANDARD_MESSAGE))) {
        throw new RequestError(400, '输入助手的请求内容有误或过长。');
    }
    return messages.map(({ role, content }) => ({ role, content }));
}

function endpoint(handler) {
    return async (request, response) => {
        response.set('Cache-Control', 'no-store');
        const root = request.user?.directories?.root;
        if (!request.user?.profile?.admin || typeof root !== 'string') {
            response.status(403).json({ error: '自定义 API 需要 SillyTavern 管理员账号。' });
            return;
        }
        const disconnect = new AbortController();
        response.once('close', () => disconnect.abort());
        try {
            const file = join(root, 'st-input-custom-api.json');
            const result = await handler(request.body, file, disconnect.signal);
            if (!response.destroyed) response.json(result);
        } catch (error) {
            if (response.destroyed) return;
            if (error instanceof RequestError) {
                response.status(error.status).json({ error: error.message });
                return;
            }
            response.status(500).json({ error: '输入助手无法读取或保存服务端配置。' });
        }
    };
}

export async function init(router) {
    router.get('/config', endpoint(async (_input, file) => publicConfig(await readConfig(file))));
    router.put('/config', endpoint(async (input, file) => {
        const config = readCandidate(input, await readConfig(file));
        await resolveApiHost(new URL(config.baseUrl));
        await saveConfig(file, config);
        return publicConfig(config);
    }));
    router.post('/models', endpoint(async (input, file, disconnect) => {
        const config = readCandidate(input, await readConfig(file), false);
        return { models: await callUpstream(config, 'models', { disconnect }) };
    }));
    router.post('/test', endpoint(async (input, file, disconnect) => {
        const config = readCandidate(input, await readConfig(file));
        const start = performance.now();
        const messages = [{ role: 'user', content: 'Reply with OK.' }];
        await callUpstream(config, 'test', { messages, disconnect });
        return { model: config.model, elapsed: Math.round(performance.now() - start) };
    }));
    router.post('/generate', endpoint(async (input, file, disconnect) => {
        const config = await readConfig(file);
        if (!config.baseUrl || !config.model) throw new RequestError(400, '请先保存自定义 API 地址和模型。');
        const messages = readMessages(input);
        if (input.withDetails === true) {
            const { outputTokens, parameters = {} } = input;
            if (outputTokens !== undefined && !isPolishTokenLimit(outputTokens)) {
                throw new RequestError(400, '精修输出上限须为 1 到 65536 的整数。');
            }
            try {
                validatePolishParameters(parameters);
            } catch (error) {
                throw new RequestError(400, error.message);
            }
            return callUpstream(config, 'generate', { messages, disconnect, withDetails: true, outputTokens, parameters });
        }
        return { text: await callUpstream(config, 'generate', { messages, disconnect }) };
    }));
}
