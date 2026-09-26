-- migrate:up
CREATE TABLE group_memberships (
  group_key   TEXT NOT NULL REFERENCES groups (key) ON DELETE CASCADE,
  mitglied_id TEXT NOT NULL REFERENCES mitglieder (id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (group_key, mitglied_id)
);

CREATE INDEX idx_group_memberships_mitglied ON group_memberships (mitglied_id);

-- migrate:down
