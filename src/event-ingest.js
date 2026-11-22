import { guessEventKind, parseFeed, stripHtml } from "./event-feed.js";
import { safeFetch, sha256 } from "./util.js";

const USER_AGENT = "bookloop-event-feed/1.0 (bookshop calendar sync; +https://github.com/purvab12/bookstore-finder)";
const MAX_FEED_CHARS = 1_000_000;
const MAX_EVENTS = 200;
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_EVENT_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;
const FEEDS_PER_RUN = 8;

const nowIso = () => new Date().toISOString();

function importedSource(source) {
  return source === "ics" || source === "jsonld";
}

function cleanText(value, max) {
  return stripHtml(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function normalizeEvent(raw, feed) {
  const title = cleanText(raw?.title, 140);
  const startsAt = raw?.startsAt instanceof Date ? raw.startsAt : new Date(raw?.startsAt);
  if (title.length < 3 || !startsAt || Number.isNaN(startsAt.getTime())) return null;

  const now = Date.now();
  if (startsAt.getTime() < now - MAX_EVENT_AGE_MS || startsAt.getTime() > now + MAX_EVENT_FUTURE_MS) {
    return null;
  }

  const endsAt = raw.endsAt instanceof Date ? raw.endsAt : raw.endsAt ? new Date(raw.endsAt) : null;
  const uid = String(raw.uid || `${title}-${startsAt.toISOString()}`).trim().slice(0, 500);
  if (!uid) return null;
  const timezone = /^[A-Za-z0-9_+\-/]{1,64}$/.test(String(raw.timezone || "")) ? raw.timezone : "UTC";

  return {
    uid,
    title,
    startsAt,
    endsAt: endsAt && !Number.isNaN(endsAt.getTime()) && endsAt > startsAt ? endsAt : null,
    timezone,
    description: cleanText(raw.description, 600) || null,
    url: /^https?:\/\//i.test(String(raw.url || "")) ? raw.url : feed.url,
    kind: guessEventKind(title),
  };
}

async function fetchFeed(feed) {
  const headers = {
    "user-agent": USER_AGENT,
    accept: "text/calendar, application/ld+json, text/html;q=0.8",
  };
  if (feed.etag) headers["if-none-match"] = feed.etag;
  if (feed.last_modified) headers["if-modified-since"] = feed.last_modified;

  const response = await safeFetch(feed.url, { headers }, 8000);
  if (response.status === 304) return { notModified: true };
  if (!response.ok) throw new Error(`Feed responded ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_FEED_CHARS) throw new Error("Feed is larger than 1 MB");
  const body = await response.text();
  if (body.length > MAX_FEED_CHARS) throw new Error("Feed is larger than 1 MB");

  return {
    body,
    contentType: response.headers.get("content-type") || "",
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

async function importEvents(env, feed, parsed) {
  const candidates = parsed.events
    .map((event) => normalizeEvent(event, feed))
    .filter(Boolean)
    .sort((a, b) => a.startsAt - b.startsAt)
    .slice(0, MAX_EVENTS);
  const stats = { candidates: candidates.length, created: 0, updated: 0, duplicates: 0, skipped: 0 };
  const seen = new Set();

  for (const event of candidates) {
    const uidKey = event.uid.toLowerCase();
    if (seen.has(uidKey)) {
      stats.skipped += 1;
      continue;
    }
    seen.add(uidKey);

    const eventId = `ev_${(await sha256(`${feed.store_id}:${event.uid}`)).slice(0, 22)}`;
    const startsAt = event.startsAt.toISOString();
    const endsAt = event.endsAt ? event.endsAt.toISOString() : null;
    const now = nowIso();
    const existing = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first();

    if (existing) {
      const unchanged =
        existing.title === event.title &&
        existing.kind === event.kind &&
        existing.starts_at === startsAt &&
        (existing.ends_at || null) === endsAt &&
        existing.timezone === event.timezone &&
        (existing.url || null) === event.url &&
        (existing.description || null) === event.description &&
        existing.source === parsed.format &&
        existing.source_url === feed.url &&
        existing.feed_id === feed.id &&
        existing.source_uid === event.uid;

      if (existing.status === "pending" && importedSource(existing.source) && !unchanged) {
        await env.DB.prepare(
          `UPDATE events SET title = ?, kind = ?, starts_at = ?, ends_at = ?, timezone = ?, url = ?,
             description = ?, source = ?, source_url = ?, feed_id = ?, source_uid = ?, checked_at = ?, last_seen_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
          .bind(
            event.title,
            event.kind,
            startsAt,
            endsAt,
            event.timezone,
            event.url,
            event.description,
            parsed.format,
            feed.url,
            feed.id,
            event.uid,
            now,
            now,
            eventId,
          )
          .run();
        stats.updated += 1;
      } else {
        // Published or rejected rows are never rewritten by an import. A feed
        // cannot publish itself or undo a human decision on a later run.
        stats.skipped += 1;
      }
      continue;
    }

    const naturalMatch = await env.DB.prepare(
      `SELECT id, status, source FROM events
       WHERE store_id = ? AND starts_at = ? AND lower(title) = lower(?) LIMIT 1`,
    )
      .bind(feed.store_id, startsAt, event.title)
      .first();
    if (naturalMatch) {
      // The same event may appear in two feeds with different UIDs, or a reader
      // may already have submitted it by hand. Keep the first row.
      stats.duplicates += 1;
      continue;
    }

    await env.DB.prepare(
      `INSERT INTO events
         (id, store_id, title, kind, starts_at, ends_at, timezone, url, description,
          source, source_url, status, checked_at, feed_id, source_uid, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
      .bind(
        eventId,
        feed.store_id,
        event.title,
        event.kind,
        startsAt,
        endsAt,
        event.timezone,
        event.url,
        event.description,
        parsed.format,
        feed.url,
        now,
        feed.id,
        event.uid,
        now,
      )
      .run();
    stats.created += 1;
  }

  return stats;
}

async function markSuccess(env, feed, { eventCount, etag, lastModified, checkedAt }) {
  await env.DB.prepare(
    `UPDATE event_feeds SET last_checked_at = ?, last_success_at = ?, last_error = NULL,
       last_event_count = ?, consecutive_failures = 0, etag = ?, last_modified = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(checkedAt, checkedAt, eventCount, etag || null, lastModified || null, checkedAt, feed.id)
    .run();
}

async function markFailure(env, feed, message, checkedAt) {
  const error = String(message || "Unknown feed error").slice(0, 500);
  await env.DB.prepare(
    `UPDATE event_feeds SET last_checked_at = ?, last_error = ?,
       consecutive_failures = consecutive_failures + 1, updated_at = ?
     WHERE id = ?`,
  )
    .bind(checkedAt, error, checkedAt, feed.id)
    .run();
  return error;
}

export async function runFeed(env, feed, { force = false } = {}) {
  if (!feed) return { ok: false, error: "Feed not found" };
  if (!force && !Number(feed.enabled)) {
    return { ok: true, skipped: "disabled", feedId: feed.id, storeId: feed.store_id, url: feed.url };
  }

  const checkedAt = nowIso();
  // Claim the feed before fetching so overlapping cron runs do not fetch it twice.
  await env.DB.prepare("UPDATE event_feeds SET last_checked_at = ?, updated_at = ? WHERE id = ?")
    .bind(checkedAt, checkedAt, feed.id)
    .run();

  try {
    const fetched = await fetchFeed(feed);
    if (fetched.notModified) {
      await markSuccess(env, feed, {
        eventCount: feed.last_event_count || 0,
        etag: feed.etag,
        lastModified: feed.last_modified,
        checkedAt,
      });
      return {
        ok: true,
        notModified: true,
        feedId: feed.id,
        storeId: feed.store_id,
        url: feed.url,
        format: feed.format,
      };
    }

    const parsed = parseFeed(fetched.body, {
      url: feed.url,
      format: feed.format,
      contentType: fetched.contentType,
    });
    const stats = await importEvents(env, feed, parsed);
    await markSuccess(env, feed, {
      eventCount: stats.candidates,
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      checkedAt,
    });
    return {
      ok: true,
      notModified: false,
      feedId: feed.id,
      storeId: feed.store_id,
      url: feed.url,
      format: parsed.format,
      ...stats,
    };
  } catch (error) {
    const message = await markFailure(env, feed, error.message, checkedAt);
    console.error(`event feed ${feed.id} (${feed.url}) failed: ${message}`);
    return {
      ok: false,
      feedId: feed.id,
      storeId: feed.store_id,
      url: feed.url,
      error: message,
      consecutiveFailures: Number(feed.consecutive_failures || 0) + 1,
    };
  }
}

export async function runFeedById(env, id, options = {}) {
  const feed = await env.DB.prepare(
    `SELECT f.*, s.name AS store_name FROM event_feeds f JOIN stores s ON s.id = f.store_id WHERE f.id = ?`,
  )
    .bind(id)
    .first();
  return feed ? runFeed(env, feed, options) : null;
}

export async function runDueFeeds(env, limit = FEEDS_PER_RUN) {
  const { results } = await env.DB.prepare(
    `SELECT f.*, s.name AS store_name
     FROM event_feeds f JOIN stores s ON s.id = f.store_id
     WHERE f.enabled = 1
       AND (f.last_checked_at IS NULL
         OR datetime(f.last_checked_at) <= datetime('now', '-' || f.check_interval_minutes || ' minutes'))
     ORDER BY COALESCE(f.last_checked_at, '') ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all();

  const runs = [];
  for (const feed of results || []) {
    runs.push(await runFeed(env, feed));
  }
  return {
    checked: runs.length,
    succeeded: runs.filter((run) => run.ok).length,
    failed: runs.filter((run) => !run.ok).length,
  };
}
