-- migrate:up
CREATE TABLE group_edges (
  parent_key TEXT NOT NULL REFERENCES groups (key) ON DELETE CASCADE,
  child_key  TEXT NOT NULL REFERENCES groups (key) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (parent_key, child_key),
  CHECK (parent_key <> child_key)
);

CREATE INDEX idx_group_edges_child ON group_edges (child_key);

-- migrate:down
