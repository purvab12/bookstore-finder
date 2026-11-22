import {
  api,
  boot,
  cityName,
  escapeHtml,
  formatDate,
  formatTime,
  openAuth,
  relativeDays,
  requireAuth,
  state,
  toast,
} from "./core.js";

const citySelect = document.querySelector("#event-city");
const listEl = document.querySelector("#event-listings");
const countEl = document.querySelector("#event-count");
const statusEl = document.querySelector("#event-status");
const dateInput = document.querySelector("#specific-date");
const dateChips = [...document.querySelectorAll(".date-chip")];
const submitDialog = document.querySelector("#submit-dialog");
const submitForm = document.querySelector("#submit-form");
const submitCity = document.querySelector("#submit-city");
const submitStore = document.querySelector("#submit-store");
const submitKind = document.querySelector("#submit-kind");

let events = [];
let activeRange = "all";

const today = new Date();
today.setHours(0, 0, 0, 0);

function dateKey(date) {
  return new Date(date).toLocaleDateString("en-CA");
}

function filtered() {
  const city = citySelect.value;
  const day = dateInput.value;
  const end = activeRange === "all" ? null : new Date(today.getTime() + Number(activeRange) * 86400000 + 86400000);
  return events
    .filter((event) => city === "all" || event.store?.city === city)
    .filter((event) => {
      const start = new Date(event.startsAt);
      if (day) return dateKey(start) === day;
      return !end || start <= end;
    })
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
}

function render() {
  const visible = filtered();
  countEl.textContent = `${visible.length} event${visible.length === 1 ? "" : "s"}`;
  if (!visible.length) {
    listEl.innerHTML = `
      <div class="event-empty">
        <span aria-hidden="true">📚</span>
        <h3>No events on that day yet</h3>
        <p>Try a wider date range, another city, or <button class="link-button" type="button" data-open-submit>post one yourself</button>.</p>
      </div>`;
    listEl.querySelector("[data-open-submit]")?.addEventListener("click", openSubmit);
    return;
  }

  listEl.innerHTML = visible
    .map(
      (event) => `
      <article class="event-card">
        <div class="event-date-tile">
          <span>${escapeHtml(relativeDays(event.startsAt))}</span>
          <strong>${escapeHtml(formatTime(event.startsAt))}</strong>
        </div>
        <div class="event-card-copy">
          <div class="event-card-meta">
            <span class="event-kind">${escapeHtml(event.kind)}</span>
            ${event.rsvpCount ? `<span class="rsvp-count">${event.rsvpCount} going</span>` : ""}
          </div>
          <h3>${escapeHtml(event.title)}</h3>
          <p class="event-venue">
            ${event.store ? `<button class="link-button" type="button" data-store-city="${escapeHtml(event.store.city)}">${escapeHtml(event.store.name)}</button> <span>·</span> ${escapeHtml(event.store.neighborhood || cityName(event.store.city))}` : "Bookshop to be confirmed"}
          </p>
          ${event.description ? `<p class="event-desc">${escapeHtml(event.description)}</p>` : ""}
          <div class="event-actions">
            <button class="btn btn-small ${event.going ? "btn-following" : ""}" type="button" data-rsvp="${escapeHtml(event.id)}">
              ${event.going ? "Going ✓" : "I'm going"}
            </button>
            ${event.url ? `<a class="event-link" href="${escapeHtml(event.url)}" target="_blank" rel="noreferrer">Details ↗</a>` : ""}
            <span class="event-source">${escapeHtml(formatDate(event.startsAt))}${event.source ? ` · via ${escapeHtml(event.source)}` : ""}</span>
          </div>
        </div>
        <span class="event-card-arrow" aria-hidden="true">↗</span>
      </article>`,
    )
    .join("");

  for (const button of listEl.querySelectorAll("[data-rsvp]")) {
    button.addEventListener("click", () => toggleRsvp(button.dataset.rsvp, button));
  }
  for (const button of listEl.querySelectorAll("[data-store-city]")) {
    button.addEventListener("click", () => {
      citySelect.value = button.dataset.storeCity;
      render();
    });
  }
}

async function toggleRsvp(id, button) {
  if (!requireAuth("Sign in to save events you're going to.")) return;
  const event = events.find((item) => item.id === id);
  if (!event) return;
  button.disabled = true;
  try {
    const result = await api(`/api/events/${encodeURIComponent(id)}/rsvp`, {
      method: event.going ? "DELETE" : "POST",
    });
    event.going = result.going;
    event.rsvpCount = result.rsvpCount;
    render();
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
  }
}

function setRange(range) {
  activeRange = range;
  dateInput.value = "";
  for (const chip of dateChips) chip.setAttribute("aria-pressed", String(chip.dataset.range === range));
  render();
}

async function loadEvents() {
  statusEl.textContent = "Loading events…";
  try {
    const data = await api("/api/events?limit=200");
    events = data.events;
    statusEl.textContent = "";
    render();
  } catch (error) {
    statusEl.textContent = `Events could not load: ${error.message}. The rest of the site still works.`;
    listEl.innerHTML = "";
  }
}

/* ----------------------------------------------------------- submitting */

async function loadSubmitStores(city) {
  submitStore.innerHTML = '<option value="">Loading shops…</option>';
  try {
    const data = await api(`/api/stores?city=${encodeURIComponent(city)}&limit=200`);
    submitStore.innerHTML = data.stores
      .map((store) => `<option value="${escapeHtml(store.id)}">${escapeHtml(store.name)} — ${escapeHtml(store.neighborhood || cityName(store.city))}</option>`)
      .join("");
    if (!data.stores.length) submitStore.innerHTML = '<option value="">No shops found</option>';
  } catch {
    submitStore.innerHTML = '<option value="">Shops could not load</option>';
  }
}

function openSubmit() {
  if (!submitDialog.open) submitDialog.showModal();
  if (submitCity.options.length && !submitCity.value) {
    submitCity.value = state.me?.user?.city || state.config.cities[0].id;
  }
  loadSubmitStores(submitCity.value || state.config.cities[0].id);
}

submitForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(submitForm));
  const button = submitForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api("/api/events", {
      method: "POST",
      body: {
        storeId: data.storeId,
        title: data.title,
        kind: data.kind,
        startsAt: new Date(data.startsAt).toISOString(),
        endsAt: data.endsAt ? new Date(data.endsAt).toISOString() : null,
        url: data.url || null,
        description: data.description || null,
      },
    });
    submitForm.reset();
    submitDialog.close();
    toast(result.message || "Sent for review");
    await loadEvents();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

submitCity.addEventListener("change", () => loadSubmitStores(submitCity.value));

for (const button of document.querySelectorAll("#open-submit, #open-submit-2")) {
  button.addEventListener("click", openSubmit);
}

/* ------------------------------------------------------------------ init */

await boot();

citySelect.innerHTML = `<option value="all">All three cities</option>${state.config.cities
  .map((city) => `<option value="${city.id}">${escapeHtml(city.name)}</option>`)
  .join("")}`;
submitCity.innerHTML = state.config.cities
  .map((city) => `<option value="${city.id}">${escapeHtml(city.name)}</option>`)
  .join("");
submitKind.innerHTML = state.config.eventKinds.map((kind) => `<option>${escapeHtml(kind)}</option>`).join("");
dateInput.min = dateKey(today);

const params = new URLSearchParams(window.location.search);
if (params.get("store")) {
  openSubmit();
  loadSubmitStores(params.get("city") || state.config.cities[0].id);
}

for (const chip of dateChips) chip.addEventListener("click", () => setRange(chip.dataset.range));
citySelect.addEventListener("change", render);
dateInput.addEventListener("change", () => {
  if (!dateInput.value) {
    setRange("all");
    return;
  }
  activeRange = "all";
  for (const chip of dateChips) chip.setAttribute("aria-pressed", "false");
  render();
});

document.addEventListener("click", (event) => {
  if (event.target === submitDialog || event.target.closest("[data-submit-close]")) submitDialog.close();
});

await loadEvents();
