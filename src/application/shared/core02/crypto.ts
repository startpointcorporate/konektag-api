// src/lib/core02/crypto.ts
// Full cryptographic utilities for Core-02
/**
 * Base64url encode a Uint8Array (no padding).
 * Uses the browser's btoa/atob via utf-8.
 */
export function base64urlEncode(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes)
        binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
export function base64urlDecode(str: string): Uint8Array<ArrayBuffer> {
    if (typeof str !== 'string' || str.length > 2000000 || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1)
        throw new Error('INVALID_BASE64URL');
    const binary = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);
    if (base64urlEncode(bytes) !== str)
        throw new Error('NONCANONICAL_BASE64URL');
    return bytes;
}
/**
 * Canonical JSON stringifier.
 * Only accepts primitives (string, number, boolean, null), safe integers, arrays, plain objects.
 * Enforces sorted keys, depth <= 32, no sparse arrays, and forbids special numbers.
 */
export function canonicalJson(value: any): string {
    const maxDepth = 32;
    function isValid(v: any, depth: number = 0): boolean {
        if (depth > maxDepth)
            return false;
        const t = typeof v;
        if (v === null || t === "boolean" || t === "string")
            return true;
        if (t === "number" && Number.isSafeInteger(v))
            return true;
        if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) {
                if (!isValid(v[i], depth + 1))
                    return false;
            }
            return true;
        }
        if (t === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype) {
            for (const key in v) {
                if (!Object.prototype.hasOwnProperty.call(v, key))
                    continue;
                if (!isValid(v[key], depth + 1))
                    return false;
            }
            return true;
        }
        return false;
    }
    if (!isValid(value)) {
        throw new Error("Invalid value for canonical JSON");
    }
    function stringify(v: any): string {
        if (v === null || typeof v !== "object") {
            return JSON.stringify(v);
        }
        if (Array.isArray(v)) {
            return '[' + v.map(stringify).join(",") + ']';
        }
        const keys = Object.keys(v).sort();
        const parts = keys.map(k => JSON.stringify(k) + ":" + stringify(v[k]));
        return '{' + parts.join(",") + '}';
    }
    return stringify(value);
}
/**
 * Generate non-exportable ECDSA P-256 key pair for ES256.
 */
export async function generateSigningKey(): Promise<CryptoKeyPair> {
    return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
}
/**
 * Sign payload (any JSON-serializable value) as ES256 JWS compact.
 * Enforces header exact fields and canonical payload.
 */
export async function signJws(payload: any, privateKey: CryptoKey, kid: string, typ: string): Promise<string> {
    if (privateKey.type !== 'private' || privateKey.algorithm.name !== 'ECDSA' || (privateKey.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256')
        throw new Error('INVALID_KEY');
    if (!kid || kid.length > 128 || !typ || typ.length > 64)
        throw new Error('INVALID_HEADER');
    const header = { alg: "ES256", kid, typ };
    const headerB64 = base64urlEncode(new TextEncoder().encode(canonicalJson(header)));
    const payloadB64 = base64urlEncode(new TextEncoder().encode(canonicalJson(payload)));
    const signingInput = new TextEncoder().encode(headerB64 + "." + payloadB64);
    const derSig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, signingInput));
    const rawSig = derSig;
    if (rawSig.length !== 64)
        throw new Error("Signature format error");
    const signatureB64 = base64urlEncode(rawSig);
    return `${headerB64}.${payloadB64}.${signatureB64}`;
}
/**
 * Verify a JWS ES256 token and return the signed payload.
 */
export async function verifyJws(token: string, publicKey: CryptoKey, expectedKid: string, expectedTyp: string): Promise<any> {
    if (publicKey.type !== 'public' || publicKey.algorithm.name !== 'ECDSA' || (publicKey.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256')
        throw new Error('INVALID_KEY');
    if (typeof token !== 'string' || token.length > (expectedTyp === 'KTG-REV2' ? 2000000 : 4096)) {
        throw new Error("Token exceeds maximum length");
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
        throw new Error("Malformed JWS token");
    }
    const [headerB64, payloadB64, sigB64] = parts;
    const signatureBytes = base64urlDecode(sigB64);
    if (signatureBytes.length !== 64) {
        throw new Error("Invalid signature length");
    }
    const decodedHeader = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64urlDecode(headerB64)));
    const headerKeys = Object.keys(decodedHeader);
    if (headerKeys.length !== 3 ||
        !headerKeys.includes("alg") ||
        !headerKeys.includes("kid") ||
        !headerKeys.includes("typ")) {
        throw new Error("Header contains unexpected fields");
    }
    if (decodedHeader.alg !== "ES256" ||
        decodedHeader.kid !== expectedKid ||
        decodedHeader.typ !== expectedTyp) {
        throw new Error("Header fields mismatch");
    }
    const expectedHeaderB64 = base64urlEncode(new TextEncoder().encode(canonicalJson(decodedHeader)));
    if (headerB64 !== expectedHeaderB64) {
        throw new Error("Header is not canonical");
    }
    const decodedPayload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64urlDecode(payloadB64)));
    const expectedPayloadB64 = base64urlEncode(new TextEncoder().encode(canonicalJson(decodedPayload)));
    if (payloadB64 !== expectedPayloadB64) {
        throw new Error("Payload is not canonical");
    }
    const signingInput = new TextEncoder().encode(headerB64 + "." + payloadB64);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signatureBytes, signingInput);
    if (!valid) {
        throw new Error("Invalid signature");
    }
    return decodedPayload;
}
/**
 * Compute SHA-256 digest of data and return as base64url string.
 */
export async function sha256(data: any): Promise<string> {
    const bytes = new TextEncoder().encode(canonicalJson(data));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return base64urlEncode(new Uint8Array(digest as ArrayBuffer));
}
/**
 * Generate non-exportable AES-256 GCM key.
 */
export async function generateDataKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
/**
 * Encrypt a value (JSON-serializable) using AES-256 GCM.
 * Returns base64url encoded IV and ciphertext.
 */
export async function encryptRecord(value: any, key: CryptoKey, aad: string): Promise<{
    iv: string;
    ciphertext: string;
}> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const payloadBytes = new TextEncoder().encode(canonicalJson(value));
    if (payloadBytes.byteLength > 524288)
        throw new Error('RECORD_TOO_LARGE');
    const aadBytes = new TextEncoder().encode(aad);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aadBytes }, key, payloadBytes);
    return {
        iv: base64urlEncode(iv),
        ciphertext: base64urlEncode(new Uint8Array(encrypted as ArrayBuffer))
    };
}
/**
 * Decrypt an AES-256 GCM record.
 */
export async function decryptRecord(record: {
    iv: string;
    ciphertext: string;
}, key: CryptoKey, aad: string): Promise<any> {
    if (!record || Object.keys(record).sort().join(',') !== 'ciphertext,iv')
        throw new Error('INVALID_RECORD');
    const iv = base64urlDecode(record.iv);
    if (iv.length !== 12)
        throw new Error('INVALID_IV');
    const ciphertext = base64urlDecode(record.ciphertext);
    if (ciphertext.length < 16 || ciphertext.length > 1048576) {
        throw new Error("Ciphertext length out of bounds");
    }
    const aadBytes = new TextEncoder().encode(aad);
    try {
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aadBytes }, key, ciphertext);
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(plain as ArrayBuffer);
        return JSON.parse(decoded);
    }
    catch (_e) {
        throw new Error("Decryption failed");
    }
}
