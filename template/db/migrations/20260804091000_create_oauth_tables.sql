-- migrate:up
CREATE TABLE oauth_clients (
  client_id                  TEXT PRIMARY KEY,
  client_secret              TEXT,
  client_name                TEXT NOT NULL,
  redirect_uris              TEXT NOT NULL,
  grant_types                TEXT NOT NULL,
  response_types             TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  scope                      TEXT,
  client_uri                 TEXT,
  software_id                TEXT,
  software_version           TEXT,
  client_id_issued_at        INTEGER NOT NULL,
  client_secret_expires_at   INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_oauth_clients_created_at ON oauth_clients (created_at);

CREATE TABLE oauth_authorization_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  redirect_uri          TEXT NOT NULL,
  scopes                TEXT,
  resource              TEXT,
  expires_at            INTEGER NOT NULL,
  used                  INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_oauth_codes_client_user ON oauth_authorization_codes (client_id, user_id);

CREATE TABLE oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  scopes     TEXT,
  resource   TEXT,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_oauth_access_user   ON oauth_access_tokens (user_id);
CREATE INDEX idx_oauth_access_client ON oauth_access_tokens (client_id);

CREATE TABLE oauth_refresh_tokens (
  token_hash        TEXT PRIMARY KEY,
  access_token_hash TEXT REFERENCES oauth_access_tokens (token_hash) ON DELETE SET NULL,
  client_id         TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL,
  scopes            TEXT,
  resource          TEXT,
  expires_at        INTEGER NOT NULL,
  revoked           INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
  replaced_by_hash  TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_oauth_refresh_user   ON oauth_refresh_tokens (user_id);
CREATE INDEX idx_oauth_refresh_client ON oauth_refresh_tokens (client_id);

CREATE TABLE oauth_pending_authorizations (
  pending_id            TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  redirect_uri          TEXT NOT NULL,
  scopes                TEXT,
  state                 TEXT,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  resource              TEXT,
  expires_at            INTEGER NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_oauth_pending_client ON oauth_pending_authorizations (client_id);

-- migrate:down
