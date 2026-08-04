-- migrate:up
-- OAuth 2.1 mit Dynamic Client Registration fuer den MCP-Endpunkt. Ein
-- MCP-Client (z.B. Claude) registriert sich selbst, schickt den Nutzer zur
-- Consent-Seite dieser App, und bekommt danach Access-/Refresh-Token. Die
-- Nutzer-Identitaet stammt dabei aus der bestehenden Web-Anmeldung
-- (aktuell PocketBase, siehe src/server/auth/) — dieser Teil hier verwaltet
-- nur die MCP-Tokens.

-- Registrierte Clients (via DCR oder manuell)
CREATE TABLE oauth_clients (
  client_id                  TEXT PRIMARY KEY,
  client_secret              TEXT,                          -- NULL bei public clients (PKCE)
  client_name                TEXT NOT NULL,
  redirect_uris              TEXT NOT NULL,                 -- JSON-Array
  grant_types                TEXT NOT NULL,                 -- JSON-Array
  response_types             TEXT NOT NULL,                 -- JSON-Array
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  scope                      TEXT,
  client_uri                 TEXT,
  software_id                TEXT,
  software_version           TEXT,
  client_id_issued_at        INTEGER NOT NULL,              -- unix seconds
  client_secret_expires_at   INTEGER NOT NULL DEFAULT 0,    -- 0 = never
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_oauth_clients_created_at ON oauth_clients (created_at);

-- Authorization Codes (kurzlebig, single-use)
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

-- Access Tokens (1h TTL). Gespeichert wird nur der sha256-Hash.
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

-- Refresh Tokens (30d TTL, rotierend)
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

-- Zwischenstand zwischen /authorize und der Consent-Seite: dorthin wird der
-- Nutzer umgeleitet, erst nach seiner Zustimmung entsteht ein echter Code.
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
-- forward-only, absichtlich leer
