import { GENRE_SUBJECTS, GENRE_TAGS } from "./config.js";
import { safeFetch } from "./util.js";

const OPEN_LIBRARY = "https://openlibrary.org";
const USER_AGENT = "bookloop/0.2 (independent bookstore discovery; +https://github.com/purvab12/bookstore-finder)";

function coverUrl(coverId) {
  return coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null;
}

export function normalizeBook(doc) {
  if (!doc?.key || !doc?.title) return null;
  return {
    id: doc.key,
    title: doc.title,
    author: Array.isArray(doc.author_name) ? doc.author_name.slice(0, 3).join(", ") : null,
    coverUrl: coverUrl(doc.cover_i),
    subjects: Array.isArray(doc.subject) ? doc.subject.slice(0, 10) : [],
    firstPublishYear: doc.first_publish_year ?? null,
  };
}

export async function cacheBooks(env, books) {
  if (!books.length) return;
  const now = new Date().toISOString();
  await env.DB.batch(
    books.map((book) =>
      env.DB.prepare(
        `INSERT INTO books (id, title, author, cover_url, subjects, first_publish_year, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           author = excluded.author,
           cover_url = excluded.cover_url,
           subjects = excluded.subjects,
           first_publish_year = excluded.first_publish_year,
           checked_at = excluded.checked_at`,
      ).bind(
        book.id,
        book.title,
        book.author,
        book.coverUrl,
        JSON.stringify(book.subjects || []),
        book.firstPublishYear,
        now,
      ),
    ),
  );
}

export async function searchOpenLibrary(env, query, limit = 12) {
  const url = new URL(`${OPEN_LIBRARY}/search.json`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("fields", "key,title,author_name,cover_i,first_publish_year,subject");
  const response = await safeFetch(url.toString(), {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Open Library responded ${response.status}`);
  const data = await response.json();
  const books = (data.docs || []).map(normalizeBook).filter(Boolean);
  await cacheBooks(env, books);
  return books;
}

export async function booksForGenres(env, genres, limit = 8) {
  if (!genres.length) return [];
  const picks = [];
  const seen = new Set();
  for (const genre of genres.slice(0, 2)) {
    const subject = GENRE_SUBJECTS[genre] || genre.toLowerCase();
    try {
      const books = await searchOpenLibrary(env, `subject:${JSON.stringify(subject)}`, 6);
      for (const book of books) {
        if (seen.has(book.id) || picks.length >= limit) continue;
        seen.add(book.id);
        picks.push({ ...book, reason: `Because you like ${genre.toLowerCase()}` });
      }
    } catch (error) {
      console.error("recommendation lookup failed", genre, error.message);
    }
  }
  return picks;
}

function tagIndex(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.store_id)) map.set(row.store_id, new Map());
    map.get(row.store_id).set(row.tag, (map.get(row.store_id).get(row.tag) || 0) + row.weight);
  }
  return map;
}

export async function recommendStores(env, user, limit = 6) {
  const city = user.city;
  const { results: favorites } = await env.DB.prepare(
    `SELECT s.id, s.name FROM favorites f JOIN stores s ON s.id = f.store_id WHERE f.user_id = ?`,
  )
    .bind(user.id)
    .all();
  const favoriteIds = new Set((favorites || []).map((row) => row.id));

  const { results: favoriteTags } = await env.DB.prepare(
    `SELECT t.store_id, t.tag FROM store_tags t
     JOIN favorites f ON f.store_id = t.store_id
     WHERE f.user_id = ?`,
  )
    .bind(user.id)
    .all();

  const { results: genreRows } = await env.DB.prepare("SELECT genre FROM user_genres WHERE user_id = ?")
    .bind(user.id)
    .all();

  // Weight the reader's signals: explicit genres beat inferred shop tags.
  const weights = new Map();
  const tagToFavorite = new Map();
  for (const row of favoriteTags || []) {
    weights.set(row.tag, (weights.get(row.tag) || 0) + 2);
    if (!tagToFavorite.has(row.tag)) tagToFavorite.set(row.tag, row.store_id);
  }
  for (const row of genreRows || []) {
    for (const tag of GENRE_TAGS[row.genre] || []) {
      weights.set(tag, (weights.get(tag) || 0) + 3);
    }
  }

  const now = new Date().toISOString();

  if (weights.size === 0) {
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.name, s.neighborhood, s.city, s.website, s.is_indie,
              (SELECT COUNT(*) FROM events e WHERE e.store_id = s.id AND e.status = 'published' AND e.starts_at >= ?) AS upcoming
       FROM stores s
       WHERE s.is_indie = 1 AND (? IS NULL OR s.city = ?)
       ORDER BY upcoming DESC, s.name
       LIMIT ?`,
    )
      .bind(now, city, city, limit)
      .all();
    return (results || []).map((row) => ({
      ...row,
      reason: row.upcoming ? "Has events coming up" : "A good place to start exploring",
      matchedTags: [],
    }));
  }

  const { results: candidates } = await env.DB.prepare(
    `SELECT s.id, s.name, s.neighborhood, s.city, s.website, s.is_indie,
            (SELECT COUNT(*) FROM events e WHERE e.store_id = s.id AND e.status = 'published' AND e.starts_at >= ?) AS upcoming
     FROM stores s
     WHERE s.is_indie = 1 AND (? IS NULL OR s.city = ?)
     LIMIT 400`,
  )
    .bind(now, city, city)
    .all();

  const { results: osmTags } = await env.DB.prepare(
    `SELECT t.store_id, t.tag, 1.5 AS weight FROM store_tags t`,
  ).all();
  const { results: vibeTags } = await env.DB.prepare(
    `SELECT store_id, tag, COUNT(*) AS weight FROM store_vibes GROUP BY store_id, tag`,
  ).all();

  const tagsByStore = tagIndex([...(osmTags || []), ...(vibeTags || [])].map((row) => ({
    store_id: row.store_id,
    tag: row.tag,
    weight: Number(row.weight) || 1,
  })));

  const scored = [];
  for (const store of candidates || []) {
    if (favoriteIds.has(store.id)) continue;
    const storeTags = tagsByStore.get(store.id);
    let score = 0;
    const matched = [];
    if (storeTags) {
      for (const [tag, weight] of storeTags) {
        const target = weights.get(tag);
        if (!target) continue;
        score += target * Math.min(weight, 3);
        matched.push(tag);
      }
    }
    if (store.upcoming) score += 1.5;
    if (score <= 0) continue;
    const favoriteId = matched.map((tag) => tagToFavorite.get(tag)).find(Boolean);
    const favoriteName = (favorites || []).find((row) => row.id === favoriteId)?.name;
    scored.push({
      ...store,
      score,
      matchedTags: matched.slice(0, 3),
      reason: favoriteName
        ? `Because you follow ${favoriteName}`
        : `Matches your ${matched[0] ? matched[0].replace(/-/g, " ") : "reading"} taste`,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
