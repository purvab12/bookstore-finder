const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export function fail(status, message, extra = {}) {
  return json({ error: message, ...extra }, status);
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function assert(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}

export async function readJson(request, limit = 64 * 1024) {
  const type = request.headers.get("content-type") || "";
  assert(type.includes("application/json"), 415, "Send JSON with content-type: application/json");
  const text = await request.text();
  assert(text.length <= limit, 413, "Request body is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function str(value, { min = 1, max = 500, field = "field" } = {}) {
  assert(typeof value === "string", 400, `${field} must be text`);
  const trimmed = value.trim();
  assert(trimmed.length >= min && trimmed.length <= max, 400, `${field} must be ${min}-${max} characters`);
  return trimmed;
}

export function optionalStr(value, { max = 500, field = "field" } = {}) {
  if (value === undefined || value === null || value === "") return null;
  assert(typeof value === "string", 400, `${field} must be text`);
  const trimmed = value.trim();
  assert(trimmed.length <= max, 400, `${field} must be at most ${max} characters`);
  return trimmed || null;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function bytesToB64u(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += B64_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += B64_ALPHABET[c & 63];
  }
  return out;
}

export function b64uToBytes(text) {
  const clean = String(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const character of clean) {
    const index = B64_ALPHABET.indexOf(character);
    if (index === -1) throw new HttpError(400, "Malformed base64url value");
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  return new Uint8Array(bytes);
}

export function randomToken(bytes = 24) {
  return bytesToB64u(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToB64u(new Uint8Array(digest));
}

export function parseCookies(request) {
  const header = request.headers.get("cookie");
  const cookies = new Map();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

export function serializeCookie(name, value, { maxAge, origin }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (origin.startsWith("https://")) parts.push("Secure");
  return parts.join("; ");
}

export function requestOrigin(request, env) {
  const configured = env.APP_ORIGIN;
  if (configured) return String(configured).replace(/\/$/, "");
  return new URL(request.url).origin;
}

// Browsers send Origin on unsafe requests. Reject anything from another site.
export function assertSameOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  assert(origin === requestOrigin(request, env), 403, "Cross-site request blocked");
}

export async function safeFetch(url, options = {}, timeoutMs = 8000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}
