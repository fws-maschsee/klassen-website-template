-- migrate:up
ALTER TABLE oauth_authorization_codes ADD COLUMN roles TEXT;
ALTER TABLE oauth_access_tokens       ADD COLUMN roles TEXT;
ALTER TABLE oauth_refresh_tokens      ADD COLUMN roles TEXT;

-- migrate:down
