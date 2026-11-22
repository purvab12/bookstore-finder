import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  assert,
  b64uToBytes,
  bytesToB64u,
  HttpError,
  parseCookies,
  randomToken,
  readJson,
  requestOrigin,
  serializeCookie,
  sha256,
  str,
} from "./util.js";

export const SESSION_COOKIE = "bl_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const CHALLENGE_SECONDS = 60 * 5;
const RP_NAME = "bookloop";

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function normalizeHandle(value) {
  const handle = String(value || "").trim().toLowerCase().replace(/^@/, "");
  assert(HANDLE_RE.test(handle), 400, "Handle must be 3-20 characters: letters, numbers or underscore");
  return handle;
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    city: row.city,
    bio: row.bio,
    shelfVisibility: row.shelf_visibility,
    createdAt: row.created_at,
  };
}

function newRecoveryCode() {
  let code = "";
  for (let i = 0; i < 12; i += 1) {
    const [byte] = crypto.getRandomValues(new Uint8Array(1));
    code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

export async function recoveryHash(code, userId) {
  return sha256(`${code.replace(/[^A-Z0-9]/gi, "").toUpperCase()}:${userId}`);
}

async function saveChallenge(env, kind, challenge, payload, userId = null) {
  const id = randomToken(18);
  await env.DB.prepare(
    "INSERT INTO webauthn_challenges (id, user_id, kind, challenge, payload, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))",
  )
    .bind(id, userId, kind, challenge, JSON.stringify(payload), `+${CHALLENGE_SECONDS} seconds`)
    .run();
  return id;
}

async function takeChallenge(env, id, kind) {
  assert(typeof id === "string" && id.length > 8, 400, "Missing challenge id");
  const row = await env.DB.prepare(
    "SELECT * FROM webauthn_challenges WHERE id = ? AND kind = ? AND expires_at > datetime('now')",
  )
    .bind(id, kind)
    .first();
  assert(row, 400, "This sign-in attempt expired. Try again.");
  await env.DB.prepare("DELETE FROM webauthn_challenges WHERE id = ?").bind(id).run();
  return row;
}

export async function createSession(env, userId, origin) {
  const id = randomToken(32);
  await env.DB.prepare("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))")
    .bind(await sha256(id), userId, `+${SESSION_SECONDS} seconds`)
    .run();
  return serializeCookie(SESSION_COOKIE, id, { maxAge: SESSION_SECONDS, origin });
}

export async function destroySession(request, env) {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(token)).run();
  }
}

export async function currentUser(request, env) {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND s.expires_at > datetime('now')`,
  )
    .bind(await sha256(token))
    .first();
  return row || null;
}

export async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, "Sign in to do that");
  return user;
}

async function credentialRows(env, userId) {
  const { results } = await env.DB.prepare(
    "SELECT id, public_key, counter, transports FROM credentials WHERE user_id = ? ORDER BY created_at",
  )
    .bind(userId)
    .all();
  return results || [];
}

function allowCredentials(rows) {
  return rows.map((row) => ({
    id: row.id,
    transports: row.transports ? JSON.parse(row.transports) : undefined,
  }));
}

function rpID(origin) {
  return new URL(origin).hostname;
}

export async function registerOptions(request, env) {
  const body = await readJson(request);
  const handle = normalizeHandle(body.handle);
  const displayName = str(body.displayName || handle, { min: 1, max: 60, field: "Display name" });
  const city = body.city ? str(body.city, { min: 2, max: 40, field: "City" }) : null;

  const existing = await env.DB.prepare("SELECT id FROM users WHERE handle = ?").bind(handle).first();
  assert(!existing, 409, "That handle is taken");

  const origin = requestOrigin(request, env);
  const userId = bytesToB64u(crypto.getRandomValues(new Uint8Array(16)));
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpID(origin),
    userID: b64uToBytes(userId),
    userName: handle,
    userDisplayName: displayName,
    attestationType: "none",
    excludeCredentials: [],
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });

  const challengeId = await saveChallenge(env, "register", options.challenge, {
    handle,
    displayName,
    city,
    userId,
  });
  return { challengeId, options };
}

export async function registerVerify(request, env) {
  const body = await readJson(request);
  const challenge = await takeChallenge(env, body.challengeId, "register");
  const payload = JSON.parse(challenge.payload);
  const origin = requestOrigin(request, env);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID(origin),
      requireUserVerification: false,
    });
  } catch (error) {
    throw new HttpError(400, `Passkey could not be verified: ${error.message}`);
  }
  assert(verification.verified && verification.registrationInfo, 400, "Passkey could not be verified");

  const credential = verification.registrationInfo.credential;
  const userId = payload.userId;
  const recoveryCode = newRecoveryCode();

  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, handle, display_name, city) VALUES (?, ?, ?, ?)").bind(
        userId,
        payload.handle,
        payload.displayName,
        payload.city,
      ),
      env.DB.prepare(
        "INSERT INTO credentials (id, user_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        credential.id,
        userId,
        bytesToB64u(credential.publicKey),
        credential.counter ?? 0,
        JSON.stringify(credential.transports || []),
      ),
      env.DB.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)").bind(
        userId,
        await recoveryHash(recoveryCode, userId),
      ),
    ]);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw new HttpError(409, "That handle was just taken");
    throw error;
  }

  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  const cookie = await createSession(env, userId, origin);
  return { user: publicUser(row), recoveryCode, cookie };
}

export async function loginOptions(request, env) {
  const body = await readJson(request);
  const handle = normalizeHandle(body.handle);
  const user = await env.DB.prepare("SELECT * FROM users WHERE handle = ?").bind(handle).first();
  assert(user, 404, "No account with that handle");

  const origin = requestOrigin(request, env);
  const rows = await credentialRows(env, user.id);
  assert(rows.length, 409, "That account has no passkey yet. Use your recovery code.");

  const options = await generateAuthenticationOptions({
    rpID: rpID(origin),
    allowCredentials: allowCredentials(rows),
    userVerification: "preferred",
  });
  const challengeId = await saveChallenge(env, "login", options.challenge, { userId: user.id }, user.id);
  return { challengeId, options };
}

export async function loginVerify(request, env) {
  const body = await readJson(request);
  const challenge = await takeChallenge(env, body.challengeId, "login");
  const payload = JSON.parse(challenge.payload);
  const origin = requestOrigin(request, env);
  const credentialId = body?.response?.id;
  assert(typeof credentialId === "string", 400, "Missing passkey id");

  const credential = await env.DB.prepare("SELECT * FROM credentials WHERE id = ? AND user_id = ?")
    .bind(credentialId, payload.userId)
    .first();
  assert(credential, 404, "Passkey not found for this account");

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID(origin),
      requireUserVerification: false,
      credential: {
        id: credential.id,
        publicKey: b64uToBytes(credential.public_key),
        counter: credential.counter,
        transports: credential.transports ? JSON.parse(credential.transports) : undefined,
      },
    });
  } catch (error) {
    throw new HttpError(400, `Passkey could not be verified: ${error.message}`);
  }
  assert(verification.verified, 401, "Passkey could not be verified");

  await env.DB.prepare("UPDATE credentials SET counter = ?, last_used_at = datetime('now') WHERE id = ?")
    .bind(verification.authenticationInfo.newCounter, credential.id)
    .run();

  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(payload.userId).first();
  const cookie = await createSession(env, payload.userId, origin);
  return { user: publicUser(user), cookie };
}

export async function recoveryOptions(request, env) {
  const body = await readJson(request);
  const handle = normalizeHandle(body.handle);
  const code = String(body.code || "").trim();
  assert(code.length >= 8, 400, "Enter your recovery code");

  const user = await env.DB.prepare("SELECT * FROM users WHERE handle = ?").bind(handle).first();
  assert(user, 404, "No account with that handle");

  const stored = await env.DB.prepare("SELECT * FROM recovery_codes WHERE user_id = ?").bind(user.id).first();
  assert(stored && !stored.used_at, 409, "That recovery code has already been used");
  assert(stored.code_hash === (await recoveryHash(code, user.id)), 401, "That recovery code is not right");

  const origin = requestOrigin(request, env);
  const rows = await credentialRows(env, user.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpID(origin),
    userID: b64uToBytes(user.id),
    userName: user.handle,
    userDisplayName: user.display_name,
    attestationType: "none",
    excludeCredentials: allowCredentials(rows),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  const challengeId = await saveChallenge(env, "recover", options.challenge, { userId: user.id }, user.id);
  return { challengeId, options };
}

export async function recoveryVerify(request, env) {
  const body = await readJson(request);
  const challenge = await takeChallenge(env, body.challengeId, "recover");
  const payload = JSON.parse(challenge.payload);
  const origin = requestOrigin(request, env);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID(origin),
      requireUserVerification: false,
    });
  } catch (error) {
    throw new HttpError(400, `Passkey could not be verified: ${error.message}`);
  }
  assert(verification.verified && verification.registrationInfo, 400, "Passkey could not be verified");

  const credential = verification.registrationInfo.credential;
  const recoveryCode = newRecoveryCode();

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO credentials (id, user_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      credential.id,
      payload.userId,
      bytesToB64u(credential.publicKey),
      credential.counter ?? 0,
      JSON.stringify(credential.transports || []),
    ),
    env.DB.prepare("UPDATE recovery_codes SET used_at = datetime('now') WHERE user_id = ?").bind(payload.userId),
    env.DB.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)").bind(
      payload.userId,
      await recoveryHash(recoveryCode, payload.userId),
    ),
  ]);

  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(payload.userId).first();
  const cookie = await createSession(env, payload.userId, origin);
  return { user: publicUser(user), recoveryCode, cookie };
}
