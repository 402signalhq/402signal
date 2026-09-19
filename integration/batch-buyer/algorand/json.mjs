import { createHash } from 'node:crypto';
export class LabError extends Error {
    code;
    status;
    constructor(code, status = 400) {
        super(code);
        this.code = code;
        this.status = status;
    }
}
export function assert(ok, code, status = 400) {
    if (!ok)
        throw new LabError(code, status);
}
export function object(x) {
    assert(x !== null && typeof x === 'object' && !Array.isArray(x), 'object_required');
    return x;
}
export function text(x, max = 4096) {
    assert(typeof x === 'string' && x.length <= max && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(x), 'invalid_string');
    return x;
}
// Strict JSON boundary: reject duplicate keys (including escaped duplicates),
// unsafe numbers, prototype keys and excessive nesting before any payment work.
export function parseJson(raw, maximum = 65536, accountInfo = false) {
    assert(Buffer.byteLength(raw) <= maximum, 'body_too_large', 413);
    let at = 0;
    const ws = () => { while (/[\t\r\n ]/.test(raw[at] ?? '\0'))
        at++; };
    const string = () => {
        const start = at++;
        while (at < raw.length) {
            const c = raw[at++];
            if (c === '\\')
                at++;
            else if (c === '"')
                return text(JSON.parse(raw.slice(start, at)), maximum);
        }
        throw new LabError('invalid_json');
    };
    const value = (depth, path = []) => {
        assert(depth <= 24, 'json_too_deep');
        ws();
        if (raw[at] === '"')
            return string();
        if (raw[at] === '{') {
            at++;
            ws();
            const out = Object.create(null);
            const seen = new Set();
            if (raw[at] === '}') {
                at++;
                return out;
            }
            for (;;) {
                assert(raw[at] === '"', 'invalid_json');
                const k = string();
                assert(!seen.has(k) && !['__proto__', 'prototype', 'constructor'].includes(k), 'duplicate_or_reserved_key');
                seen.add(k);
                ws();
                assert(raw[at++] === ':', 'invalid_json');
                out[k] = value(depth + 1, [...path, k]);
                ws();
                if (raw[at] === '}') {
                    at++;
                    return out;
                }
                assert(raw[at++] === ',', 'invalid_json');
                ws();
            }
        }
        if (raw[at] === '[') {
            at++;
            ws();
            const out = [];
            if (raw[at] === ']') {
                at++;
                return out;
            }
            for (;;) {
                assert(out.length < 4096, 'array_too_large');
                out.push(value(depth + 1, [...path, String(out.length)]));
                ws();
                if (raw[at] === ']') {
                    at++;
                    return out;
                }
                assert(raw[at++] === ',', 'invalid_json');
            }
        }
        const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(at))?.[0];
        assert(token, 'invalid_json');
        at += token.length;
        // Solana uses u64::MAX for rent-exempt rentEpoch metadata. Preserve it
        // exactly as text only at this RPC field; payment and balance numbers stay strict.
        if (accountInfo && path.join('.') === 'result.value.rentEpoch' &&
            /^(0|[1-9]\d*)$/.test(token) && BigInt(token) > BigInt(Number.MAX_SAFE_INTEGER)) {
            assert(BigInt(token) <= 18446744073709551615n, 'unsafe_number');
            return token;
        }
        const result = JSON.parse(token);
        if (typeof result === 'number')
            assert(Number.isFinite(result) && (!Number.isInteger(result) || Number.isSafeInteger(result)), 'unsafe_number');
        return result;
    };
    try {
        const out = value(0);
        ws();
        assert(at === raw.length, 'invalid_json');
        return out;
    }
    catch (e) {
        if (e instanceof LabError)
            throw e;
        throw new LabError('invalid_json');
    }
}
export function canonical(x) {
    if (Array.isArray(x))
        return '[' + x.map(canonical).join(',') + ']';
    if (x !== null && typeof x === 'object')
        return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
    return JSON.stringify(x);
}
export const digest = (x) => createHash('sha256').update(x).digest('hex');
function unpad64(s) {
    const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
    return s.slice(0, s.length - padding);
}
export function decode64(x, max = 16384) {
    const s = text(x, max * 2);
    assert(/^[A-Za-z0-9+/]+={0,2}$/.test(s), 'invalid_base64');
    const bytes = Buffer.from(s, 'base64');
    assert(bytes.length <= max && unpad64(bytes.toString('base64')) === unpad64(s), 'invalid_base64');
    return bytes;
}
export const encode64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64');
export function atomic(x) {
    assert(typeof x === 'string' && /^(0|[1-9]\d{0,12})$/.test(x), 'invalid_atomic_amount');
    return BigInt(x);
}
//# sourceMappingURL=json.js.map