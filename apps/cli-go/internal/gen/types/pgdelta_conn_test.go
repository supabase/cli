package types

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestEnsurePgDeltaSSL(t *testing.T) {
	t.Run("adds verify-ca when sslmode is absent", func(t *testing.T) {
		input := "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?connect_timeout=10"
		got := ensurePgDeltaSSL(input, "")
		assert.Contains(t, got, "sslmode=verify-ca")
		assert.Contains(t, got, "connect_timeout=10")
	})

	t.Run("preserves existing verify-ca", func(t *testing.T) {
		input := "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=verify-ca"
		assert.Equal(t, input, ensurePgDeltaSSL(input, ""))
	})

	t.Run("preserves existing verify-full", func(t *testing.T) {
		input := "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=verify-full"
		assert.Equal(t, input, ensurePgDeltaSSL(input, ""))
	})

	t.Run("replaces require with verify-ca", func(t *testing.T) {
		input := "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=require"
		got := ensurePgDeltaSSL(input, "")
		assert.Contains(t, got, "sslmode=verify-ca")
		assert.NotContains(t, got, "sslmode=require")
	})

	t.Run("adds the sslrootcert path when provided", func(t *testing.T) {
		input := "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?connect_timeout=10"
		got := ensurePgDeltaSSL(input, "/workspace/supabase/.temp/pgdelta/pgdelta-target-ca.crt")
		assert.Contains(t, got, "sslmode=verify-ca")
		assert.Contains(t, got, "sslrootcert=%2Fworkspace%2Fsupabase%2F.temp%2Fpgdelta%2Fpgdelta-target-ca.crt")
	})
}

func TestIsSupabaseHostedPostgresURL(t *testing.T) {
	assert.True(t, isSupabaseHostedPostgresURL("postgresql://postgres@db.ref.supabase.co:5432/postgres"))
	assert.True(t, isSupabaseHostedPostgresURL("postgresql://supabase_admin@aws-0-us-east-2.pooler.supabase.com:5432/postgres"))
	assert.True(t, isSupabaseHostedPostgresURL("postgresql://supabase_admin@pooler.supabase.com:5432/postgres"))
	assert.False(t, isSupabaseHostedPostgresURL("postgresql://postgres@localhost:5432/postgres"))
	// Suffix match rejects look-alike hostnames that merely contain the
	// pooler domain as a substring (e.g. an attacker-controlled host like
	// pooler.supabase.com.example.org).
	assert.False(t, isSupabaseHostedPostgresURL("postgresql://postgres@pooler.supabase.com.example.org:5432/postgres"))
}

func TestCABundleFilename(t *testing.T) {
	assert.Equal(t, "pgdelta-source-ca.crt", caBundleFilename(PgDeltaSourceSSLRootCert))
	assert.Equal(t, "pgdelta-target-ca.crt", caBundleFilename(PgDeltaTargetSSLRootCert))
	assert.Equal(t, "pgdelta-ca.crt", caBundleFilename(""))
}

func TestPreparePgDeltaPostgresRefNonPostgres(t *testing.T) {
	ref, env, err := PreparePgDeltaPostgresRef(t.Context(), "supabase/.temp/catalog.json", PgDeltaTargetSSLRootCert)
	assert.NoError(t, err)
	assert.Equal(t, "supabase/.temp/catalog.json", ref)
	assert.Empty(t, env)
}
