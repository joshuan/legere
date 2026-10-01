ALTER TYPE "ApiTokenScope" ADD VALUE 'MCP';
ALTER TYPE "ApiTokenScope" ADD VALUE 'INTEGRATION';

CREATE TABLE integrations (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE INDEX integrations_user_id_idx ON integrations(user_id);

CREATE TABLE oauth_clients (
  id uuid PRIMARY KEY, name text NOT NULL, redirect_uris text[] NOT NULL,
  auth_method text NOT NULL CHECK (auth_method IN ('none', 'client_secret_basic', 'client_secret_post')),
  secret_hash text, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((auth_method = 'none') = (secret_hash IS NULL))
);
CREATE TABLE oauth_grants (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  client_id uuid NOT NULL REFERENCES oauth_clients(id), client_name text NOT NULL,
  resource text NOT NULL, scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX oauth_grants_user_id_idx ON oauth_grants(user_id);
CREATE INDEX oauth_grants_client_id_idx ON oauth_grants(client_id);
CREATE TABLE oauth_codes (
  hash text PRIMARY KEY, grant_id uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL, code_challenge text NOT NULL, expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX oauth_codes_grant_id_idx ON oauth_codes(grant_id);
CREATE TABLE oauth_refresh_tokens (
  hash text PRIMARY KEY, grant_id uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE INDEX oauth_refresh_tokens_grant_id_idx ON oauth_refresh_tokens(grant_id);

ALTER TABLE api_tokens
  ADD COLUMN integration_id uuid REFERENCES integrations(id),
  ADD COLUMN oauth_grant_id uuid REFERENCES oauth_grants(id),
  ADD CONSTRAINT api_tokens_credential_binding CHECK (
    (integration_id IS NULL OR oauth_grant_id IS NULL)
    AND (scope::text = 'INTEGRATION') = (integration_id IS NOT NULL)
    AND (scope::text = 'MCP') = (oauth_grant_id IS NOT NULL)
  );
CREATE INDEX api_tokens_integration_id_idx ON api_tokens(integration_id);
CREATE INDEX api_tokens_oauth_grant_id_idx ON api_tokens(oauth_grant_id);
ALTER TABLE archive_items
  ADD COLUMN created_via jsonb,
  ADD COLUMN integration_id uuid REFERENCES integrations(id);
CREATE INDEX archive_items_integration_id_created_at_id_idx
  ON archive_items(integration_id, created_at DESC, id DESC);
ALTER TABLE document_events ADD COLUMN actor_agent jsonb;
