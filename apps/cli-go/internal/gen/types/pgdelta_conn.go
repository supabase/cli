package types

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v4"
)

const (
	PgDeltaSourceSSLRootCert = "PGDELTA_SOURCE_SSLROOTCERT"
	PgDeltaTargetSSLRootCert = "PGDELTA_TARGET_SSLROOTCERT"
	pgDeltaCABundleRelPath   = "supabase/.temp/pgdelta/supabase-ca-bundle.crt"
)

func isPostgresURL(ref string) bool {
	return strings.HasPrefix(ref, "postgres://") || strings.HasPrefix(ref, "postgresql://")
}

func isSupabaseHostedPostgresURL(dbURL string) bool {
	parsed, err := url.Parse(dbURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return strings.HasSuffix(host, ".supabase.co") ||
		strings.Contains(host, "pooler.supabase.com")
}

// pgDeltaRootCA returns the CA bundle pg-delta should use for a Postgres URL.
// Supabase-hosted databases always receive the embedded bundle even when the
// SSL probe is skipped (for example in --debug mode).
func pgDeltaRootCA(ctx context.Context, dbURL string, options ...func(*pgx.ConnConfig)) (string, error) {
	ca, err := GetRootCA(ctx, dbURL, options...)
	if err != nil {
		return "", err
	}
	if len(ca) > 0 {
		return ca, nil
	}
	if isSupabaseHostedPostgresURL(dbURL) {
		return caStaging + caProd + caSnap, nil
	}
	return "", nil
}

// PreparePgDeltaPostgresRef configures a Postgres URL and env vars for pg-delta.
//
// pg-delta disables TLS when sslmode is absent and only reads PGDELTA_*_SSLROOTCERT
// for verify-ca/verify-full. Remote Supabase databases require verify-ca plus a
// CA bundle written into the workspace so edge-runtime can read it from disk.
func PreparePgDeltaPostgresRef(
	ctx context.Context,
	ref string,
	sslRootCertEnv string,
	options ...func(*pgx.ConnConfig),
) (string, []string, error) {
	if !isPostgresURL(ref) {
		return ref, nil, nil
	}
	ca, err := pgDeltaRootCA(ctx, ref, options...)
	if err != nil {
		return "", nil, err
	}
	if len(ca) == 0 {
		return ref, nil, nil
	}
	containerCertPath, err := writePgDeltaCABundleFile(ca)
	if err != nil {
		return "", nil, err
	}
	return ensurePgDeltaSSL(ref, containerCertPath), []string{sslRootCertEnv + "=" + ca}, nil
}

func writePgDeltaCABundleFile(ca string) (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	abs := filepath.Join(cwd, pgDeltaCABundleRelPath)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(abs, []byte(ca), 0o644); err != nil {
		return "", err
	}
	return "/workspace/" + filepath.ToSlash(pgDeltaCABundleRelPath), nil
}

func ensurePgDeltaSSL(dbURL, sslrootcertPath string) string {
	parsed, err := url.Parse(dbURL)
	if err != nil {
		return dbURL
	}
	query := parsed.Query()
	switch query.Get("sslmode") {
	case "verify-ca", "verify-full":
	default:
		query.Set("sslmode", "verify-ca")
	}
	if len(sslrootcertPath) > 0 {
		query.Set("sslrootcert", sslrootcertPath)
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

// EnsurePgDeltaVerifyCA is kept for tests that assert URL sslmode behaviour.
func EnsurePgDeltaVerifyCA(dbURL string) string {
	return ensurePgDeltaSSL(dbURL, "")
}
