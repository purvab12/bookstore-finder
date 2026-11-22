export const state = { config: null, me: null };
let authDialog;
let authMode = "signin";
let pendingAuthMessage = "";

export async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

export async function loadConfig() {
  if (!state.config) state.config = await api("/api/config");
  return state.config;
}

export async function loadMe() {
  try {
    state.me = await api("/api/me");
  } catch {
    state.me = { user: null };
  }
  return state.me;
}

export function tagLabel(tag) {
  const all = Object.values(state.config?.tagGroups || {}).flat();
  return all.find((item) => item.id === tag)?.label || tag.replace(/-/g, " ");
}

export function tagEmoji(tag) {
  const all = Object.values(state.config?.tagGroups || {}).flat();
  return all.find((item) => item.id === tag)?.emoji || "✳";
}

export function cityName(id) {
  return state.config?.cities.find((city) => city.id === id)?.name || id;
}

/* ------------------------------------------------------------- formatting */

export function formatDate(iso) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
}

export function formatTime(iso) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function formatDateTime(iso) {
  return `${formatDate(iso)} · ${formatTime(iso)}`;
}

export function relativeDays(iso) {
  const target = new Date(iso);
  const today = new Date();
  target.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((target - today) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days > 1 && days < 7) return `In ${days} days`;
  return formatDate(iso);
}

export function initials(name) {
  return String(name || "?").split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("");
}

/* ------------------------------------------------------------------ toast */

export function toast(message, tone = "info") {
  let node = document.querySelector("#toast");
  if (!node) {
    node = document.createElement("div");
    node.id = "toast";
    node.className = "toast";
    node.setAttribute("role", "status");
    document.body.append(node);
  }
  node.textContent = message;
  node.dataset.tone = tone;
  node.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("is-visible"), 4200);
}

/* ----------------------------------------------------------------- header */

export async function signOut() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // Redirect regardless: the session may already be gone.
  }
  window.location.assign("/");
}

export function renderHeader() {
  const slot = document.querySelector("#account-slot");
  if (!slot) return;
  const user = state.me?.user;
  if (user) {
    slot.innerHTML = `
      <div class="account-menu">
        <button class="account-pill" type="button" aria-expanded="false" aria-haspopup="true" data-account-toggle>
          <span class="account-avatar">${escapeHtml(initials(user.displayName))}</span>
          <span>@${escapeHtml(user.handle)}</span>
          <span class="account-caret" aria-hidden="true">▾</span>
        </button>
        <div class="account-popover" hidden>
          <p class="account-popover-name">${escapeHtml(user.displayName)}</p>
          <a href="/account">My shelf</a>
          <button type="button" data-sign-out>Sign out</button>
        </div>
      </div>`;
    const toggle = slot.querySelector("[data-account-toggle]");
    const popover = slot.querySelector(".account-popover");
    const closeMenu = () => {
      popover.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    };
    toggle.addEventListener("click", () => {
      popover.hidden = !popover.hidden;
      toggle.setAttribute("aria-expanded", String(!popover.hidden));
    });
    slot.querySelector("[data-sign-out]").addEventListener("click", signOut);
    document.addEventListener("click", (event) => {
      if (!slot.contains(event.target)) closeMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenu();
    });
  } else {
    slot.innerHTML = `<button class="account-pill" type="button" data-auth-open>Sign in</button>`;
    slot.querySelector("[data-auth-open]").addEventListener("click", () => openAuth("signin"));
  }
}

/* -------------------------------------------------------------- passkeys */

function toBuffer(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function fromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function registrationJSON(credential) {
  const response = credential.response;
  return {
    id: credential.id,
    rawId: fromBuffer(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults?.() || {},
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    response: {
      clientDataJSON: fromBuffer(response.clientDataJSON),
      attestationObject: fromBuffer(response.attestationObject),
      transports: response.getTransports ? response.getTransports() : undefined,
    },
  };
}

function authenticationJSON(credential) {
  const response = credential.response;
  return {
    id: credential.id,
    rawId: fromBuffer(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults?.() || {},
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    response: {
      clientDataJSON: fromBuffer(response.clientDataJSON),
      authenticatorData: fromBuffer(response.authenticatorData),
      signature: fromBuffer(response.signature),
      userHandle: response.userHandle ? fromBuffer(response.userHandle) : undefined,
    },
  };
}

function publicKeyOptions(options) {
  return {
    ...options,
    challenge: toBuffer(options.challenge),
    user: options.user ? { ...options.user, id: toBuffer(options.user.id) } : undefined,
    excludeCredentials: (options.excludeCredentials || []).map((item) => ({ ...item, id: toBuffer(item.id) })),
    allowCredentials: (options.allowCredentials || []).map((item) => ({ ...item, id: toBuffer(item.id) })),
  };
}

async function createPasskey(options) {
  if (!window.PublicKeyCredential) throw new Error("This browser does not support passkeys.");
  return navigator.credentials.create({ publicKey: publicKeyOptions(options) });
}

async function getPasskey(options) {
  if (!window.PublicKeyCredential) throw new Error("This browser does not support passkeys.");
  return navigator.credentials.get({ publicKey: publicKeyOptions(options) });
}

/* ------------------------------------------------------------ auth dialog */

function authShell() {
  if (authDialog) return authDialog;
  authDialog = document.createElement("dialog");
  authDialog.id = "auth-dialog";
  authDialog.className = "app-dialog auth-dialog";
  authDialog.innerHTML = `
    <button class="dialog-close" type="button" aria-label="Close" data-auth-close>×</button>
    <div id="auth-body"></div>`;
  document.body.append(authDialog);
  authDialog.addEventListener("click", (event) => {
    if (event.target === authDialog || event.target.closest("[data-auth-close]")) authDialog.close();
  });
  return authDialog;
}

export function openAuth(mode = "signin", message = "") {
  authMode = mode;
  pendingAuthMessage = message;
  const dialog = authShell();
  renderAuthBody();
  if (!dialog.open) dialog.showModal();
}

function authMessage() {
  return pendingAuthMessage ? `<p class="form-error">${escapeHtml(pendingAuthMessage)}</p>` : "";
}

function renderAuthBody() {
  const body = authDialog.querySelector("#auth-body");
  if (authMode === "signup") {
    body.innerHTML = `
      <p class="eyebrow">Join bookloop</p>
      <h2>Make a reader account.</h2>
      <p class="dialog-copy">No password, no email. Your device creates a passkey with Face ID, Touch ID or your screen lock.</p>
      ${authMessage()}
      <form id="signup-form" class="stack-form">
        <label class="field"><span>Handle</span>
          <input name="handle" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" placeholder="paperbackpal" autocomplete="username">
        </label>
        <label class="field"><span>Display name</span>
          <input name="displayName" required maxlength="60" placeholder="Your name">
        </label>
        <label class="field"><span>Home city</span>
          <select name="city">${(state.config?.cities || []).map((city) => `<option value="${city.id}">${escapeHtml(city.name)}</option>`).join("")}</select>
        </label>
        <button class="btn btn-primary" type="submit">Create account with a passkey</button>
      </form>
      <p class="auth-switch"><button type="button" class="link-button" data-auth-mode="signin">I already have an account</button></p>`;
    body.querySelector("#signup-form").addEventListener("submit", handleSignup);
  } else if (authMode === "recovery") {
    body.innerHTML = `
      <p class="eyebrow">Locked out?</p>
      <h2>Use a recovery code.</h2>
      <p class="dialog-copy">Enter the code you saved when you joined. You will add a fresh passkey to this device.</p>
      ${authMessage()}
      <form id="recovery-form" class="stack-form">
        <label class="field"><span>Handle</span>
          <input name="handle" required placeholder="paperbackpal" autocomplete="username">
        </label>
        <label class="field"><span>Recovery code</span>
          <input name="code" required placeholder="XXXX-XXXX-XXXX" autocomplete="one-time-code">
        </label>
        <button class="btn btn-primary" type="submit">Add a new passkey</button>
      </form>
      <p class="auth-switch"><button type="button" class="link-button" data-auth-mode="signin">Back to sign in</button></p>`;
    body.querySelector("#recovery-form").addEventListener("submit", handleRecovery);
  } else if (authMode === "recovery-code") {
    body.innerHTML = `
      <p class="eyebrow">Save this now</p>
      <h2>Your recovery code.</h2>
      <p class="dialog-copy">This is the only way back in if you lose this device. Store it in your password manager. It will not be shown again.</p>
      <p class="recovery-code">${escapeHtml(pendingAuthMessage)}</p>
      <button class="btn btn-primary" type="button" data-auth-done>I saved it</button>`;
    body.querySelector("[data-auth-done]").addEventListener("click", () => {
      authDialog.close();
      window.location.reload();
    });
  } else {
    body.innerHTML = `
      <p class="eyebrow">Welcome back</p>
      <h2>Sign in to bookloop.</h2>
      <p class="dialog-copy">Use the passkey saved on this device.</p>
      ${authMessage()}
      <form id="signin-form" class="stack-form">
        <label class="field"><span>Handle</span>
          <input name="handle" required placeholder="paperbackpal" autocomplete="username webauthn">
        </label>
        <button class="btn btn-primary" type="submit">Sign in with a passkey</button>
      </form>
      <p class="auth-switch"><button type="button" class="link-button" data-auth-mode="signup">New here? Create an account</button>
      · <button type="button" class="link-button" data-auth-mode="recovery">Lost your passkey?</button></p>`;
    body.querySelector("#signin-form").addEventListener("submit", handleSignin);
  }

  for (const button of body.querySelectorAll("[data-auth-mode]")) {
    button.addEventListener("click", () => {
      pendingAuthMessage = "";
      authMode = button.dataset.authMode;
      renderAuthBody();
    });
  }
}

function authBusy(form, label) {
  const button = form.querySelector('button[type="submit"]');
  if (button) {
    button.disabled = true;
    button.dataset.label = button.textContent;
    button.textContent = label;
  }
}

function authError(message) {
  pendingAuthMessage = message;
  renderAuthBody();
}

async function handleSignup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  authBusy(form, "Waiting for your device…");
  try {
    const options = await api("/api/auth/register/options", {
      method: "POST",
      body: { handle: data.handle, displayName: data.displayName, city: data.city },
    });
    const credential = await createPasskey(options.options);
    const result = await api("/api/auth/register/verify", {
      method: "POST",
      body: { challengeId: options.challengeId, response: registrationJSON(credential) },
    });
    authMode = "recovery-code";
    pendingAuthMessage = result.recoveryCode;
    renderAuthBody();
  } catch (error) {
    authError(friendlyAuthError(error));
  }
}

async function handleSignin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  authBusy(form, "Waiting for your device…");
  try {
    const options = await api("/api/auth/login/options", { method: "POST", body: { handle: data.handle } });
    const credential = await getPasskey(options.options);
    await api("/api/auth/login/verify", {
      method: "POST",
      body: { challengeId: options.challengeId, response: authenticationJSON(credential) },
    });
    authDialog.close();
    window.location.reload();
  } catch (error) {
    authError(friendlyAuthError(error));
  }
}

async function handleRecovery(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  authBusy(form, "Checking…");
  try {
    const options = await api("/api/auth/recovery/options", {
      method: "POST",
      body: { handle: data.handle, code: data.code },
    });
    const credential = await createPasskey(options.options);
    const result = await api("/api/auth/recovery/verify", {
      method: "POST",
      body: { challengeId: options.challengeId, response: registrationJSON(credential) },
    });
    authMode = "recovery-code";
    pendingAuthMessage = result.recoveryCode;
    renderAuthBody();
  } catch (error) {
    authError(friendlyAuthError(error));
  }
}

function friendlyAuthError(error) {
  if (error.name === "NotAllowedError") return "The passkey prompt was cancelled or timed out.";
  if (error.name === "InvalidStateError") return "This device already has a passkey for that account.";
  return error.message || "Something went wrong.";
}

export function requireAuth(message = "Sign in to keep a shelf and follow bookshops.") {
  if (state.me?.user) return true;
  openAuth("signin", message);
  return false;
}

/* ------------------------------------------------------------------- init */

export async function boot() {
  await Promise.all([loadConfig(), loadMe()]);
  renderHeader();
}
