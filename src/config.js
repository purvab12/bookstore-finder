export const CITIES = [
  { id: "new-york", name: "New York City", region: "North America", center: [40.7128, -74.006], zoom: 12 },
  { id: "chicago", name: "Chicago", region: "North America", center: [41.8781, -87.6298], zoom: 11 },
  { id: "singapore", name: "Singapore", region: "Asia", center: [1.3521, 103.8198], zoom: 12 },
];

export const CITY_IDS = CITIES.map((city) => city.id);

export const TAG_GROUPS = {
  selection: [
    { id: "used-books", label: "Used books", emoji: "♻️" },
    { id: "sci-fi", label: "Sci-fi & fantasy", emoji: "🚀" },
    { id: "romance", label: "Romance", emoji: "💌" },
    { id: "mystery", label: "Mystery & thriller", emoji: "🕵️" },
    { id: "poetry", label: "Poetry", emoji: "🪶" },
    { id: "nonfiction", label: "Nonfiction", emoji: "🧠" },
    { id: "local-authors", label: "Local authors", emoji: "✍️" },
    { id: "art-design", label: "Art & design", emoji: "🎨" },
    { id: "kids-books", label: "Kids' books", emoji: "🧸" },
    { id: "zines", label: "Zines & small press", emoji: "📰" },
  ],
  atmosphere: [
    { id: "cozy", label: "Cozy", emoji: "🧣" },
    { id: "quiet", label: "Quiet", emoji: "🤫" },
    { id: "bright", label: "Bright", emoji: "☀️" },
    { id: "browse", label: "Browse for hours", emoji: "🌀" },
    { id: "spacious", label: "Room to roam", emoji: "🌿" },
  ],
  experience: [
    { id: "staff-picks", label: "Great staff picks", emoji: "💬" },
    { id: "events", label: "Author events", emoji: "🎤" },
    { id: "book-club", label: "Book clubs", emoji: "👯" },
    { id: "cafe", label: "Café", emoji: "☕" },
  ],
  practical: [
    { id: "budget", label: "Budget-friendly", emoji: "🪙" },
    { id: "accessible", label: "Step-free access", emoji: "♿" },
    { id: "open-late", label: "Open late", emoji: "🌙" },
  ],
};

export const ALL_TAGS = Object.values(TAG_GROUPS).flat();
export const TAG_IDS = new Set(ALL_TAGS.map((tag) => tag.id));
export const TAG_LABELS = new Map(ALL_TAGS.map((tag) => [tag.id, tag.label]));

export const GENRES = [
  "Literary fiction",
  "Romance",
  "Sci-fi & fantasy",
  "Mystery & thriller",
  "Horror",
  "Poetry",
  "Nonfiction",
  "Graphic novels",
  "Young adult",
  "Historical fiction",
];

// Which shop tags are evidence that a store serves a reader's genre taste.
export const GENRE_TAGS = {
  "Literary fiction": ["local-authors", "staff-picks"],
  Romance: ["romance"],
  "Sci-fi & fantasy": ["sci-fi"],
  "Mystery & thriller": ["mystery"],
  Horror: [],
  Poetry: ["poetry"],
  Nonfiction: ["nonfiction"],
  "Graphic novels": ["zines", "art-design"],
  "Young adult": ["kids-books"],
  "Historical fiction": ["local-authors"],
};

// Subject headings used with the Open Library search API.
export const GENRE_SUBJECTS = {
  "Literary fiction": "literary fiction",
  Romance: "romance",
  "Sci-fi & fantasy": "fantasy",
  "Mystery & thriller": "mystery",
  Horror: "horror",
  Poetry: "poetry",
  Nonfiction: "nonfiction",
  "Graphic novels": "comic books and graphic novels",
  "Young adult": "young adult fiction",
  "Historical fiction": "historical fiction",
};

export const EVENT_KINDS = [
  "Author event",
  "Reading",
  "Book club",
  "Signing",
  "Workshop",
  "Storytime",
  "Launch party",
  "Other",
];
