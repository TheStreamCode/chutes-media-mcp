# Migrating from 1.x

The 2.0 release makes the safety boundaries enforceable instead of best-effort.

- Existing named assets are preserved unless `overwrite` (CLI: `--overwrite`) is explicitly set.
- Input and output paths must resolve inside the current workspace; symlink and junction escapes are
  rejected.
- Custom management API URLs require HTTPS, except loopback URLs used for local development. The
  Chutes API key is never attached to custom or loopback management endpoints.
- Management and invocation credentials are sent only to HTTPS Chutes hosts, and asset downloads
  must resolve to public HTTPS destinations.
- Responses and local input assets are capped by `CHUTES_MAX_ASSET_MB`, which defaults to 512 MiB.

If an existing automation intentionally replaces a file, add the explicit overwrite option after
confirming the target path.
