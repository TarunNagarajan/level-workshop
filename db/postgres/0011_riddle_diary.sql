CREATE TABLE diary_sessions (
  round_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE RESTRICT,
  state TEXT NOT NULL
);
