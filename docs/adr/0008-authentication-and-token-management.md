# 0008. Authentication & Token Management

**Status**: proposed
**Date**: 2026-02-10

## Problem Statement

Auth is referenced in ADRs 0001 (error codes 3/AUTH_*), 0002 (identity lifecycle), 0004 (command surface), and 0006 (user_id for env management) — but no ADR captures the actual design decisions for how login, token storage, and multi-profile work.

The new `supabase` CLI should be compatible with the existing Go CLI's credential store so users don't need to re-login when switching between CLIs.

## Key Decisions to Cover

- **Login flow**: Keep the browser-based ECDH login flow? Or switch to standard OAuth device flow?
- **Token storage**: Keep keyring-first storage with file fallback? Token loading priority (env var → keyring → legacy keyring → token file)?
- **Token format**: Keep the `sbp_` token format validation (`^sbp_(oauth_)?[a-f0-9]{40}$`)?
- **Legacy token migration**: How should the CLI handle any legacy on-disk token formats while reading old tokens?
- **Profile system**: Keep built-in profiles (supabase, supabase-staging, supabase-local, snap) or simplify to user-defined profiles?
- **Backward compatibility**: Should `supabase login` detect an existing Go CLI token and reuse it?
- **Token refresh**: Keep the no-refresh model (long-lived, server-managed expiry) or add refresh tokens?

## Context: How Auth Works in the Go CLI

**Login flow** — Browser-based with end-to-end encryption:
1. CLI generates a session UUID and an ECDH P256 keypair
2. Opens browser to `https://supabase.com/dashboard/cli/login?session_id=...&public_key=...&token_name=cli_<user>@<host>_<timestamp>`
3. User authenticates in browser; dashboard encrypts the access token with the CLI's public key via ECDH + AES-GCM
4. CLI polls `GET /platform/cli/login/<session_id>` until it gets the encrypted token
5. CLI decrypts using ECDH shared secret + AES-GCM, validates format, stores token
6. Alternative: `supabase login --token <token>` for non-interactive (CI)

**Token storage** — Multi-tier with fallback:
1. **System keyring** (primary) — via `zalando/go-keyring`: macOS Keychain, Linux Secret Service, Windows Credential Manager. Namespace: `"Supabase CLI"`, key: profile name
2. **Token file** (fallback) — `~/.supabase/access-token`, plain text, `0600` permissions. Used when keyring is unavailable

**Token loading priority**:
1. `SUPABASE_ACCESS_TOKEN` env var (highest)
2. Keyring for current profile
3. Legacy keyring key (`"access-token"` — backward compat)
4. Token file `~/.supabase/access-token`

**No token refresh** — Tokens are long-lived, server-managed expiry. User must re-login when expired.

## Related Decisions

- [ADR 0001](0001-cli-dx-architecture-pillars.md): CLI DX Architecture — error codes (3/AUTH_*)
- [ADR 0002](0002-cli-product-metrics.md): CLI Product Metrics — identity lifecycle
- [ADR 0004](0004-cli-design-goals-and-workflows.md): CLI Design Goals — login/logout commands
- [ADR 0006](0006-environment-management.md): Environment Management — user_id for env management
