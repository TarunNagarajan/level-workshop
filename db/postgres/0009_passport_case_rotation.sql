CREATE TABLE passport_scenario_counter (id INTEGER PRIMARY KEY, value BIGINT NOT NULL DEFAULT 0);
INSERT INTO passport_scenario_counter (id, value) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
