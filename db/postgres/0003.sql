CREATE TABLE passport_sessions (round_id TEXT PRIMARY KEY REFERENCES rounds(id), state TEXT NOT NULL);
