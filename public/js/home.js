import {
  api,
  boot,
  cityName,
  escapeHtml,
  formatDateTime,
  openAuth,
  relativeDays,
  requireAuth,
  saveStaffPick,
  state,
  tagEmoji,
  tagLabel,
  toast,
} from "./core.js";

const cityList = document.querySelector("#city-list");
const explorer = document.querySelector("#explorer");
const explorerTitle = document.querySelector("#explorer-title");
const statusMessage = document.querySelector("#status");
const resultsCount = document.querySelector("#results-count");
const storeList = document.querySelector("#store-list");
const searchInput = document.querySelector("#search");
const tabsEl = document.querySelector(".vibe-tabs");
const vibeOptions = document.querySelector("#vibe-options");
const selectedVibes = document.querySelector("#selected-vibes");
const storeDialog = document.querySelector("#store-dialog");
const storeDetail = document.querySelector("#store-detail");
const picksSection = document.querySelector("#picks-section");
const picksTitle = document.querySelector("#picks-title");
const cityPicks = document.querySelector("#city-picks");

let activeCity = null;
let cityStores = [];
let activeCategory = "selection";
let map = null;
let markersLayer = null;
const selectedTags = new Map();

function markerColor(store) {
  return store.isIndie ? "#ff654d" : "#8d867c";
}

function ensureMap() {
  if (map) return map;
  if (!window.L) {
    document.querySelector("#map").innerHTML =
      '<p class="map-fallback">The map could not load. The list still has every bookshop.</p>';
    return null;
  }
  map = L.map("map", { scrollWheelZoom: false });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  markersLayer = L.featureGroup().addTo(map);
  return map;
}

function renderCities() {
  const cities = state.config.cities;
  cityList.innerHTML = cities
    .map(
      (city, index) => `
      <button class="city-card" type="button" data-city="${city.id}" aria-pressed="false">
        <span class="city-card-top">
          <span class="city-index">CITY 0${index + 1} · ${escapeHtml(city.region.toUpperCase())}</span>
          <span class="city-icon" aria-hidden="true">${["✳", "✷", "✦"][index % 3]}</span>
        </span>
        <span class="city-card-bottom">
          <span>
            <span class="city-name">${escapeHtml(city.name)}</span>
            <span class="city-caption">${city.id === "singapore" ? "Little hideaways and late-night shelves" : city.id === "chicago" ? "Neighbourhood shops with big opinions" : "Big city, tiny bookshop energy"}</span>
          </span>
          <span class="city-arrow" aria-hidden="true">↗</span>
        </span>
      </button>`,
    )
    .join("");
  for (const button of cityList.querySelectorAll(".city-card")) {
    button.addEventListener("click", () => loadCity(button.dataset.city));
  }
}

function buildTagState() {
  for (const category of Object.keys(state.config.tagGroups)) selectedTags.set(category, new Set());
}

function renderTabs() {
  const entries = Object.entries(state.config.tagGroups);
  tabsEl.innerHTML = entries
    .map(
      ([category, tags], index) => `
      <button class="vibe-tab" type="button" role="tab" data-category="${category}"
        aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">
        ${category === "selection" ? "📚" : category === "atmosphere" ? "☁️" : category === "experience" ? "✨" : "🧭"}
        ${category[0].toUpperCase()}${category.slice(1)}
      </button>`,
    )
    .join("");
  const tabs = [...tabsEl.querySelectorAll(".vibe-tab")];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => setCategory(tab.dataset.category));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      setCategory(tabs[next].dataset.category);
    });
  });
}

function setCategory(category) {
  activeCategory = category;
  for (const tab of tabsEl.querySelectorAll(".vibe-tab")) {
    const selected = tab.dataset.category === category;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  renderVibeOptions();
}

function renderVibeOptions() {
  vibeOptions.replaceChildren();
  vibeOptions.setAttribute("aria-labelledby", `tab-${activeCategory}`);
  const selected = selectedTags.get(activeCategory) || new Set();
  for (const tag of state.config.tagGroups[activeCategory]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vibe-chip";
    button.dataset.tag = tag.id;
    button.setAttribute("aria-pressed", String(selected.has(tag.id)));
    button.innerHTML = `<span aria-hidden="true">${escapeHtml(tag.emoji)}</span> ${escapeHtml(tag.label)}<span class="chip-check" aria-hidden="true">${selected.has(tag.id) ? "✓" : "+"}</span>`;
    button.addEventListener("click", () => {
      const set = selectedTags.get(activeCategory);
      if (set.has(tag.id)) set.delete(tag.id);
      else set.add(tag.id);
      renderVibeOptions();
      renderSelectedVibes();
      renderResults();
    });
    vibeOptions.append(button);
  }
}

function renderSelectedVibes() {
  const selections = [];
  for (const [category, values] of selectedTags) {
    for (const tag of values) selections.push({ category, tag });
  }
  if (!selections.length) {
    selectedVibes.innerHTML = '<span class="selected-prompt">Your picks will show up here</span>';
    return;
  }
  selectedVibes.innerHTML = selections
    .map(
      ({ category, tag }) =>
        `<button class="selected-chip" type="button" data-remove-tag="${tag}" data-category="${category}" aria-label="Remove ${escapeHtml(tagLabel(tag))} filter">
          ${escapeHtml(tagEmoji(tag))} ${escapeHtml(tagLabel(tag))} <span aria-hidden="true">×</span>
        </button>`,
    )
    .join("");
  for (const button of selectedVibes.querySelectorAll("[data-remove-tag]")) {
    button.addEventListener("click", () => {
      selectedTags.get(button.dataset.category).delete(button.dataset.removeTag);
      renderVibeOptions();
      renderSelectedVibes();
      renderResults();
    });
  }
}

function matchingStores() {
  const query = searchInput.value.trim().toLowerCase();
  const chosen = [...selectedTags.entries()].filter(([, values]) => values.size > 0);
  return cityStores.filter((store) => {
    if (query) {
      const haystack = `${store.name} ${store.address || ""} ${store.neighborhood || ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return chosen.every(([category, values]) => {
      const tags = new Set([
        ...store.tags.map((tag) => tag.tag),
        ...store.vibes.map((vibe) => vibe.tag),
      ]);
      return [...values].some((tag) => tags.has(tag));
    });
  });
}

function storePills(store) {
  const community = new Map(store.vibes.map((vibe) => [vibe.tag, vibe.count]));
  const tags = [
    ...store.tags.map((tag) => tag.tag),
    ...[...community.keys()].sort((a, b) => community.get(b) - community.get(a)),
  ];
  return [...new Set(tags)]
    .slice(0, 3)
    .map((tag) => `<span class="store-tag">${escapeHtml(tagEmoji(tag))} ${escapeHtml(tagLabel(tag))}</span>`)
    .join("");
}

function renderResults() {
  if (!activeCity) return;
  const visible = matchingStores();
  const hasFilters = searchInput.value.trim() || [...selectedTags.values()].some((set) => set.size);
  resultsCount.textContent = hasFilters
    ? `${visible.length} of ${cityStores.length} bookshops`
    : `${cityStores.length} independent bookshops to explore`;
  statusMessage.textContent = visible.length ? "" : "Nothing matches that combination yet. Try one less vibe.";

  storeList.innerHTML = "";
  for (const store of visible) {
    const item = document.createElement("li");
    item.className = "store-item";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "store-button";
    button.dataset.storeId = store.id;
    button.innerHTML = `
      <span class="store-card-heading">
        <span class="store-name">${escapeHtml(store.name)}</span>
        <span class="store-badge">${store.isIndie ? "Indie" : "Chain"}</span>
      </span>
      <span class="store-address">${escapeHtml(store.neighborhood || store.address || cityName(store.city))}</span>
      <span class="store-tags">${storePills(store)}</span>`;
    button.addEventListener("click", () => openStore(store.id));
    item.append(button);
    storeList.append(item);
  }

  if (!markersLayer) return;
  markersLayer.clearLayers();
  for (const store of visible) {
    const marker = L.circleMarker([store.lat, store.lon], {
      radius: 8,
      color: "#fff9ee",
      weight: 2,
      fillColor: markerColor(store),
      fillOpacity: 1,
    });
    marker.bindPopup(`<strong>${escapeHtml(store.name)}</strong><br>${escapeHtml(store.neighborhood || "")}`);
    marker.on("click", () => openStore(store.id));
    marker.addTo(markersLayer);
  }
  if (visible.length > 1) map.fitBounds(markersLayer.getBounds().pad(0.18), { maxZoom: 14 });
  else if (visible.length === 1) map.setView([visible[0].lat, visible[0].lon], 15);
  else map.setView(state.config.cities.find((city) => city.id === activeCity).center, 12);
}

async function loadCity(cityId) {
  activeCity = cityId;
  const city = state.config.cities.find((item) => item.id === cityId);
  explorer.hidden = false;
  explorerTitle.textContent = `Bookshops in ${city.name}`;
  resultsCount.textContent = "Finding bookshops…";
  statusMessage.textContent = "";
  searchInput.value = "";
  searchInput.disabled = false;
  for (const set of selectedTags.values()) set.clear();
  renderVibeOptions();
  renderSelectedVibes();
  for (const button of cityList.querySelectorAll(".city-card")) {
    button.setAttribute("aria-pressed", String(button.dataset.city === cityId));
  }

  loadCityPicks(cityId);

  // The map must exist before results render, or there is no layer for the pins.
  const instance = ensureMap();
  if (instance) {
    instance.setView(city.center, city.zoom);
    requestAnimationFrame(() => instance.invalidateSize());
  }

  try {
    const data = await api(`/api/stores?city=${encodeURIComponent(cityId)}&limit=200`);
    cityStores = data.stores;
    renderResults();
  } catch (error) {
    cityStores = [];
    resultsCount.textContent = "Bookshops could not load";
    statusMessage.textContent = error.message;
    storeList.innerHTML = "";
    return;
  }

  explorer.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ------------------------------------------------------------ staff picks */

function pickCard(pick) {
  const store = pick.store;
  return `
    <article class="pick-card">
      <p class="pick-shop">
        <a class="link-button" href="/shop/${encodeURIComponent(store.id)}">${escapeHtml(store.name)}</a>
        <span>${escapeHtml(store.neighborhood || cityName(store.city))}</span>
      </p>
      <h3 class="pick-title">${escapeHtml(pick.title)}</h3>
      ${pick.author ? `<p class="pick-author">by ${escapeHtml(pick.author)}</p>` : ""}
      <p class="pick-note">“${escapeHtml(pick.note)}”</p>
      <div class="pick-actions">
        <button class="btn btn-small ${pick.saved ? "btn-following" : ""}" type="button" data-save-pick="${escapeHtml(pick.id)}" aria-label="Save ${escapeHtml(pick.title)} to your shelf" ${pick.saved ? "disabled" : ""}>
          ${pick.saved ? "On your shelf ✓" : "Save to shelf"}
        </button>
      </div>
      <p class="pick-credit">
        ${pick.bookseller ? `${escapeHtml(pick.bookseller)} · ` : ""}${pick.source === "editor" ? "bookloop pick" : "shop pick"}
        ${pick.sourceUrl ? ` · <a href="${escapeHtml(pick.sourceUrl)}" target="_blank" rel="noreferrer">source</a>` : ""}
      </p>
    </article>`;
}

async function loadCityPicks(cityId) {
  const city = state.config.cities.find((item) => item.id === cityId);
  picksTitle.textContent = `Picked by booksellers in ${city.name}.`;
  picksSection.hidden = true;
  cityPicks.innerHTML = "";
  try {
    const { picks } = await api(`/api/staff-picks?city=${encodeURIComponent(cityId)}&limit=6`);
    if (activeCity !== cityId) return;
    picksSection.hidden = false;
    if (!picks.length) {
      cityPicks.innerHTML = `<p class="pick-empty">No staff picks in ${escapeHtml(city.name)} yet. If you run a shop, <a href="#bookshops">claim it</a> and add the book you are hand-selling this week.</p>`;
      return;
    }
    cityPicks.innerHTML = picks.map(pickCard).join("");
    for (const button of cityPicks.querySelectorAll("[data-save-pick]")) {
      button.addEventListener("click", () => saveStaffPick(button.dataset.savePick, button));
    }
  } catch {
    picksSection.hidden = true;
  }
}

/* ------------------------------------------------------------- store view */

async function openStore(id) {
  storeDetail.innerHTML = '<p class="detail-loading">Opening the shop…</p>';
  if (!storeDialog.open) storeDialog.showModal();
  try {
    const { store } = await api(`/api/stores/${encodeURIComponent(id)}`);
    renderStoreDetail(store);
  } catch (error) {
    storeDetail.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
  }
}

function renderStoreDetail(store) {
  const community = new Map(store.vibes.map((vibe) => [vibe.tag, vibe.count]));
  const official = store.tags.filter((tag) => tag.source !== "community");
  const signedIn = Boolean(state.me?.user);
  const picks = store.staffPicks || [];

  storeDetail.innerHTML = `
    <p class="eyebrow">${escapeHtml(store.neighborhood || cityName(store.city))} · ${escapeHtml(cityName(store.city))}</p>
    <h2 class="detail-title">${escapeHtml(store.name)}</h2>
    <p class="detail-meta">
      <span class="store-badge">${store.isIndie ? "Independent" : "Chain"}</span>
      ${store.claimed ? '<span class="store-badge badge-owner">Shop-claimed</span>' : ""}
      <span class="detail-source">Source: <a href="${escapeHtml(store.sourceUrl)}" target="_blank" rel="noreferrer">OpenStreetMap</a></span>
    </p>
    <div class="detail-actions">
      <button class="btn ${store.favorited ? "btn-following" : "btn-primary"}" type="button" id="follow-store">
        ${store.favorited ? "Following ✓" : "Follow this shop"}
      </button>
      <a class="btn btn-ghost" href="/shop/${encodeURIComponent(store.id)}">Full shop page ↗</a>
      <button class="btn btn-ghost" type="button" id="claim-toggle">I run this shop</button>
    </div>
    <dl class="detail-facts">
      ${store.address ? `<div><dt>Address</dt><dd>${escapeHtml(store.address)}</dd></div>` : ""}
      ${store.openingHours ? `<div><dt>Hours</dt><dd>${escapeHtml(store.openingHours)}</dd></div>` : ""}
      ${store.website ? `<div><dt>Website</dt><dd><a href="${escapeHtml(store.website)}" target="_blank" rel="noreferrer">${escapeHtml(store.website.replace(/^https?:\/\//, ""))}</a></dd></div>` : ""}
      ${store.phone ? `<div><dt>Phone</dt><dd>${escapeHtml(store.phone)}</dd></div>` : ""}
    </dl>

    <section class="detail-section">
      <h3>What readers say</h3>
      <div class="vibe-cloud">
        ${
          store.vibes.length
            ? store.vibes
                .sort((a, b) => b.count - a.count)
                .map(
                  (vibe) =>
                    `<span class="vibe-pill">${escapeHtml(tagEmoji(vibe.tag))} ${escapeHtml(tagLabel(vibe.tag))} <b>${vibe.count}</b></span>`,
                )
                .join("")
            : '<span class="muted">No reader vibes yet. Be the first.</span>'
        }
      </div>
      ${
        official.length
          ? `<p class="detail-sub">Listing details: ${official
              .map(
                (tag) =>
                  `<span class="vibe-pill vibe-official">${escapeHtml(tagEmoji(tag.tag))} ${escapeHtml(tagLabel(tag.tag))} <small>${escapeHtml(tag.source)}</small></span>`,
              )
              .join(" ")}</p>`
          : ""
      }
      ${
        signedIn
          ? `<div class="vibe-add">
              <label class="field field-inline"><span class="visually-hidden">Add a vibe</span>
                <select id="vibe-select">${Object.values(state.config.tagGroups)
                  .flat()
                  .map((tag) => `<option value="${tag.id}">${escapeHtml(tag.label)}</option>`)
                  .join("")}</select>
              </label>
              <button class="btn btn-small" type="button" id="vibe-add">Add vibe</button>
            </div>`
          : `<p class="muted"><button class="link-button" type="button" id="vibe-signin">Sign in</button> to add a vibe.</p>`
      }
    </section>

    <section class="detail-section">
      <h3>Staff picks</h3>
      ${
        picks.length
          ? `<ul class="detail-picks">${picks
              .map(
                (pick) => `<li>
                  <p class="detail-pick-title">${escapeHtml(pick.title)}${pick.author ? ` <small>by ${escapeHtml(pick.author)}</small>` : ""}</p>
                  <p class="detail-pick-note">“${escapeHtml(pick.note)}”</p>
                  <p class="detail-pick-credit">${pick.bookseller ? `${escapeHtml(pick.bookseller)} · ` : ""}${pick.source === "editor" ? "bookloop pick" : "shop pick"}${pick.section ? ` · ${escapeHtml(pick.section)}` : ""}</p>
                  <p><button class="btn btn-small ${pick.saved ? "btn-following" : ""}" type="button" data-save-pick="${escapeHtml(pick.id)}" aria-label="Save ${escapeHtml(pick.title)} to your shelf" ${pick.saved ? "disabled" : ""}>${pick.saved ? "On your shelf ✓" : "Save to shelf"}</button></p>
                </li>`,
              )
              .join("")}</ul>`
          : '<p class="muted">No staff picks yet. They are hand-sells, not ratings: one book, one sentence from someone who works here.</p>'
      }
      ${
        store.canManagePicks
          ? `<p class="pick-pending">${store.pendingPickCount ? `${store.pendingPickCount} pick${store.pendingPickCount === 1 ? "" : "s"} waiting for review. ` : ""}New picks appear after a quick review.</p>
            <details class="pick-form-wrap">
              <summary>Add a staff pick</summary>
              <p class="muted">One book, one sentence on why you love it. A person checks it before it appears.</p>
              <form id="pick-form" class="stack-form">
                <label class="field"><span>Book title</span>
                  <input name="title" required maxlength="200" placeholder="The book you are hand-selling">
                </label>
                <label class="field"><span>Author (optional)</span>
                  <input name="author" maxlength="160">
                </label>
                <label class="field"><span>Why you love it</span>
                  <textarea name="note" required minlength="10" maxlength="280" rows="3" placeholder="One or two sentences, in your own voice."></textarea>
                </label>
                <div class="field-row">
                  <label class="field"><span>Your name</span>
                    <input name="bookseller" maxlength="80" value="${escapeHtml(state.me?.user?.displayName || "")}">
                  </label>
                  <label class="field"><span>Where it sits (optional)</span>
                    <input name="section" maxlength="60" placeholder="Poetry table, second floor">
                  </label>
                </div>
                <label class="field"><span>Link (optional)</span>
                  <input name="sourceUrl" type="url" maxlength="500" placeholder="https://yourshop.com/…">
                </label>
                <button class="btn btn-primary" type="submit">Send pick for review</button>
              </form>
            </details>`
          : ""
      }
    </section>

    <section class="detail-section">
      <h3>Coming up</h3>
      ${
        store.events.length
          ? `<ul class="detail-events">${store.events
              .map(
                (event) => `<li>
                  <span class="detail-event-date">${escapeHtml(relativeDays(event.startsAt))}</span>
                  <span><a href="${escapeHtml(event.url || `/events?store=${encodeURIComponent(store.id)}`)}"${event.url ? ' target="_blank" rel="noreferrer"' : ""}>${escapeHtml(event.title)}</a>
                  <small>${escapeHtml(event.kind)} · ${escapeHtml(formatDateTime(event.startsAt))}</small></span>
                </li>`,
              )
              .join("")}</ul>`
          : '<p class="muted">No upcoming events listed yet. Know one? <a href="/events#submit">Add it to the calendar</a>.</p>'
      }
    </section>

    <section class="detail-section claim-section" id="claim-section" hidden>
      <h3>Claim this shop</h3>
      <p class="muted">Tell us how to reach you. A person checks every claim before anything changes, and claiming is free.</p>
      <form id="claim-form" class="stack-form">
        <label class="field"><span>Email or phone</span><input name="contact" required maxlength="200" placeholder="hello@yourshop.com"></label>
        <label class="field"><span>Your role</span><input name="role" maxlength="80" placeholder="Owner, events manager, bookseller…"></label>
        <label class="field"><span>Anything we should fix?</span><textarea name="message" maxlength="600" rows="3" placeholder="Hours changed, new website, events every Thursday…"></textarea></label>
        <button class="btn btn-primary" type="submit">Send claim</button>
      </form>
    </section>`;

  const follow = storeDetail.querySelector("#follow-store");
  follow.addEventListener("click", async () => {
    if (!requireAuth("Sign in to follow bookshops.")) return;
    follow.disabled = true;
    try {
      await api(`/api/stores/${encodeURIComponent(store.id)}/favorite`, {
        method: store.favorited ? "DELETE" : "POST",
      });
      store.favorited = !store.favorited;
      toast(store.favorited ? "Following this shop" : "Unfollowed");
      renderStoreDetail(store);
    } catch (error) {
      toast(error.message, "error");
      follow.disabled = false;
    }
  });

  storeDetail.querySelector("#claim-toggle").addEventListener("click", () => {
    const section = storeDetail.querySelector("#claim-section");
    section.hidden = !section.hidden;
    if (!section.hidden) section.scrollIntoView({ behavior: "smooth", block: "end" });
  });

  storeDetail.querySelector("#claim-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const result = await api(`/api/stores/${encodeURIComponent(store.id)}/claim`, { method: "POST", body: data });
      toast(result.message);
      event.currentTarget.reset();
      storeDetail.querySelector("#claim-section").hidden = true;
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
    }
  });

  for (const button of storeDetail.querySelectorAll("[data-save-pick]")) {
    button.addEventListener("click", () => saveStaffPick(button.dataset.savePick, button));
  }

  const pickForm = storeDetail.querySelector("#pick-form");
  if (pickForm) {
    pickForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = Object.fromEntries(new FormData(form));
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const result = await api(`/api/stores/${encodeURIComponent(store.id)}/staff-picks`, {
          method: "POST",
          body: {
            title: data.title,
            author: data.author || null,
            note: data.note,
            bookseller: data.bookseller || null,
            section: data.section || null,
            sourceUrl: data.sourceUrl || null,
          },
        });
        toast(result.message);
        await openStore(store.id);
      } catch (error) {
        toast(error.message, "error");
        button.disabled = false;
      }
    });
  }

  const vibeAdd = storeDetail.querySelector("#vibe-add");
  if (vibeAdd) {
    vibeAdd.addEventListener("click", async () => {
      const tag = storeDetail.querySelector("#vibe-select").value;
      try {
        await api(`/api/stores/${encodeURIComponent(store.id)}/vibes`, { method: "POST", body: { tag } });
        const data = await api(`/api/stores/${encodeURIComponent(store.id)}`);
        renderStoreDetail(data.store);
        toast("Vibe added");
      } catch (error) {
        toast(error.message, "error");
      }
    });
  } else {
    storeDetail.querySelector("#vibe-signin")?.addEventListener("click", () => openAuth("signin"));
  }
}

/* --------------------------------------------------------------- for you */

async function renderForYou() {
  const section = document.querySelector("#for-you");
  if (!state.me?.user) {
    section.hidden = true;
    return;
  }
  try {
    const data = await api("/api/recommendations");
    section.hidden = false;
    const storeWrap = document.querySelector("#rec-stores");
    const bookWrap = document.querySelector("#rec-books");
    storeWrap.innerHTML = data.stores.length
      ? data.stores
          .map(
            (store) => `
            <article class="rec-card">
              <p class="rec-reason">${escapeHtml(store.reason)}</p>
              <h3><button class="link-button rec-name" type="button" data-open-store="${escapeHtml(store.id)}">${escapeHtml(store.name)}</button></h3>
              <p class="rec-meta">${escapeHtml(store.neighborhood || cityName(store.city))}${store.upcoming ? ` · ${store.upcoming} upcoming` : ""}</p>
              <div class="store-tags">${(store.matchedTags || []).map((tag) => `<span class="store-tag">${escapeHtml(tagEmoji(tag))} ${escapeHtml(tagLabel(tag))}</span>`).join("")}</div>
            </article>`,
          )
          .join("")
      : `<p class="muted">Follow a shop or pick a few genres in <a href="/account#settings">your settings</a> and matches show up here.</p>`;
    for (const button of storeWrap.querySelectorAll("[data-open-store]")) {
      button.addEventListener("click", () => openStore(button.dataset.openStore));
    }
    bookWrap.innerHTML = data.books.length
      ? data.books
          .map(
            (book) => `
            <article class="book-card">
              ${book.coverUrl ? `<img class="book-cover" src="${escapeHtml(book.coverUrl)}" alt="Cover of ${escapeHtml(book.title)}" loading="lazy">` : '<div class="book-cover book-cover-empty">📕</div>'}
              <div>
                <h4>${escapeHtml(book.title)}</h4>
                <p class="rec-meta">${escapeHtml(book.author || "Unknown author")}</p>
                <p class="rec-reason">${escapeHtml(book.reason)}</p>
              </div>
            </article>`,
          )
          .join("")
      : `<p class="muted">Add a genre in <a href="/account#settings">settings</a> to get book ideas from the Open Library catalogue.</p>`;
  } catch {
    section.hidden = true;
  }
}

/* ------------------------------------------------------------------ init */

await boot();
buildTagState();
renderCities();
renderTabs();
setCategory("selection");
renderSelectedVibes();
document.querySelector("#store-total").textContent = String(state.config.storeCount);
renderForYou();

searchInput.addEventListener("input", renderResults);

document.querySelector("#clear-filters").addEventListener("click", () => {
  for (const set of selectedTags.values()) set.clear();
  searchInput.value = "";
  renderVibeOptions();
  renderSelectedVibes();
  renderResults();
});

document.querySelector("#change-city").addEventListener("click", () => {
  activeCity = null;
  explorer.hidden = true;
  picksSection.hidden = true;
  cityPicks.innerHTML = "";
  if (markersLayer) markersLayer.clearLayers();
  for (const set of selectedTags.values()) set.clear();
  searchInput.value = "";
  searchInput.disabled = true;
  for (const button of cityList.querySelectorAll(".city-card")) button.setAttribute("aria-pressed", "false");
  document.querySelector(".city-section").scrollIntoView({ behavior: "smooth", block: "start" });
});

document.addEventListener("click", (event) => {
  if (event.target === storeDialog || event.target.closest("[data-store-close]")) storeDialog.close();
});

window.addEventListener("resize", () => {
  if (activeCity && map) map.invalidateSize();
});

