import {
  api,
  boot,
  cityName,
  escapeHtml,
  formatDate,
  initials,
  openAuth,
  relativeDays,
  signOut,
  state,
  tagEmoji,
  tagLabel,
  toast,
} from "./core.js";

const signedOut = document.querySelector("#signed-out");
const app = document.querySelector("#account-app");
const friendDialog = document.querySelector("#friend-dialog");
const friendDetail = document.querySelector("#friend-detail");

const STATUS_LABEL = { want: "Want to read", reading: "Reading", read: "Read" };

function showSignedOut() {
  signedOut.hidden = false;
  app.hidden = true;
}

function showAccount() {
  signedOut.hidden = true;
  app.hidden = false;
  const user = state.me.user;
  document.querySelector("#identity-avatar").textContent = initials(user.displayName);
  document.querySelector("#identity-name").textContent = user.displayName;
  document.querySelector("#identity-handle").textContent = `@${user.handle}`;
  document.querySelector("#identity-city").textContent = user.city ? cityName(user.city) : "";
  document.querySelector("#count-shelf").textContent = state.me.counts.shelf || "";
  document.querySelector("#count-friends").textContent = state.me.counts.friends || "";
}

/* ------------------------------------------------------------------ tabs */

function showTab(name) {
  for (const panel of document.querySelectorAll(".tab-panel")) panel.hidden = panel.id !== `tab-${name}`;
  for (const button of document.querySelectorAll(".account-nav-item")) {
    button.setAttribute("aria-current", String(button.dataset.tab === name));
  }
  if (window.location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
}

for (const button of document.querySelectorAll(".account-nav-item")) {
  button.addEventListener("click", () => showTab(button.dataset.tab));
}
for (const button of document.querySelectorAll("[data-tab-jump]")) {
  button.addEventListener("click", () => showTab(button.dataset.tabJump));
}

/* ----------------------------------------------------------------- shelf */

function bookCard(book) {
  return `
    <article class="shelf-card">
      ${book.coverUrl ? `<img class="book-cover" src="${escapeHtml(book.coverUrl)}" alt="Cover of ${escapeHtml(book.title)}" loading="lazy">` : '<div class="book-cover book-cover-empty">📕</div>'}
      <div class="shelf-card-body">
        <h3>${escapeHtml(book.title)}</h3>
        <p class="rec-meta">${escapeHtml(book.author || "Unknown author")}</p>
        <div class="shelf-controls">
          <label class="field field-mini"><span class="visually-hidden">Reading status</span>
            <select data-status="${escapeHtml(book.id)}">
              ${Object.entries(STATUS_LABEL)
                .map(([value, label]) => `<option value="${value}" ${book.status === value ? "selected" : ""}>${label}</option>`)
                .join("")}
            </select>
          </label>
          <label class="field field-mini"><span class="visually-hidden">Rating</span>
            <select data-rating="${escapeHtml(book.id)}">
              <option value="">Rating</option>
              ${[5, 4, 3, 2, 1].map((value) => `<option value="${value}" ${book.rating === value ? "selected" : ""}>${"★".repeat(value)}</option>`).join("")}
            </select>
          </label>
          <button class="link-button remove-book" type="button" data-remove="${escapeHtml(book.id)}">Remove</button>
        </div>
      </div>
    </article>`;
}

async function loadShelf() {
  const list = document.querySelector("#shelf-list");
  try {
    const { shelf } = await api("/api/shelf");
    document.querySelector("#shelf-count").textContent = `${shelf.length} book${shelf.length === 1 ? "" : "s"}`;
    if (!shelf.length) {
      list.innerHTML = '<p class="muted empty-note">Nothing here yet. Search above, or add a book from a shop you follow.</p>';
      return;
    }
    list.innerHTML = shelf.map(bookCard).join("");
    for (const select of list.querySelectorAll("[data-status]")) {
      select.addEventListener("change", () => updateShelf(select.dataset.status, { status: select.value }));
    }
    for (const select of list.querySelectorAll("[data-rating]")) {
      select.addEventListener("change", () =>
        updateShelf(select.dataset.rating, { rating: select.value ? Number(select.value) : null }),
      );
    }
    for (const button of list.querySelectorAll("[data-remove]")) {
      button.addEventListener("click", async () => {
        await api(`/api/shelf/${encodeURIComponent(button.dataset.remove)}`, { method: "DELETE" });
        toast("Removed from your shelf");
        await loadShelf();
      });
    }
  } catch (error) {
    list.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
  }
}

async function updateShelf(bookId, changes) {
  const { shelf } = await api("/api/shelf");
  const book = shelf.find((item) => item.id === bookId);
  if (!book) return;
  await api(`/api/shelf/${encodeURIComponent(bookId)}`, {
    method: "PUT",
    body: {
      status: changes.status ?? book.status,
      rating: changes.rating === undefined ? book.rating : changes.rating,
      note: book.note,
      title: book.title,
      author: book.author,
      coverUrl: book.coverUrl,
      firstPublishYear: book.firstPublishYear,
    },
  });
  toast("Shelf updated");
  await loadShelf();
  await refreshCounts();
}

async function refreshCounts() {
  const me = await api("/api/me");
  state.me = me;
  document.querySelector("#count-shelf").textContent = me.counts.shelf || "";
  document.querySelector("#count-friends").textContent = me.counts.friends || "";
}

document.querySelector("#book-search").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = new FormData(event.currentTarget).get("q");
  const results = document.querySelector("#book-results");
  results.innerHTML = '<p class="muted">Searching the Open Library catalogue…</p>';
  try {
    const { books } = await api(`/api/books/search?q=${encodeURIComponent(query)}`);
    if (!books.length) {
      results.innerHTML = '<p class="muted">No matches. Try the author, or a shorter title.</p>';
      return;
    }
    results.innerHTML = books
      .map(
        (book) => `
        <article class="book-result">
          ${book.coverUrl ? `<img class="book-cover book-cover-sm" src="${escapeHtml(book.coverUrl)}" alt="" loading="lazy">` : '<div class="book-cover book-cover-empty book-cover-sm">📕</div>'}
          <div class="book-result-copy">
            <h4>${escapeHtml(book.title)}</h4>
            <p class="rec-meta">${escapeHtml(book.author || "Unknown author")}${book.firstPublishYear ? ` · ${book.firstPublishYear}` : ""}</p>
          </div>
          <div class="book-result-actions">
            <select data-add-status="${escapeHtml(book.id)}">
              ${Object.entries(STATUS_LABEL).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}
            </select>
            <button class="btn btn-small" type="button" data-add="${escapeHtml(book.id)}">Add</button>
          </div>
        </article>`,
      )
      .join("");
    for (const button of results.querySelectorAll("[data-add]")) {
      button.addEventListener("click", async () => {
        const id = button.dataset.add;
        const book = books.find((item) => item.id === id);
        const statusSelect = [...results.querySelectorAll("[data-add-status]")].find(
          (select) => select.dataset.addStatus === id,
        );
        const status = statusSelect ? statusSelect.value : "want";
        button.disabled = true;
        try {
          await api(`/api/shelf/${encodeURIComponent(id)}`, {
            method: "PUT",
            body: {
              status,
              title: book.title,
              author: book.author,
              coverUrl: book.coverUrl,
              firstPublishYear: book.firstPublishYear,
            },
          });
          toast("Added to your shelf");
          await loadShelf();
        } catch (error) {
          toast(error.message, "error");
        } finally {
          button.disabled = false;
        }
      });
    }
  } catch (error) {
    results.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
  }
});

/* --------------------------------------------------------------- friends */

async function loadFriends() {
  const [{ friends, incoming, outgoing }, { items }] = await Promise.all([api("/api/friends"), api("/api/feed")]);
  const requests = document.querySelector("#friend-requests");
  requests.innerHTML = incoming.length
    ? `<h3 class="subhead">Waiting for you</h3>${incoming
        .map(
          (friend) => `
          <div class="request-row">
            <span class="account-avatar">${escapeHtml(initials(friend.displayName))}</span>
            <span><strong>${escapeHtml(friend.displayName)}</strong> <span class="muted">@${escapeHtml(friend.handle)}</span></span>
            <span class="request-actions">
              <button class="btn btn-small" type="button" data-accept="${escapeHtml(friend.handle)}">Accept</button>
              <button class="link-button" type="button" data-decline="${escapeHtml(friend.handle)}">Ignore</button>
            </span>
          </div>`,
        )
        .join("")}`
    : "";

  const list = document.querySelector("#friend-list");
  const pendingOut = outgoing.length
    ? `<p class="muted">Waiting on ${outgoing.map((friend) => `@${escapeHtml(friend.handle)}`).join(", ")}.</p>`
    : "";
  list.innerHTML = friends.length
    ? `${friends
        .map(
          (friend) => `
          <button class="friend-card" type="button" data-friend="${escapeHtml(friend.handle)}">
            <span class="account-avatar">${escapeHtml(initials(friend.displayName))}</span>
            <span><strong>${escapeHtml(friend.displayName)}</strong><small>@${escapeHtml(friend.handle)}${friend.city ? ` · ${escapeHtml(cityName(friend.city))}` : ""}</small></span>
          </button>`,
        )
        .join("")}${pendingOut}`
    : `<p class="muted empty-note">No friends yet. Share your handle, or add someone you met at a reading.</p>${pendingOut}`;

  for (const button of requests.querySelectorAll("[data-accept]")) {
    button.addEventListener("click", () => friendAction(button.dataset.accept, "accept"));
  }
  for (const button of requests.querySelectorAll("[data-decline]")) {
    button.addEventListener("click", () => friendAction(button.dataset.decline, "decline"));
  }
  for (const button of list.querySelectorAll("[data-friend]")) {
    button.addEventListener("click", () => openFriend(button.dataset.friend));
  }

  const feed = document.querySelector("#feed");
  feed.innerHTML = items.length
    ? items
        .map((item) =>
          item.type === "shelf"
            ? `<div class="feed-item">
                <span class="account-avatar">${escapeHtml(initials(item.displayName))}</span>
                <p><strong>${escapeHtml(item.displayName)}</strong> put <em>${escapeHtml(item.book.title)}</em> on their ${escapeHtml(STATUS_LABEL[item.status] || "shelf").toLowerCase()} list</p>
                <span class="feed-time">${escapeHtml(relativeDays(item.at))}</span>
              </div>`
            : `<div class="feed-item">
                <span class="account-avatar">${escapeHtml(initials(item.displayName))}</span>
                <p><strong>${escapeHtml(item.displayName)}</strong> is going to <em>${escapeHtml(item.event.title)}</em>${item.event.storeName ? ` at ${escapeHtml(item.event.storeName)}` : ""}</p>
                <span class="feed-time">${escapeHtml(relativeDays(item.at))}</span>
              </div>`,
        )
        .join("")
    : '<p class="muted empty-note">Add a friend to see what they are reading.</p>';
}

async function friendAction(handle, action) {
  try {
    await api(`/api/friends/${encodeURIComponent(handle)}/${action}`, { method: "POST" });
    toast(action === "accept" ? "Friend added" : "Request ignored");
    await loadFriends();
    await refreshCounts();
  } catch (error) {
    toast(error.message, "error");
  }
}

document.querySelector("#friend-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const handle = new FormData(event.currentTarget).get("handle");
  try {
    const result = await api("/api/friends", { method: "POST", body: { handle } });
    toast(result.status === "accepted" ? "You are friends now" : "Request sent");
    event.currentTarget.reset();
    await loadFriends();
  } catch (error) {
    toast(error.message, "error");
  }
});

async function openFriend(handle) {
  friendDetail.innerHTML = '<p class="muted">Opening their shelf…</p>';
  if (!friendDialog.open) friendDialog.showModal();
  try {
    const data = await api(`/api/users/${encodeURIComponent(handle)}`);
    friendDetail.innerHTML = `
      <p class="eyebrow">Reader</p>
      <h2 class="detail-title">${escapeHtml(data.user.displayName)}</h2>
      <p class="detail-meta">@${escapeHtml(data.user.handle)}${data.user.city ? ` · ${escapeHtml(cityName(data.user.city))}` : ""}</p>
      ${data.user.bio ? `<p class="dialog-copy">${escapeHtml(data.user.bio)}</p>` : ""}
      <p class="muted">${data.shelfCount} book${data.shelfCount === 1 ? "" : "s"} on the shelf</p>
      ${
        data.canSeeShelf
          ? `<div class="shelf-grid">${data.shelf
              .map(
                (book) => `<article class="shelf-card">
                  ${book.coverUrl ? `<img class="book-cover" src="${escapeHtml(book.coverUrl)}" alt="" loading="lazy">` : '<div class="book-cover book-cover-empty">📕</div>'}
                  <div class="shelf-card-body"><h3>${escapeHtml(book.title)}</h3>
                  <p class="rec-meta">${escapeHtml(book.author || "Unknown author")}</p>
                  <p class="rec-meta">${escapeHtml(STATUS_LABEL[book.status] || book.status)}${book.rating ? ` · ${"★".repeat(book.rating)}` : ""}</p></div>
                </article>`,
              )
              .join("")}</div>`
          : '<p class="muted">Their shelf is private.</p>'
      }
      ${data.favoriteStores.length ? `<h3 class="subhead">Bookshops they follow</h3><p class="muted">${data.favoriteStores.map((store) => escapeHtml(store.name)).join(" · ")}</p>` : ""}`;
  } catch (error) {
    friendDetail.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
  }
}

friendDialog.addEventListener("click", (event) => {
  if (event.target === friendDialog || event.target.closest("[data-friend-close]")) friendDialog.close();
});

/* --------------------------------------------------------------- for you */

async function loadRecommendations() {
  const storeWrap = document.querySelector("#account-rec-stores");
  const bookWrap = document.querySelector("#account-rec-books");
  try {
    const data = await api("/api/recommendations");
    storeWrap.innerHTML = data.stores.length
      ? data.stores
          .map(
            (store) => `<article class="rec-card">
              <p class="rec-reason">${escapeHtml(store.reason)}</p>
              <h3>${escapeHtml(store.name)}</h3>
              <p class="rec-meta">${escapeHtml(store.neighborhood || cityName(store.city))}${store.upcoming ? ` · ${store.upcoming} upcoming` : ""}</p>
              <a class="event-link" href="/#cities">Find it ↗</a>
            </article>`,
          )
          .join("")
      : `<p class="muted">Follow a shop or add genres below, and matches show up here.</p>`;
    bookWrap.innerHTML = data.books.length
      ? data.books
          .map(
            (book) => `<article class="book-card">
              ${book.coverUrl ? `<img class="book-cover" src="${escapeHtml(book.coverUrl)}" alt="" loading="lazy">` : '<div class="book-cover book-cover-empty">📕</div>'}
              <div><h4>${escapeHtml(book.title)}</h4>
              <p class="rec-meta">${escapeHtml(book.author || "Unknown author")}</p>
              <p class="rec-reason">${escapeHtml(book.reason)}</p></div>
            </article>`,
          )
          .join("")
      : `<p class="muted">${data.needsGenres ? "Pick a genre in settings to get book ideas." : "No book ideas yet."}</p>`;
  } catch (error) {
    storeWrap.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
  }
}

/* -------------------------------------------------------------- settings */

function renderGenres(selected) {
  const wrap = document.querySelector("#genre-chips");
  wrap.innerHTML = state.config.genres
    .map(
      (genre) => `<button class="genre-chip" type="button" data-genre="${escapeHtml(genre)}" aria-pressed="${selected.includes(genre)}">${escapeHtml(genre)}</button>`,
    )
    .join("");
  for (const button of wrap.querySelectorAll("[data-genre]")) {
    button.addEventListener("click", async () => {
      const current = new Set(
        [...wrap.querySelectorAll('[aria-pressed="true"]')].map((chip) => chip.dataset.genre),
      );
      if (current.has(button.dataset.genre)) current.delete(button.dataset.genre);
      else if (current.size < 6) current.add(button.dataset.genre);
      await api("/api/me/genres", { method: "PUT", body: { genres: [...current] } });
      renderGenres([...current]);
      await loadRecommendations();
    });
  }
}

function fillSettings() {
  const user = state.me.user;
  const form = document.querySelector("#settings-form");
  form.displayName.value = user.displayName || "";
  form.city.innerHTML = state.config.cities
    .map((city) => `<option value="${city.id}" ${city.id === user.city ? "selected" : ""}>${escapeHtml(city.name)}</option>`)
    .join("");
  form.bio.value = user.bio || "";
  form.shelfVisibility.value = user.shelfVisibility || "friends";
  renderGenres(state.me.genres || []);
}

document.querySelector("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = await api("/api/me", {
      method: "PATCH",
      body: {
        displayName: form.displayName.value,
        city: form.city.value,
        bio: form.bio.value,
        shelfVisibility: form.shelfVisibility.value,
      },
    });
    state.me.user = result.user;
    showAccount();
    toast("Saved");
  } catch (error) {
    toast(error.message, "error");
  }
});

document.querySelector("#recovery-help").addEventListener("click", () => openAuth("recovery"));

document.querySelector("#sign-out").addEventListener("click", signOut);

/* ------------------------------------------------------------------ init */

await boot();

if (!state.me?.user) {
  showSignedOut();
} else {
  showAccount();
  await Promise.all([loadShelf(), loadFriends(), loadRecommendations()]);
  fillSettings();
  const hash = window.location.hash.replace("#", "");
  showTab(["shelf", "friends", "for-you", "settings"].includes(hash) ? hash : "shelf");
}

document.querySelector("#guest-signin").addEventListener("click", () => openAuth("signin"));
document.querySelector("#guest-signup").addEventListener("click", () => openAuth("signup"));
