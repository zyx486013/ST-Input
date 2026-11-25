import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { extractVisibleReasoning } from './visible-reasoning.mjs';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function subnetList(subnets, family) {
    const list = new BlockList();
    for (const [address, bits] of subnets) list.addSubnet(address, bits, family);
    return list;
}

const localV4 = subnetList([
    ['10.0.0.0', 8], ['127.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16],
], 'ipv4');
const reservedV4 = subnetList([
    ['0.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['192.0.0.0', 24],
    ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
], 'ipv4');
const localV6 = subnetList([['::1', 128], ['fc00::', 7]], 'ipv6');
const globalV6 = subnetList([['2000::', 3]], 'ipv6');
const reservedV6 = subnetList([
    ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
], 'ipv6');

export class RequestError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export function normalizeApiUrl(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
        throw new RequestError(400, '请填写有效的 API 地址。');
    }
    let url;
    try {
        url = new URL(value.trim());
    } catch {
        throw new RequestError(400, '请填写以 https:// 或 http:// 开头的 API 地址。');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new RequestError(400, 'API 地址须使用 HTTP 或 HTTPS，地址栏仅填写端点。');
    }
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
}

function addressScope({ address, family }) {
    if (family === 4) {
        if (localV4.check(address, 'ipv4')) return 'local';
        return reservedV4.check(address, 'ipv4') ? 'blocked' : 'public';
    }
    if (family === 6) {
        if (localV6.check(address, 'ipv6')) return 'local';
        if (globalV6.check(address, 'ipv6') && !reservedV6.check(address, 'ipv6')) return 'public';
    }
    return 'blocked';
}

export async function resolveApiHost(url, resolve = lookup) {
    const entries = (process.env.ST_INPUT_LOCAL_ORIGINS ?? '').split(',').map(value => value.trim());
    const approvedLocal = entries.includes(url.origin);
    if (url.protocol !== 'https:' && !approvedLocal) {
        throw new RequestError(400, '请使用 HTTPS。访问本地 HTTP API 需在服务端配置 ST_INPUT_LOCAL_ORIGINS。');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const family = isIP(hostname);
    let addresses;
    try {
        addresses = family ? [{ address: hostname, family }] : await resolve(hostname, { all: true });
    } catch {
        throw new RequestError(502, '无法解析 API 域名。');
    }
    if (!addresses.length || addresses.some(address => {
        const scope = addressScope(address);
        return scope === 'blocked' || (scope === 'local' && !approvedLocal);
    })) {
        throw new RequestError(400, 'API 地址指向受限网络。请检查地址及服务端的本地 API 配置。');
    }
    return addresses;
}

function explainHttpStatus(status) {
    if (status === 401 || status === 403) return '鉴权失败，请检查 API Key 和模型权限。';
    if (status === 404) return '地址或模型不存在，请检查 API 地址和模型 ID。';
    if (status === 429) return '请求过多或额度已用完。';
    if (status >= 500) return 'API 服务暂时异常。';
    return '请检查 API 地址、模型 ID 和接口兼容性。';
}

async function requestJson(url, { key, data, signal }) {
    const addresses = await resolveApiHost(url);
    const transport = url.protocol === 'https:' ? https : http;
    const body = data === undefined ? null : JSON.stringify(data);
    const headers = { Accept: 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
    }
    return new Promise((resolve, reject) => {
        const req = transport.request(url, {
            agent: false,
            method: body === null ? 'GET' : 'POST',
            headers,
            signal,
            // Connect using the addresses we checked. A second DNS lookup could pick a different host.
            lookup: (_hostname, options, done) => {
                if (options.all) done(null, addresses);
                else done(null, addresses[0].address, addresses[0].family);
            },
        }, response => {
            const status = response.statusCode ?? 502;
            if (status < 200 || status >= 300) {
                response.destroy();
                reject(new RequestError(502, `上游 HTTP ${status} · ${explainHttpStatus(status)}`));
                return;
            }
            const chunks = [];
            let size = 0;
            response.on('error', reject);
            response.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_RESPONSE_BYTES) {
                    reject(new RequestError(502, 'API 返回的数据过大。'));
                    response.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                } catch {
                    reject(new RequestError(502, 'API 返回的内容无法解析为 JSON。'));
                }
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

export async function callUpstream(config, route, { messages, disconnect, withDetails = false, outputTokens, parameters } = {}) {
    const models = route === 'models';
    const url = new URL(`${config.baseUrl}/${models ? 'models' : 'chat/completions'}`);
    const timeout = AbortSignal.timeout(models ? 12000 : 60000);
    const signal = disconnect ? AbortSignal.any([timeout, disconnect]) : timeout;
    try {
        const data = await requestJson(url, {
            key: config.key,
            signal,
            data: models ? undefined : {
                ...parameters,
                model: config.model,
                messages,
                stream: false,
                max_tokens: outputTokens,
            },
        });
        if (models) {
            if (!Array.isArray(data?.data)) throw new RequestError(502, '该 API 未提供可用的模型列表，可以手动填写模型 ID。');
            return [...new Set(data.data.map(item => item?.id).filter(id => typeof id === 'string' && id.trim() && id.length <= 240))]
                .slice(0, 1000).sort();
        }
        const choice = data?.choices?.[0];
        const content = choice?.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content)
            ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('')
            : '';
        const finishReason = choice?.finish_reason;
        if (!withDetails && !text.trim()) throw new RequestError(502, 'API 已响应，但模型没有返回文本。');
        if (!withDetails) return text;
        const reasoning = extractVisibleReasoning(data);
        return { text, finishReason, ...(reasoning ? { reasoning } : {}), ...(outputTokens === undefined ? {} : { outputTokens }) };
    } catch (error) {
        if (error instanceof RequestError) throw error;
        if (timeout.aborted) throw new RequestError(504, 'API 请求超时。');
        throw new RequestError(502, '连接 API 失败，请检查地址、服务状态和证书。');
    }
}
