# Data sources

## `osm-raw.json`

An Overpass API export of every `shop=books` element inside the three pilot-city bounding boxes:

- Singapore: `1.15,103.60,1.48,104.10`
- New York City: `40.49,-74.26,40.92,-73.70`
- Chicago: `41.64,-87.94,42.03,-87.52`

Fetched 22 November 2026. 357 elements, 349 usable bookshops after filtering.

**© OpenStreetMap contributors, licensed under the [Open Database License (ODbL) 1.0](https://www.openstreetmap.org/copyright).** Any derived database published from this data must keep the same licence and attribution. Do not hand-edit this file; re-fetch it and rebuild the seed instead.

## `seed.sql` (generated, not committed)

Produced by `node scripts/build-seed.mjs`. It normalizes names, addresses and coordinates, flags chains, and derives only factual tags (`second_hand`, `cafe`, `wheelchair`). Re-running it is an upsert, so favourites, vibes and events are preserved.

## `tag-overrides.json` (optional)

Manual corrections keyed by store id, merged into the seed:

```json
{ "osm-node-123456": ["cozy", "staff-picks"] }
```

Use it for tags a human has actually verified, not for guesses.
