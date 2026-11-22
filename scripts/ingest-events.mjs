#!/usr/bin/env node
// One-off import of a bookshop's own event calendar into SQL.
//
//   node scripts/ingest-events.mjs --store osm-node-123 --url https://shop.example/events
//   node scripts/ingest-events.mjs --store osm-node-123 --url https://shop.example/calendar.ics --out data/events.sql
//
// Supports calendars the shop already publishes for machines:
//   * iCalendar (.ics / text/calendar)
//   * schema.org Event JSON-LD embedded in an events page
//
// For recurring imports, register the URL in the admin feed registry instead;
// the Worker checks it on a cron and sends new events through the review queue.
// Always confirm the shop's terms and robots.txt allow automated collection.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { guessEventKind, parseFeed } from "../src/event-feed.js";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, "");
  if (key) args.set(key, process.argv[i + 1]);
}

const storeId = args.get("store");
const url = args.get("url");
const out = args.get("out") || "data/events.sql";
const userAgent = "bookloop-event-import/0.1 (bookshop calendar import; contact the site owner)";

if (!storeId || !url) {
  console.error("Usage: node scripts/ingest-events.mjs --store <store-id> --url <calendar-url> [--out data/events.sql]");
  process.exit(1);
}

const response = await fetch(url, { headers: { "user-agent": userAgent, accept: "text/calendar, text/html;q=0.9" } });
if (!response.ok) {
  console.error(`Fetch failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}
const body = await response.text();
const contentType = response.headers.get("content-type") || "";
const parsedFeed = parseFeed(body, { url, format: "auto", contentType });
const parsed = parsedFeed.events
  .filter((event) => event.startsAt >= new Date(Date.now() - 86400000))
  .sort((a, b) => a.startsAt - b.startsAt)
  .slice(0, 200);

if (!parsed.length) {
  console.error(`No upcoming events found at ${url} (parsed as ${parsedFeed.format === "ics" ? "iCalendar" : "JSON-LD"}).`);
  process.exit(2);
}

const sqlEscape = (value) =>
  value === null || value === undefined ? "NULL" : `'${String(value).replace(/'/g, "''")}'`;

const checkedAt = new Date().toISOString();
const lines = [
  `-- Imported from ${url}`,
  `-- Store: ${storeId} · imported ${checkedAt}`,
  "-- Review before applying. Every row is marked published with its original source link.",
  "",
];

for (const event of parsed) {
  const id = `ev_${createHash("sha256").update(`${storeId}:${event.uid}`).digest("base64url").slice(0, 22)}`;
  lines.push(
    `INSERT INTO events (id, store_id, title, kind, starts_at, ends_at, timezone, url, description, source, source_url, status, checked_at) VALUES (` +
      [
        sqlEscape(id),
        sqlEscape(storeId),
        sqlEscape(event.title),
        sqlEscape(guessEventKind(event.title)),
        sqlEscape(event.startsAt.toISOString()),
        sqlEscape(event.endsAt ? event.endsAt.toISOString() : null),
        sqlEscape(event.timezone || "UTC"),
        sqlEscape(event.url),
        sqlEscape(event.description),
        sqlEscape(parsedFeed.format),
        sqlEscape(url),
        "'published'",
        sqlEscape(checkedAt),
      ].join(", ") +
      `) ON CONFLICT(id) DO UPDATE SET title = excluded.title, starts_at = excluded.starts_at, ends_at = excluded.ends_at, url = excluded.url, description = excluded.description, checked_at = excluded.checked_at;`,
  );
}

writeFileSync(out, `${lines.join("\n")}\n`);
console.log(`Wrote ${parsed.length} events to ${out} (${parsedFeed.format === "ics" ? "iCalendar" : "JSON-LD"} from ${url})`);
console.log("Apply with: npx wrangler d1 execute bookloop --remote --file=" + out);
