-- A pick can be saved to a reader's shelf. Resolve the book lazily on first save
-- and remember it so repeat saves do not call Open Library again.
ALTER TABLE staff_picks ADD COLUMN book_id TEXT REFERENCES books(id) ON DELETE SET NULL;
