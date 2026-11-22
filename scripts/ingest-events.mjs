#!/usr/bin/env node
// Import a bookshop's own event calendar into D1.
//
//   node scripts/ingest-events.mjs --store osm-node-123 --url https://shop.example/events
//   node scripts/ingest-events.mjs --store osm-node-123 --url https://shop.example/calendar.ics --out data/events.sql
//
// Supports calendars the shop already publishes for machines:
//   * iCalendar (.ics / text/calendar)
//   * schema.org Event JSON-LD embedded in an events page
//
// Always confirm the shop's terms and robots.txt allow automated collection, and
// keep the source URL on every row. Output is SQL, reviewed before it is applied.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

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
const isIcs = contentType.includes("calendar") || body.trimStart().startsWith("BEGIN:VCALENDAR");

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(value) {
  return decodeEntities(String(value || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function guessKind(title) {
  const text = title.toLowerCase();
  if (text.includes("book club")) return "Book club";
  if (text.includes("storytime") || text.includes("story time")) return "Storytime";
  if (text.includes("signing")) return "Signing";
  if (text.includes("workshop")) return "Workshop";
  if (text.includes("launch")) return "Launch party";
  if (text.includes("reading") || text.includes("author")) return "Author event";
  return "Other";
}

/* ------------------------------------------------------------------- ics */

function parseIcsDate(raw) {
  if (!raw) return null;
  const value = raw.split(":").slice(1).join(":") || raw;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00", zulu] = match;
  if (!zulu && hour !== "00") {
    console.warn(`  ! ${value} has no timezone marker; treating it as UTC. Check this event.`);
  }
  return new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
}

function parseIcs(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const events = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const chunk = block.split("END:VEVENT")[0];
    const field = (name) => {
      const line = chunk.split(/\r?\n/).find((row) => row.startsWith(`${name}:`) || row.startsWith(`${name};`));
      return line ? line.slice(line.indexOf(":") + 1).trim() : null;
    };
    const title = field("SUMMARY");
    const startsAt = parseIcsDate(chunk.split(/\r?\n/).find((row) => row.startsWith("DTSTART")) || "");
    if (!title || !startsAt) continue;
    const endsAt = parseIcsDate(chunk.split(/\r?\n/).find((row) => row.startsWith("DTEND")) || "");
    events.push({
      uid: field("UID") || `${title}-${startsAt.toISOString()}`,
      title: stripHtml(title),
      startsAt,
      endsAt,
      description: stripHtml(field("DESCRIPTION") || "").slice(0, 600) || null,
      url: field("URL") || url,
    });
  }
  return events;
}

/* --------------------------------------------------------------- json-ld */

function collectEvents(node, found = []) {
  if (!node) return found;
  if (Array.isArray(node)) {
    for (const item of node) collectEvents(item, found);
    return found;
  }
  if (typeof node !== "object") return found;
  const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
  if (types.some((type) => typeof type === "string" && type.toLowerCase() === "event")) found.push(node);
  if (node["@graph"]) collectEvents(node["@graph"], found);
  return found;
}

function parseJsonLd(html) {
  const events = [];
  for (const match of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(match[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, ""));
    } catch {
      console.warn("  ! Skipped a JSON-LD block that is not valid JSON");
      continue;
    }
    for (const node of collectEvents(data)) {
      const title = stripHtml(node.name);
      const startsAt = node.startDate ? new Date(node.startDate) : null;
      if (!title || !startsAt || Number.isNaN(startsAt.getTime())) continue;
      events.push({
        uid: node.url || node["@id"] || `${title}-${startsAt.toISOString()}`,
        title,
        startsAt,
        endsAt: node.endDate ? new Date(node.endDate) : null,
        description: stripHtml(node.description).slice(0, 600) || null,
        url: node.url || url,
      });
    }
  }
  return events;
}

/* ----------------------------------------------------------------- write */

const parsed = (isIcs ? parseIcs(body) : parseJsonLd(body))
  .filter((event) => event.startsAt >= new Date(Date.now() - 86400000))
  .sort((a, b) => a.startsAt - b.startsAt)
  .slice(0, 200);

if (!parsed.length) {
  console.error(`No upcoming events found at ${url} (parsed as ${isIcs ? "iCalendar" : "JSON-LD"}).`);
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
  const kind = guessKind(event.title);
  lines.push(
    `INSERT INTO events (id, store_id, title, kind, starts_at, ends_at, timezone, url, description, source, source_url, status, checked_at) VALUES (` +
      [
        sqlEscape(id),
        sqlEscape(storeId),
        sqlEscape(event.title),
        sqlEscape(kind),
        sqlEscape(event.startsAt.toISOString()),
        sqlEscape(event.endsAt && !Number.isNaN(event.endsAt.getTime()) ? event.endsAt.toISOString() : null),
        "'UTC'",
        sqlEscape(event.url),
        sqlEscape(event.description),
        "'jsonld'",
        sqlEscape(url),
        "'published'",
        sqlEscape(checkedAt),
      ].join(", ") +
      `) ON CONFLICT(id) DO UPDATE SET title = excluded.title, starts_at = excluded.starts_at, ends_at = excluded.ends_at, url = excluded.url, description = excluded.description, checked_at = excluded.checked_at;`,
  );
}

writeFileSync(out, `${lines.join("\n")}\n`);
console.log(`Wrote ${parsed.length} events to ${out} (${isIcs ? "iCalendar" : "JSON-LD"} from ${url})`);
console.log("Apply with: npx wrangler d1 execute bookloop --remote --file=" + out);
