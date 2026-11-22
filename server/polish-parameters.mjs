const RESERVED = new Set([
    'model', 'messages', 'prompt', 'stream', 'max_tokens', 'max_completion_tokens',
    'max_new_tokens', 'max_length', '__proto__', 'constructor', 'prototype',
]);

export function validatePolishParameters(parameters) {
    if (!parameters || Object.getPrototypeOf(parameters) !== Object.prototype) {
        throw new Error('精修附加参数须为 YAML 或 JSON 键值对象。');
    }
    for (const key of Object.keys(parameters)) {
        if (RESERVED.has(key)) throw new Error(`请通过精修面板或连接设置配置 ${key}。`);
    }
    return parameters;
}

export function isPolishTokenLimit(value) {
    return Number.isInteger(value) && value >= 1 && value <= 65536;
}
