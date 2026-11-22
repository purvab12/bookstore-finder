import {
  currentUser,
  destroySession,
  loginOptions,
  loginVerify,
  normalizeHandle,
  publicUser,
  recoveryOptions,
  recoveryVerify,
  registerOptions,
  registerVerify,
  requireUser,
} from "./auth.js";
import { CITIES, CITY_IDS, EVENT_KINDS, GENRES, TAG_GROUPS, TAG_IDS, TAG_LABELS } from "./config.js";
import { booksForGenres, cacheBooks, recommendStores, searchOpenLibrary } from "./recommend.js";
import {
  assert,
  assertSameOrigin,
  fail,
  HttpError,
  json,
  optionalStr,
  readJson,
  str,
} from "./util.js";

const nowIso = () => new Date().toISOString();

function intParam(value, fallback, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(number, max);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function displayEventTime(iso, timezone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone || "UTC",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

async function scalar(env, sql, ...params) {
  const row = await env.DB.prepare(sql).bind(...params).first();
  return row ? Number(Object.values(row)[0]) || 0 : 0;
}

function shapeStore(row, tags = [], vibes = []) {
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    address: row.address,
    neighborhood: row.neighborhood,
    lat: row.lat,
    lon: row.lon,
    website: row.website,
    phone: row.phone,
    openingHours: row.opening_hours,
    isIndie: Boolean(row.is_indie),
    source: row.source,
    sourceUrl: row.source_url,
    checkedAt: row.checked_at,
    tags,
    vibes,
    upcomingEvents: row.upcoming_events ?? undefined,
    favorited: Boolean(row.favorited),
  };
}

function shapeStaffPick(row) {
  return {
    id: row.id,
    bookId: row.book_id || null,
    title: row.title,
    author: row.author,
    note: row.note,
    bookseller: row.bookseller,
    section: row.section,
    source: row.source,
    sourceUrl: row.source_url,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
    store: row.store_name
      ? {
          id: row.store_id,
          name: row.store_name,
          city: row.store_city,
          neighborhood: row.store_neighborhood,
        }
      : undefined,
  };
}

async function withSavedState(env, userId, picks) {
  if (!userId) return picks.map((pick) => ({ ...pick, saved: false }));
  const bookIds = [...new Set(picks.map((pick) => pick.bookId).filter(Boolean))];
  const saved = new Set();
  for (let start = 0; start < bookIds.length; start += 80) {
    const ids = bookIds.slice(start, start + 80);
    const placeholders = ids.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT book_id FROM shelf WHERE user_id = ? AND book_id IN (${placeholders})`,
    )
      .bind(userId, ...ids)
      .all();
    for (const row of results || []) saved.add(row.book_id);
  }
  return picks.map((pick) => ({ ...pick, saved: pick.bookId ? saved.has(pick.bookId) : false }));
}

async function decorateStores(env, rows, userId) {
  if (!rows.length) return [];
  const tagsByStore = new Map();
  const vibesByStore = new Map();

  // D1 allows at most 100 bound parameters per statement, so look up in chunks.
  for (let start = 0; start < rows.length; start += 80) {
    const ids = rows.slice(start, start + 80).map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    const [{ results: tagRows }, { results: vibeRows }] = await Promise.all([
      env.DB.prepare(`SELECT store_id, tag, source FROM store_tags WHERE store_id IN (${placeholders})`)
        .bind(...ids)
        .all(),
      env.DB.prepare(
        `SELECT store_id, tag, COUNT(*) AS n FROM store_vibes WHERE store_id IN (${placeholders}) GROUP BY store_id, tag`,
      )
        .bind(...ids)
        .all(),
    ]);
    for (const row of tagRows || []) {
      if (!tagsByStore.has(row.store_id)) tagsByStore.set(row.store_id, []);
      tagsByStore.get(row.store_id).push({ tag: row.tag, source: row.source });
    }
    for (const row of vibeRows || []) {
      if (!vibesByStore.has(row.store_id)) vibesByStore.set(row.store_id, []);
      vibesByStore.get(row.store_id).push({ tag: row.tag, count: Number(row.n) });
    }
  }

  return rows.map((row) => shapeStore(row, tagsByStore.get(row.id) || [], vibesByStore.get(row.id) || []));
}

async function favoriteIds(env, userId) {
  if (!userId) return new Set();
  const { results } = await env.DB.prepare("SELECT store_id FROM favorites WHERE user_id = ?").bind(userId).all();
  return new Set((results || []).map((row) => row.store_id));
}

function requireAdmin(request, env) {
  const token = env.ADMIN_TOKEN;
  assert(token, 503, "Admin tools are not configured. Set the ADMIN_TOKEN secret.");
  assert(request.headers.get("x-admin-token") === token, 401, "Admin token required");
}

/* ------------------------------------------------------------------ auth */

async function getConfig(request, env) {
  return json({
    cities: CITIES,
    tagGroups: TAG_GROUPS,
    genres: GENRES,
    eventKinds: EVENT_KINDS,
    storeCount: await scalar(env, "SELECT COUNT(*) FROM stores WHERE is_indie = 1"),
  });
}

async function postRegisterOptions(request, env) {
  assertSameOrigin(request, env);
  return json(await registerOptions(request, env));
}

async function postRegisterVerify(request, env) {
  assertSameOrigin(request, env);
  const result = await registerVerify(request, env);
  return json({ user: result.user, recoveryCode: result.recoveryCode }, 201, { "set-cookie": result.cookie });
}

async function postLoginOptions(request, env) {
  assertSameOrigin(request, env);
  return json(await loginOptions(request, env));
}

async function postLoginVerify(request, env) {
  assertSameOrigin(request, env);
  const result = await loginVerify(request, env);
  return json({ user: result.user }, 200, { "set-cookie": result.cookie });
}

async function postLogout(request, env) {
  assertSameOrigin(request, env);
  await destroySession(request, env);
  return json({ ok: true }, 200, { "set-cookie": "bl_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
}

async function getMe(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ user: null });
  const [{ results: genres }, favorites, counts] = await Promise.all([
    env.DB.prepare("SELECT genre FROM user_genres WHERE user_id = ?").bind(user.id).all(),
    favoriteIds(env, user.id),
    env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) AS n FROM shelf WHERE user_id = ?").bind(user.id),
      env.DB.prepare("SELECT COUNT(*) AS n FROM rsvps WHERE user_id = ?").bind(user.id),
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM friends WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`,
      )
        .bind(user.id, user.id),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM friends WHERE status = 'pending' AND addressee_id = ?`)
        .bind(user.id),
    ]),
  ]);
  return json({
    user: publicUser(user),
    genres: (genres || []).map((row) => row.genre),
    favoriteStoreIds: [...favorites],
    counts: {
      shelf: counts[0].results[0].n,
      rsvps: counts[1].results[0].n,
      friends: counts[2].results[0].n,
      pendingRequests: counts[3].results[0].n,
    },
  });
}

async function patchMe(request, env) {
  assertSameOrigin(request, env);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const displayName = body.displayName
    ? str(body.displayName, { min: 1, max: 60, field: "Display name" })
    : user.display_name;
  const city = body.city === null ? null : body.city ? str(body.city, { min: 2, max: 40, field: "City" }) : user.city;
  const bio = body.bio === undefined ? user.bio : optionalStr(body.bio, { max: 280, field: "Bio" });
  const visibility = body.shelfVisibility || user.shelf_visibility;
  assert(["friends", "private"].includes(visibility), 400, "Visibility must be friends or private");

  await env.DB.prepare(
    "UPDATE users SET display_name = ?, city = ?, bio = ?, shelf_visibility = ? WHERE id = ?",
  )
    .bind(displayName, city, bio, visibility, user.id)
    .run();
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
  return json({ user: publicUser(row) });
}

async function putGenres(request, env) {
  assertSameOrigin(request, env);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  assert(Array.isArray(body.genres), 400, "Send a genres array");
  const genres = [...new Set(body.genres.filter((genre) => GENRES.includes(genre)))].slice(0, 6);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_genres WHERE user_id = ?").bind(user.id),
    ...genres.map((genre) =>
      env.DB.prepare("INSERT INTO user_genres (user_id, genre) VALUES (?, ?)").bind(user.id, genre),
    ),
  ]);
  return json({ genres });
}

async function postRecoveryOptions(request, env) {
  assertSameOrigin(request, env);
  return json(await recoveryOptions(request, env));
}

async function postRecoveryVerify(request, env) {
  assertSameOrigin(request, env);
  const result = await recoveryVerify(request, env);
  return json({ user: result.user, recoveryCode: result.recoveryCode }, 200, { "set-cookie": result.cookie });
}

/* ---------------------------------------------------------------- stores */

async function getStores(request, env) {
  const url = new URL(request.url);
  const city = url.searchParams.get("city");
  const q = (url.searchParams.get("q") || "").trim();
  const tag = url.searchParams.get("tag");
  const limit = intParam(url.searchParams.get("limit"), 60, 200);

  assert(!city || CITY_IDS.includes(city), 400, "Unknown city");
  assert(!tag || TAG_IDS.has(tag), 400, "Unknown tag");

  const where = ["s.is_indie = 1"];
  const params = [];
  if (city) {
    where.push("s.city = ?");
    params.push(city);
  }
  if (q) {
    where.push("(s.name LIKE ? OR s.address LIKE ? OR s.neighborhood LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (tag) {
    where.push(
      "(EXISTS (SELECT 1 FROM store_tags t WHERE t.store_id = s.id AND t.tag = ?) OR EXISTS (SELECT 1 FROM store_vibes v WHERE v.store_id = s.id AND v.tag = ?))",
    );
    params.push(tag, tag);
  }

  const sql = `SELECT s.* FROM stores s ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.name LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...params, limit).all();
  const user = await currentUser(request, env);
  const favorites = await favoriteIds(env, user?.id);
  const stores = await decorateStores(env, results || [], user?.id);
  return json({ stores: stores.map((store) => ({ ...store, favorited: favorites.has(store.id) })) });
}

async function getStore(request, env, { id }) {
  const row = await env.DB.prepare("SELECT * FROM stores WHERE id = ?").bind(id).first();
  assert(row, 404, "Bookshop not found");
  const user = await currentUser(request, env);
  const [store] = await decorateStores(env, [row], user?.id);
  const { results: events } = await env.DB.prepare(
    `SELECT * FROM events WHERE store_id = ? AND status = 'published' AND starts_at >= ? ORDER BY starts_at LIMIT 6`,
  )
    .bind(id, nowIso())
    .all();
  const favorited = user
    ? Boolean(
        await env.DB.prepare("SELECT 1 FROM favorites WHERE user_id = ? AND store_id = ?").bind(user.id, id).first(),
      )
    : false;
  const claimed = await scalar(env, "SELECT COUNT(*) FROM store_claims WHERE store_id = ? AND status = 'approved'", id);
  const ownerClaim = user
    ? await env.DB.prepare(
        "SELECT 1 FROM store_claims WHERE store_id = ? AND user_id = ? AND status = 'approved'",
      )
        .bind(id, user.id)
        .first()
    : null;
  const { results: pickRows } = await env.DB.prepare(
    "SELECT * FROM staff_picks WHERE store_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT 8",
  )
    .bind(id)
    .all();
  const pendingPickCount = ownerClaim
    ? await scalar(env, "SELECT COUNT(*) FROM staff_picks WHERE store_id = ? AND status = 'pending'", id)
    : 0;
  const staffPicks = await withSavedState(env, user?.id, (pickRows || []).map(shapeStaffPick));
  return json({
    store: {
      ...store,
      favorited,
      claimed: claimed > 0,
      canManagePicks: Boolean(ownerClaim),
      pendingPickCount,
      staffPicks,
      events: (events || []).map((event) => ({
        id: event.id,
        title: event.title,
        kind: event.kind,
        startsAt: event.starts_at,
        endsAt: event.ends_at,
        url: event.url,
        source: event.source,
      })),
    },
  });
}

async function postVibe(request, env, { id }) {
  assertSameOrigin(request, env);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  assert(TAG_IDS.has(body.tag), 400, "Unknown vibe");
  const store = await env.DB.prepare("SELECT id FROM stores WHERE id = ?").bind(id).first();
  assert(store, 404, "Bookshop not found");
  await env.DB.prepare("INSERT OR IGNORE INTO store_vibes (store_id, user_id, tag) VALUES (?, ?, ?)")
    .bind(id, user.id, body.tag)
    .run();
  return json({ ok: true, counts: await vibeCounts(env, id) });
}

async function deleteVibe(request, env, { id }) {
  assertSameOrigin(request, env);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  assert(TAG_IDS.has(body.tag), 400, "Unknown vibe");
  await env.DB.prepare("DELETE FROM store_vibes WHERE store_id = ? AND user_id = ? AND tag = ?")
    .bind(id, user.id, body.tag)
    .run();
  return json({ ok: true, counts: await vibeCounts(env, id) });
}

async function vibeCounts(env, storeId) {
  const { results } = await env.DB.prepare(
    "SELECT tag, COUNT(*) AS n FROM store_vibes WHERE store_id = ? GROUP BY tag",
  )
    .bind(storeId)
    .all();
  return (results || []).map((row) => ({ tag: row.tag, count: Number(row.n) }));
}

async function postFavorite(request, env, { id }) {
  assertSameOrigin(request, env);
  const user = await requireUser(request, env);
  const store = await env.DB.prepare("SELECT id FROM stores WHERE id = ?").bind(id).first();
  assert(store, 404, "Bookshop not found");
  await env.DB.prepare("INSERT OR IGNORE INTO favorites (user_id, store_id) VALUES (?, ?)").bind(user.id, id).run();
  return json({ ok: true });
}

async function deleteFavorite(request, env, { id }) {
  assertSameOrigin(request, env);
  const user = await requireUser(request, env);
  await env.DB.prepare("DELETE FROM favorites WHERE user_id = ? AND store_id = ?").bind(user.id, id).run();
  return json({ ok: true });
}

async function postClaim(request, env, { id }) {
  assertSameOrigin(request, env);
  const body = await readJson(request);
  const store = await env.DB.prepare("SELECT id, name FROM stores WHERE id = ?").bind(id).first();
  assert(store, 404, "Bookshop not found");
  const user = await currentUser(request, env);
  const contact = str(body.contact, { min: 3, max: 200, field: "Contact" });
  const role = optionalStr(body.role, { max: 80, field: "Role" });
  const message = optionalStr(body.message, { max: 600, field: "Message" });
  await env.DB.prepare(
    "INSERT INTO store_claims (id, store_id, user_id, contact, role, message) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(`claim_${crypto.randomUUID()}`, id, user?.id || null, contact, role, message)
    .run();
  return json({ ok: true, message: "Thanks. A human will check this claim before anything changes." }, 201);
}

/* ------------------------------------------------------------ staff picks */

async function getStaffPicks(request, env) {
  const url = new URL(request.url);
  const city = url.searchParams.get("city");
  const storeId = url.searchParams.get("storeId");
  const limit = intParam(url.searchParams.get("limit"), 12, 50);
  assert(!city || CITY_IDS.includes(city), 400, "Unknown city");

  const where = ["p.status = 'published'"];
  const params = [];
  if (city) {
    where.push("s.city = ?");
    params.push(city);
  }
  if (storeId) {
    where.push("p.store_id = ?");
    params.push(storeId);
  }

  const { results } = await env.DB.prepare(
    `SELECT p.*, s.name AS store_name, s.city AS store_city, s.neighborhood AS store_neighborhood
     FROM staff_picks p JOIN stores s ON s.id = p.store_id
     WHERE ${where.join(" AND ")}
     ORDER BY p.created_at DESC LIMIT ?`,
  )
    .bind(...params, limit)
    .all();
  const user = await currentUser(request, env);
  return json({ picks: await withSavedState(env, user?.id, (results || []).map(shapeStaffPick)) });
}

async function postStaffPick(request, env, { id }) {
  assertSameOrigin(request, env);
  const user = await currentUser(request, env);
  const admin = Boolean(env.ADMIN_TOKEN) && request.headers.get("x-admin-token") === env.ADMIN_TOKEN;
  assert(user || admin, 401, "Sign in to add a staff pick");

  const store = await env.DB.prepare("SELECT id, name FROM stores WHERE id = ?").bind(id).first();
  assert(store, 404, "Bookshop not found");
  const owner = user
    ? await env.DB.prepare(
        "SELECT 1 FROM store_claims WHERE store_id = ? AND user_id = ? AND status = 'approved'",
      )
        .bind(id, user.id)
        .first()
    : null;
  assert(admin || owner, 403, "Only the shop's claimed owner can add staff picks");

  const body = await readJson(request);
  const title = str(body.title, { min: 1, max: 200, field: "Book title" });
  const note = str(body.note, { min: 10, max: 280, field: "Why you love it" });
  const author = optionalStr(body.author, { max: 160, field: "Author" });
  const bookseller = optionalStr(body.bookseller, { max: 80, field: "Bookseller" });
  const section = optionalStr(body.section, { max: 60, field: "Section" });
  const sourceUrl = optionalStr(body.sourceUrl, { max: 500, field: "Link" });
  if (sourceUrl) assert(/^https?:\/\//.test(sourceUrl), 400, "Link must start with http:// or https://");

  const source = owner ? "owner" : "editor";
  const status = admin ? "published" : "pending";
  const pickId = `pick_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO staff_picks (id, store_id, title, author, note, bookseller, section, source, source_url, status, submitted_by, reviewed_at, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      pickId,
      id,
      title,
      author,
      note,
      bookseller || (user ? user.display_name : "bookloop editor"),
      section,
      source,
      sourceUrl,
      status,
      user?.id || null,
      admin ? nowIso() : null,
      nowIso(),
    )
    .run();

  return json(
    {
      id: pickId,
      status,
      message: admin ? "Staff pick published." : "Thanks. Your pick goes live after a quick review.",
    },
    201,
  );
}

async function postSaveStaffPick(request, env, { id }) {
  assertSameOrigin(request, env);
  const user = await requireUser(request, env);
  const pick = await env.DB.prepare("SELECT * FROM staff_picks WHERE id = ? AND status = 'published'")
    .bind(id)
    .first();
  assert(pick, 404, "Staff pick not found");

  let book = pick.book_id
    ? await env.DB.prepare("SELECT * FROM books WHERE id = ?").bind(pick.book_id).first()
    : null;

  if (!book) {
    try {
      const query = [pick.title, pick.author].filter(Boolean).join(" ");
      const matches = await searchOpenLibrary(env, query, 5);
      const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const best = matches.find((item) => normalize(item.title) === normalize(pick.title)) || matches[0];
      if (best) {
        book = { id: best.id, title: best.title, author: best.author, cover_url: best.coverUrl };
      }
    } catch (error) {
      console.error("staff pick book lookup failed", error.message);
    }
  }

  // Keep the save working when Open Library cannot answer: store the pick's own
  // title and author as a local book record.
  if (!book) {
    const fallbackId = `pick:${pick.id}`;
    const existing = await env.DB.prepare("SELECT * FROM books WHERE id = ?").bind(fallbackId).first();
    if (!existing) {
      await env.DB.prepare(
        "INSERT INTO books (id, title, author, subjects, checked_at) VALUES (?, ?, ?, '[]', ?)",
      )
        .bind(fallbackId, pick.title, pick.author, nowIso())
        .run();
    }
    book = await env.DB.prepare("SELECT * FROM books WHERE id = ?").bind(fallbackId).first();
  }

  if (pick.book_id !== book.id) {
    await env.DB.prepare("UPDATE staff_picks SET book_id = ? WHERE id = ?").bind(book.id, pick.id).run();
  }

  const existingShelf = await env.DB.prepare("SELECT status FROM shelf WHERE user_id = ? AND book_id = ?")
    .bind(user.id, book.id)
    .first();
  if (!existingShelf) {
    await env.DB.prepare("INSERT OR IGNORE INTO shelf (user_id, book_id, status) VALUES (?, ?, 'want')")
      .bind(user.id, book.id)
      .run();
  }

  return json({
    ok: true,
    alreadyOnShelf: Boolean(existingShelf),
    shelfStatus: existingShelf?.status || "want",
    book: { id: book.id, title: book.title, author: book.author, coverUrl: book.cover_url },
  });
}

/* ---------------------------------------------------------------- events */

async function getEvents(request, env) {
  const url = new URL(request.url);
  const city = url.searchParams.get("city");
  const storeId = url.searchParams.get("storeId");
  const from = url.searchParams.get("from") || nowIso();
  const to = url.searchParams.get("to") || new Date(Date.now() + 1000 * 60 * 60 * 24 * 120).toISOString();
  const limit = intParam(url.searchParams.get("limit"), 80, 200);
  assert(!city || CITY_IDS.includes(city), 400, "Unknown city");

  const where = ["e.status = 'published'", "e.starts_at >= ?", "e.starts_at <= ?"];
  const params = [from, to];
  if (city) {
    where.push("s.city = ?");
    params.push(city);
  }
  if (storeId) {
    where.push("e.store_id = ?");
    params.push(storeId);
  }

  const { results } = await env.DB.prepare(
    `SELECT e.*, s.name AS store_name, s.city AS store_city, s.neighborhood AS store_neighborhood, s.website AS store_website,
            (SELECT COUNT(*) FROM rsvps r WHERE r.event_id = e.id) AS rsvp_count
     FROM events e LEFT JOIN stores s ON s.id = e.store_id
     WHERE ${where.join(" AND ")}
     ORDER BY e.starts_at ASC LIMIT ?`,
  )
    .bind(...params, limit)
    .all();

  const user = await currentUser(request, env);
  let mine = new Set();
  if (user) {
    const { results: rsvpRows } = await env.DB.prepare("SELECT event_id FROM rsvps WHERE user_id = ?")
      .bind(user.id)
      .all();
    mine = new Set((rsvpRows || []).map((row) => row.event_id));
  }

  return json({
    events: (results || []).map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      timezone: row.timezone,
      url: row.url,
      description: row.description,
      source: row.source,
      sourceUrl: row.source_url,
      checkedAt: row.checked_at,
      store: row.store_id
        ? {
            id: row.store_id,
            name: row.store_name,
            city: row.store_city,
            neighborhood: row.store_neighborhood,
            website: row.store_website,
          }
        : null,
      rsvpCount: Number(row.rsvp_count) || 0,
      going: mine.has(row.id),
    })),
  });
}

async function postRsvp(request, env, { id }) {
  assertSameOrigin(request, env);
  const user = await requireUser(request, env);
  const event = await env.DB.prepare("SELECT id FROM events WHERE id = ? AND status = 'published'").bind(id).first();
  assert(event, 404, "Event not found");
  await env.DB.prepare("INSERT OR IGNORE INTO rsvps (event_id, user_id) VALUES (?, ?)").bind(id, user.id).run();
  const count = await scalar(env, "SELECT COUNT(*) FROM rsvps WHERE event_id = ?", id);
  return json({ ok: true, rsvpCount: count, going: true });
}

async function deleteRsvp(request, env, { id }) {
  assertSameOrigin(request, env);
  const user = await requireUser(request, env);
  await env.DB.prepare("DELETE FROM rsvps WHERE event_id = ? AND user_id = ?").bind(id, user.id).run();
  const count = await scalar(env, "SELECT COUNT(*) FROM rsvps WHERE event_id = ?", id);
  return json({ ok: true, rsvpCount: count, going: false });
}

async function postEvent(request, env) {
  assertSameOrigin(request, env);
  const user = await currentUser(request, env);
  const admin = Boolean(env.ADMIN_TOKEN) && request.headers.get("x-admin-token") === env.ADMIN_TOKEN;
  assert(user || admin, 401, "Sign in to submit an event");

  const body = await readJson(request);
  const title = str(body.title, { min: 3, max: 140, field: "Title" });
  const kind = EVENT_KINDS.includes(body.kind) ? body.kind : "Other";
  const startsAt = new Date(body.startsAt);
  assert(!Number.isNaN(startsAt.getTime()), 400, "Start date is not valid");
  const endsAt = body.endsAt ? new Date(body.endsAt) : null;
  if (endsAt) assert(!Number.isNaN(endsAt.getTime()) && endsAt > startsAt, 400, "End time must be after the start");
  const storeId = str(body.storeId, { min: 1, max: 80, field: "Bookshop" });
  const store = await env.DB.prepare("SELECT id FROM stores WHERE id = ?").bind(storeId).first();
  assert(store, 404, "Bookshop not found");
  const url = optionalStr(body.url, { max: 500, field: "Event link" });
  if (url) assert(/^https?:\/\//.test(url), 400, "Event link must start with http:// or https://");

  const id = `ev_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO events (id, store_id, title, kind, starts_at, ends_at, timezone, url, description, source, source_url, status, submitted_by, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      storeId,
      title,
      kind,
      startsAt.toISOString(),
      endsAt ? endsAt.toISOString() : null,
      body.timezone || "UTC",
      url,
      optionalStr(body.description, { max: 600, field: "Description" }),
      url,
      admin ? "published" : "pending",
      user?.id || null,
      nowIso(),
    )
    .run();

  return json(
    {
      id,
      pending: !admin,
      message: admin ? "Event published." : "Thanks. The listing goes live after a quick review.",
    },
    201,
  );
}

/* ----------------------------------------------------------------- books */

async function getBookSearch(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  assert(q.length >= 2, 400, "Search for at least two characters");
  try {
    const books = await searchOpenLibrary(env, q, intParam(url.searchParams.get("limit"), 12, 24));
    return json({ books });
  } catch (error) {
    return fail(502, "The Open Library catalogue is busy. Try again in a moment.", { detail: error.message });
  }
}

async function getShelf(request, env) {
  const user = await requireUser(request, env);
  const { results } = await env.DB.prepare(
    `SELECT sh.status, sh.rating, sh.note, sh.created_at, sh.updated_at,
            b.id, b.title, b.author, b.cover_url, b.subjects, b.first_publish_year
     FROM shelf sh JOIN books b ON b.id = sh.book_id
     WHERE sh.user_id = ? ORDER BY sh.updated_at DESC`,
  )
    .bind(user.id)
    .all();
  return json({
    shelf: (results || []).map((row) => ({
      id: row.id,
      title: row.title,
      author: row.author,
      coverUrl: row.cover_url,
      firstPublishYear: row.first_publish_year,
      subjects: row.subjects ? JSON.parse(row.subjects) : [],
      status: row.status,
      rating: row.rating,
      note: row.note,
      updatedAt: row.updated_at,
    })),
  });
}

async function putShelf(request, env, { bookId }) {
  assertSameOrigin(request, env);
  const user = await requireUser(request, env);
  const id = decodeURIComponent(bookId);
  assert(id.startsWith("/works/") || id.startsWith("pick:"), 400, "Unknown book id");
  const body = await readJson(request);
  const status = body.status || "want";
  assert(["want", "reading", "read"].includes(status), 400, "Status must be want, reading or read");
  const rating = body.rating === null || body.rating === undefined ? null : Number(body.rating);
  if (rating !== null) assert(Number.isInteger(rating) && rating >= 1 && rating <= 5, 400, "Rating is 1-5");
  const note = optionalStr(body.note, { max: 500, field: "Note" });

  const existing = await env.DB.prepare("SELECT id FROM books WHERE id = ?").bind(id).first();
  if (!existing) {
    const title = str(body.title, { min: 1, max: 300, field: "Title" });
    assert(/^https?:\/\//.test(body.coverUrl || "") || !body.coverUrl, 400, "Cover must be a URL");
    await cacheBooks(env, [
      {
        id,
        title,
        author: body.author ? String(body.author).slice(0, 200) : null,
        coverUrl: body.coverUrl || null,
        subjects: [],
        firstPublishYear: body.firstPublishYear ?? null,
      },
    ]);
  }

  await env.DB.prepare(
    `INSERT INTO shelf (user_id, book_id, status, rating, note, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, book_id) DO UPDATE SET
       status = excluded.status, rating = excluded.rating, note = excluded.note, updated_at = datetime('now')`,
  )
    .bind(user.id, id, status, rating, note)
    .run();
  return json({ ok: true });
}

async function deleteShelf(request, env, { bookId }) {
  assertSameOrigin(request, env);
  const user = await requireUser(request, env);
  await env.DB.prepare("DELETE FROM shelf WHERE user_id = ? AND book_id = ?")
    .bind(user.id, decodeURIComponent(bookId))
    .run();
  return json({ ok: true });
}

/* --------------------------------------------------------------- friends */

function friendState(row) {
  return {
    handle: row.handle,
    displayName: row.display_name,
    city: row.city,
    status: row.status,
    direction: row.direction,
  };
}

async function getFriends(request, env) {
  const user = await requireUser(request, env);
  const { results } = await env.DB.prepare(
    `SELECT u.handle, u.display_name, u.city, f.status, f.requester_id,
            CASE WHEN f.requester_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction
     FROM friends f
     JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
     WHERE f.requester_id = ? OR f.addressee_id = ?
     ORDER BY f.updated_at DESC`,
  )
    .bind(user.id, user.id, user.id, user.id)
    .all();
  const rows = (results || []).map(friendState);
  return json({
    friends: rows.filter((row) => row.status === "accepted"),
    incoming: rows.filter((row) => row.status === "pending" && row.direction === "incoming"),
    outgoing: rows.filter((row) => row.status === "pending" && row.direction === "outgoing"),
  });
}

async function postFriend(request, env) {
  assertSameOrigin(request, env);
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const handle = normalizeHandle(body.handle);
  assert(handle !== user.handle, 400, "That is you");

  const target = await env.DB.prepare("SELECT * FROM users WHERE handle = ?").bind(handle).first();
  assert(target, 404, "No reader with that handle");

  const reverse = await env.DB.prepare(
    "SELECT * FROM friends WHERE requester_id = ? AND addressee_id = ?",
  )
    .bind(target.id, user.id)
    .first();

  if (reverse) {
    if (reverse.status === "pending") {
      await env.DB.prepare(
        "UPDATE friends SET status = 'accepted', updated_at = datetime('now') WHERE requester_id = ? AND addressee_id = ?",
      )
        .bind(target.id, user.id)
        .run();
      return json({ ok: true, status: "accepted" });
    }
    return json({ ok: true, status: "accepted" });
  }

  await env.DB.prepare(
    `INSERT INTO friends (requester_id, addressee_id, status) VALUES (?, ?, 'pending')
     ON CONFLICT(requester_id, addressee_id) DO NOTHING`,
  )
    .bind(user.id, target.id)
    .run();
  return json({ ok: true, status: "pending" }, 201);
}

async function postFriendAction(request, env, { handle, action }) {
  assertSameOrigin(request, env);
  const user = await requireUser(request, env);
  const target = await env.DB.prepare("SELECT * FROM users WHERE handle = ?").bind(normalizeHandle(handle)).first();
  assert(target, 404, "No reader with that handle");

  if (action === "accept") {
    const changed = await env.DB.prepare(
      `UPDATE friends SET status = 'accepted', updated_at = datetime('now')
       WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'`,
    )
      .bind(target.id, user.id)
      .run();
    assert(changed.meta.changes > 0, 404, "No pending request from that reader");
    return json({ ok: true, status: "accepted" });
  }

  await env.DB.prepare(
    `DELETE FROM friends
     WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
  )
    .bind(user.id, target.id, target.id, user.id)
    .run();
  return json({ ok: true, status: "none" });
}

async function getUserProfile(request, env, { handle }) {
  const viewer = await currentUser(request, env);
  const user = await env.DB.prepare("SELECT * FROM users WHERE handle = ?").bind(normalizeHandle(handle)).first();
  assert(user, 404, "No reader with that handle");

  let relationship = "none";
  if (viewer) {
    if (viewer.id === user.id) relationship = "self";
    else {
      const row = await env.DB.prepare(
        `SELECT status, requester_id FROM friends
         WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`,
      )
        .bind(viewer.id, user.id, user.id, viewer.id)
        .first();
      if (row?.status === "accepted") relationship = "friend";
      else if (row?.status === "pending") relationship = row.requester_id === viewer.id ? "requested" : "incoming";
    }
  }

  const canSeeShelf = relationship === "self" || (relationship === "friend" && user.shelf_visibility === "friends");
  let shelf = [];
  if (canSeeShelf) {
    const { results } = await env.DB.prepare(
      `SELECT sh.status, sh.rating, b.id, b.title, b.author, b.cover_url
       FROM shelf sh JOIN books b ON b.id = sh.book_id
       WHERE sh.user_id = ? ORDER BY sh.updated_at DESC LIMIT 60`,
    )
      .bind(user.id)
      .all();
    shelf = (results || []).map((row) => ({
      id: row.id,
      title: row.title,
      author: row.author,
      coverUrl: row.cover_url,
      status: row.status,
      rating: row.rating,
    }));
  }

  const { results: favoriteRows } = await env.DB.prepare(
    `SELECT s.id, s.name, s.city FROM favorites f JOIN stores s ON s.id = f.store_id
     WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 20`,
  )
    .bind(user.id)
    .all();

  return json({
    user: publicUser(user),
    relationship,
    canSeeShelf,
    shelfCount: await scalar(env, "SELECT COUNT(*) FROM shelf WHERE user_id = ?", user.id),
    shelf,
    favoriteStores: favoriteRows || [],
  });
}

async function getFeed(request, env) {
  const user = await requireUser(request, env);
  const { results: friendRows } = await env.DB.prepare(
    `SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS id
     FROM friends WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`,
  )
    .bind(user.id, user.id, user.id)
    .all();
  const ids = [user.id, ...(friendRows || []).map((row) => row.id)];
  const placeholders = ids.map(() => "?").join(",");

  const [{ results: shelfRows }, { results: rsvpRows }] = await Promise.all([
    env.DB.prepare(
      `SELECT sh.created_at, sh.status, u.handle, u.display_name, b.id AS book_id, b.title, b.author, b.cover_url
       FROM shelf sh
       JOIN users u ON u.id = sh.user_id
       JOIN books b ON b.id = sh.book_id
       WHERE sh.user_id IN (${placeholders}) AND u.shelf_visibility = 'friends'
       ORDER BY sh.created_at DESC LIMIT 25`,
    )
      .bind(...ids)
      .all(),
    env.DB.prepare(
      `SELECT r.created_at, u.handle, u.display_name, e.id AS event_id, e.title, e.starts_at, s.name AS store_name
       FROM rsvps r
       JOIN users u ON u.id = r.user_id
       JOIN events e ON e.id = r.event_id
       LEFT JOIN stores s ON s.id = e.store_id
       WHERE r.user_id IN (${placeholders})
       ORDER BY r.created_at DESC LIMIT 15`,
    )
      .bind(...ids)
      .all(),
  ]);

  const items = [
    ...(shelfRows || []).map((row) => ({
      type: "shelf",
      at: row.created_at,
      handle: row.handle,
      displayName: row.display_name,
      book: { id: row.book_id, title: row.title, author: row.author, coverUrl: row.cover_url },
      status: row.status,
    })),
    ...(rsvpRows || []).map((row) => ({
      type: "rsvp",
      at: row.created_at,
      handle: row.handle,
      displayName: row.display_name,
      event: { id: row.event_id, title: row.title, startsAt: row.starts_at, storeName: row.store_name },
    })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

  return json({ items: items.slice(0, 30) });
}

/* --------------------------------------------------------------- for you */

async function getRecommendations(request, env) {
  const user = await requireUser(request, env);
  const [{ results: genreRows }, stores] = await Promise.all([
    env.DB.prepare("SELECT genre FROM user_genres WHERE user_id = ?").bind(user.id).all(),
    recommendStores(env, user, 6),
  ]);
  const genres = (genreRows || []).map((row) => row.genre);
  const books = await booksForGenres(env, genres, 8);
  return json({ genres, stores, books, needsGenres: genres.length === 0 });
}

/* ----------------------------------------------------------------- admin */

async function getAdminQueue(request, env) {
  requireAdmin(request, env);
  const [{ results: events }, { results: claims }, { results: staffPicks }] = await Promise.all([
    env.DB.prepare(
      `SELECT e.id, e.title, e.kind, e.starts_at, e.url, e.created_at, s.name AS store_name
       FROM events e LEFT JOIN stores s ON s.id = e.store_id
       WHERE e.status = 'pending' ORDER BY e.created_at LIMIT 100`,
    ).all(),
    env.DB.prepare(
      `SELECT c.id, c.contact, c.role, c.message, c.created_at, s.name AS store_name, s.id AS store_id
       FROM store_claims c JOIN stores s ON s.id = c.store_id
       WHERE c.status = 'pending' ORDER BY c.created_at LIMIT 100`,
    ).all(),
    env.DB.prepare(
      `SELECT p.id, p.title, p.author, p.note, p.bookseller, p.created_at, s.name AS store_name, s.id AS store_id
       FROM staff_picks p JOIN stores s ON s.id = p.store_id
       WHERE p.status = 'pending' ORDER BY p.created_at LIMIT 100`,
    ).all(),
  ]);
  return json({ events: events || [], claims: claims || [], staffPicks: staffPicks || [] });
}

async function postAdminEvent(request, env, { id }) {
  requireAdmin(request, env);
  const body = await readJson(request);
  assert(["approve", "reject"].includes(body.action), 400, "Action must be approve or reject");
  const status = body.action === "approve" ? "published" : "rejected";
  const changed = await env.DB.prepare("UPDATE events SET status = ?, checked_at = ? WHERE id = ?")
    .bind(status, nowIso(), id)
    .run();
  assert(changed.meta.changes > 0, 404, "Event not found");
  return json({ ok: true, status });
}

async function postAdminClaim(request, env, { id }) {
  requireAdmin(request, env);
  const body = await readJson(request);
  assert(["approve", "reject"].includes(body.action), 400, "Action must be approve or reject");
  const status = body.action === "approve" ? "approved" : "rejected";
  const changed = await env.DB.prepare("UPDATE store_claims SET status = ? WHERE id = ?").bind(status, id).run();
  assert(changed.meta.changes > 0, 404, "Claim not found");
  return json({ ok: true, status });
}

async function postAdminStaffPick(request, env, { id }) {
  requireAdmin(request, env);
  const body = await readJson(request);
  assert(["approve", "reject"].includes(body.action), 400, "Action must be approve or reject");
  const status = body.action === "approve" ? "published" : "rejected";
  const changed = await env.DB.prepare("UPDATE staff_picks SET status = ?, reviewed_at = ? WHERE id = ?")
    .bind(status, nowIso(), id)
    .run();
  assert(changed.meta.changes > 0, 404, "Staff pick not found");
  return json({ ok: true, status });
}

async function getHealth(request, env) {
  return json({
    ok: true,
    stores: await scalar(env, "SELECT COUNT(*) FROM stores"),
    events: await scalar(env, "SELECT COUNT(*) FROM events WHERE status = 'published' AND starts_at >= ?", nowIso()),
    users: await scalar(env, "SELECT COUNT(*) FROM users"),
  });
}

/* -------------------------------------------------------------- shop pages */

async function getSitemap(request, env) {
  const origin = (env.APP_ORIGIN || new URL(request.url).origin).replace(/\/$/, "");
  const { results } = await env.DB.prepare("SELECT id, checked_at FROM stores WHERE is_indie = 1 ORDER BY name").all();
  const entries = [
    `<url><loc>${escapeHtml(`${origin}/`)}</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${escapeHtml(`${origin}/events`)}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`,
    ...(results || []).map((row) => {
      const lastmod = row.checked_at ? `<lastmod>${escapeHtml(String(row.checked_at).slice(0, 10))}</lastmod>` : "";
      return `<url><loc>${escapeHtml(`${origin}/shop/${encodeURIComponent(row.id)}`)}</loc>${lastmod}<changefreq>weekly</changefreq><priority>0.7</priority></url>`;
    }),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join("")}</urlset>`;
  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

function getRobots(request, env) {
  const origin = (env.APP_ORIGIN || new URL(request.url).origin).replace(/\/$/, "");
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

async function getShopPage(request, env, id, url) {
  const row = await env.DB.prepare("SELECT * FROM stores WHERE id = ?").bind(id).first();
  if (!row) {
    return new Response("Bookshop not found. Browse the directory at /#cities", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const user = await currentUser(request, env);
  const [store] = await decorateStores(env, [row], user?.id);
  const [{ results: events }, { results: pickRows }, favoritedRow, approvedClaims] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM events WHERE store_id = ? AND status = 'published' AND starts_at >= ? ORDER BY starts_at LIMIT 12`,
    )
      .bind(id, nowIso())
      .all(),
    env.DB.prepare(
      `SELECT * FROM staff_picks WHERE store_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT 12`,
    )
      .bind(id)
      .all(),
    user
      ? env.DB.prepare("SELECT 1 FROM favorites WHERE user_id = ? AND store_id = ?").bind(user.id, id).first()
      : null,
    scalar(env, "SELECT COUNT(*) FROM store_claims WHERE store_id = ? AND status = 'approved'", id),
  ]);
  const picks = await withSavedState(env, user?.id, (pickRows || []).map(shapeStaffPick));
  const city = CITIES.find((item) => item.id === row.city);
  const cityLabel = city?.name || row.city;
  const origin = (env.APP_ORIGIN || url.origin).replace(/\/$/, "");
  const canonical = `${origin}/shop/${encodeURIComponent(row.id)}`;
  const favorited = Boolean(favoritedRow);
  const claimed = approvedClaims > 0;

  const facts = [
    row.address ? `<div><dt>Address</dt><dd>${escapeHtml(row.address)}</dd></div>` : "",
    row.opening_hours ? `<div><dt>Hours</dt><dd>${escapeHtml(row.opening_hours)}</dd></div>` : "",
    row.website
      ? `<div><dt>Website</dt><dd><a href="${escapeHtml(row.website)}" target="_blank" rel="noreferrer">${escapeHtml(row.website.replace(/^https?:\/\//, ""))}</a></dd></div>`
      : "",
    row.phone ? `<div><dt>Phone</dt><dd>${escapeHtml(row.phone)}</dd></div>` : "",
  ].join("");

  const vibeItems = store.vibes.length
    ? [...store.vibes]
        .sort((a, b) => b.count - a.count)
        .map(
          (vibe) =>
            `<span class="vibe-pill">${escapeHtml(TAG_LABELS.get(vibe.tag) || vibe.tag.replace(/-/g, " "))} <b>${vibe.count}</b></span>`,
        )
        .join("")
    : '<span class="muted">No reader vibes yet. Sign in on the map view to add one.</span>';

  const officialItems = store.tags
    .filter((tag) => tag.source !== "community")
    .map(
      (tag) =>
        `<span class="vibe-pill vibe-official">${escapeHtml(TAG_LABELS.get(tag.tag) || tag.tag)} <small>${escapeHtml(tag.source)}</small></span>`,
    )
    .join(" ");

  const pickItems = picks.length
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
    : '<p class="muted">No staff picks yet. They are hand-sells, not ratings: one book, one sentence from someone who works here.</p>';

  const eventItems = events?.length
    ? `<ul class="detail-events">${events
        .map(
          (event) => `<li>
            <span class="detail-event-date">${escapeHtml(displayEventTime(event.starts_at, event.timezone))}</span>
            <span><a href="${escapeHtml(event.url || "/events")}"${event.url ? ' target="_blank" rel="noreferrer"' : ""}>${escapeHtml(event.title)}</a>
            <small>${escapeHtml(event.kind)}</small></span>
          </li>`,
        )
        .join("")}</ul>`
    : '<p class="muted">No upcoming events listed yet. <a href="/events">See the calendar</a>.</p>';

  const body = `
    <a class="shop-back" href="/#cities">← All bookshops</a>
    <p class="eyebrow">${escapeHtml(store.neighborhood || cityLabel)} · ${escapeHtml(cityLabel)}</p>
    <h1 class="detail-title">${escapeHtml(store.name)}</h1>
    <p class="detail-meta">
      <span class="store-badge">${store.isIndie ? "Independent" : "Chain"}</span>
      ${claimed ? '<span class="store-badge badge-owner">Shop-claimed</span>' : ""}
      <span class="detail-source">Source: <a href="${escapeHtml(store.sourceUrl || "https://www.openstreetmap.org/copyright")}" target="_blank" rel="noreferrer">OpenStreetMap</a></span>
      <a class="detail-source" href="https://www.openstreetmap.org/?mlat=${store.lat}&mlon=${store.lon}#map=17/${store.lat}/${store.lon}" target="_blank" rel="noreferrer">Open map ↗</a>
    </p>
    <div class="detail-actions">
      <button class="btn ${favorited ? "btn-following" : "btn-primary"}" type="button" id="follow-store" data-following="${favorited}">
        ${favorited ? "Following ✓" : "Follow this shop"}
      </button>
      <a class="btn btn-ghost" href="/events">See all events ↗</a>
      <button class="btn btn-ghost" type="button" id="claim-toggle">I run this shop</button>
    </div>
    <dl class="detail-facts">${facts}</dl>

    <section class="detail-section">
      <h3>What readers say</h3>
      <div class="vibe-cloud">${vibeItems}</div>
      ${officialItems ? `<p class="detail-sub">Listing details: ${officialItems}</p>` : ""}
    </section>

    <section class="detail-section">
      <h3>Staff picks</h3>
      ${pickItems}
    </section>

    <section class="detail-section">
      <h3>Coming up</h3>
      ${eventItems}
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

  const bits = [];
  if (events?.length) bits.push(`${events.length} upcoming event${events.length === 1 ? "" : "s"}`);
  if (picks.length) bits.push(`${picks.length} staff pick${picks.length === 1 ? "" : "s"}`);
  const description = `${row.name} is a bookshop in ${cityLabel}. ${bits.length ? `${bits.join(" · ")}. ` : ""}Address, opening hours and how to visit.`;
  const title = `${row.name} — ${cityLabel} bookshop | bookloop`;

  const postalAddress = {
    "@type": "PostalAddress",
    ...(row.address ? { streetAddress: row.address } : {}),
    addressLocality: cityLabel,
    addressCountry: row.city === "singapore" ? "SG" : "US",
  };
  const graph = [
    {
      "@type": "BookStore",
      "@id": `${canonical}#bookstore`,
      name: row.name,
      url: canonical,
      address: postalAddress,
      geo: { "@type": "GeoCoordinates", latitude: row.lat, longitude: row.lon },
      ...(row.website ? { sameAs: [row.website] } : {}),
      ...(row.phone ? { telephone: row.phone } : {}),
      ...(row.opening_hours ? { openingHours: row.opening_hours } : {}),
    },
    ...(events || []).map((event) => ({
      "@type": "Event",
      name: event.title,
      startDate: event.starts_at,
      ...(event.ends_at ? { endDate: event.ends_at } : {}),
      ...(event.url ? { url: event.url } : {}),
      ...(event.description ? { description: event.description } : {}),
      location: { "@type": "BookStore", name: row.name, address: postalAddress },
    })),
  ];
  const jsonLd = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  const meta = `
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <link rel="canonical" href="${escapeHtml(canonical)}">
    <meta name="robots" content="index,follow">
    <meta property="og:type" content="website">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:url" content="${escapeHtml(canonical)}">
    <script type="application/ld+json">${jsonLd}</script>`;

  const templateResponse = await env.ASSETS.fetch(new Request(new URL("/shop-template.html", url)));
  if (!templateResponse.ok) {
    return new Response("Shop page template is missing.", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  let html = await templateResponse.text();
  html = html.replace("<!--SHOP_META-->", meta).replace("<!--SHOP_BODY-->", body);
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ---------------------------------------------------------------- router */

const routes = [
  ["GET", /^\/api\/health$/, getHealth],
  ["GET", /^\/api\/config$/, getConfig],
  ["POST", /^\/api\/auth\/register\/options$/, postRegisterOptions],
  ["POST", /^\/api\/auth\/register\/verify$/, postRegisterVerify],
  ["POST", /^\/api\/auth\/login\/options$/, postLoginOptions],
  ["POST", /^\/api\/auth\/login\/verify$/, postLoginVerify],
  ["POST", /^\/api\/auth\/recovery\/options$/, postRecoveryOptions],
  ["POST", /^\/api\/auth\/recovery\/verify$/, postRecoveryVerify],
  ["POST", /^\/api\/auth\/logout$/, postLogout],
  ["GET", /^\/api\/me$/, getMe],
  ["PATCH", /^\/api\/me$/, patchMe],
  ["PUT", /^\/api\/me\/genres$/, putGenres],
  ["GET", /^\/api\/stores$/, getStores],
  ["GET", /^\/api\/stores\/(?<id>[^/]+)$/, getStore],
  ["POST", /^\/api\/stores\/(?<id>[^/]+)\/vibes$/, postVibe],
  ["DELETE", /^\/api\/stores\/(?<id>[^/]+)\/vibes$/, deleteVibe],
  ["POST", /^\/api\/stores\/(?<id>[^/]+)\/favorite$/, postFavorite],
  ["DELETE", /^\/api\/stores\/(?<id>[^/]+)\/favorite$/, deleteFavorite],
  ["POST", /^\/api\/stores\/(?<id>[^/]+)\/claim$/, postClaim],
  ["GET", /^\/api\/staff-picks$/, getStaffPicks],
  ["POST", /^\/api\/stores\/(?<id>[^/]+)\/staff-picks$/, postStaffPick],
  ["POST", /^\/api\/staff-picks\/(?<id>[^/]+)\/save$/, postSaveStaffPick],
  ["GET", /^\/api\/events$/, getEvents],
  ["POST", /^\/api\/events$/, postEvent],
  ["POST", /^\/api\/events\/(?<id>[^/]+)\/rsvp$/, postRsvp],
  ["DELETE", /^\/api\/events\/(?<id>[^/]+)\/rsvp$/, deleteRsvp],
  ["GET", /^\/api\/books\/search$/, getBookSearch],
  ["GET", /^\/api\/shelf$/, getShelf],
  ["PUT", /^\/api\/shelf\/(?<bookId>.+)$/, putShelf],
  ["DELETE", /^\/api\/shelf\/(?<bookId>.+)$/, deleteShelf],
  ["GET", /^\/api\/friends$/, getFriends],
  ["POST", /^\/api\/friends$/, postFriend],
  ["POST", /^\/api\/friends\/(?<handle>[^/]+)\/(?<action>accept|decline)$/, postFriendAction],
  ["DELETE", /^\/api\/friends\/(?<handle>[^/]+)$/, (request, env, params) =>
    postFriendAction(request, env, { handle: params.handle, action: "decline" })],
  ["GET", /^\/api\/users\/(?<handle>[^/]+)$/, getUserProfile],
  ["GET", /^\/api\/feed$/, getFeed],
  ["GET", /^\/api\/recommendations$/, getRecommendations],
  ["GET", /^\/api\/admin\/queue$/, getAdminQueue],
  ["POST", /^\/api\/admin\/events\/(?<id>[^/]+)$/, postAdminEvent],
  ["POST", /^\/api\/admin\/claims\/(?<id>[^/]+)$/, postAdminClaim],
  ["POST", /^\/api\/admin\/staff-picks\/(?<id>[^/]+)$/, postAdminStaffPick],
];

async function handleApi(request, env, url) {
  for (const [method, pattern, handler] of routes) {
    if (request.method !== method) continue;
    const match = pattern.exec(url.pathname);
    if (!match) continue;
    const params = {};
    for (const [key, value] of Object.entries(match.groups || {})) params[key] = decodeURIComponent(value);
    return handler(request, env, params);
  }
  return fail(404, "No such API route");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/shop-template.html") {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/robots.txt") return getRobots(request, env);
    if (url.pathname === "/sitemap.xml") return getSitemap(request, env);
    if (url.pathname === "/shop" || url.pathname === "/shop/") {
      return Response.redirect(new URL("/#cities", request.url).toString(), 302);
    }
    const shopMatch = /^\/shop\/([^/]+)\/?$/.exec(url.pathname);
    if (shopMatch && request.method === "GET") {
      try {
        return await getShopPage(request, env, decodeURIComponent(shopMatch[1]), url);
      } catch (error) {
        if (error instanceof HttpError) return fail(error.status, error.message);
        console.error("Shop page failed", error.stack || error);
        return new Response("This bookshop page could not load.", {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    try {
      return await handleApi(request, env, url);
    } catch (error) {
      if (error instanceof HttpError) return fail(error.status, error.message);
      console.error("Unhandled API error", error.stack || error);
      return fail(500, "Something went wrong on our side");
    }
  },
};
