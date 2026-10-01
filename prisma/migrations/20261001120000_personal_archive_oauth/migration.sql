ALTER TYPE "ApiTokenScope" ADD VALUE 'ARCHIVE';
ALTER TABLE oauth_clients ADD COLUMN scope text NOT NULL DEFAULT 'mcp:read';
ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_credential_binding;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_credential_binding CHECK (
  (integration_id IS NULL OR oauth_grant_id IS NULL)
  AND (scope::text = 'INTEGRATION') = (integration_id IS NOT NULL)
  AND (scope::text IN ('MCP', 'ARCHIVE')) = (oauth_grant_id IS NOT NULL)
);
