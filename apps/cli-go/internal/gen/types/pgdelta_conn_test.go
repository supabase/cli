package types

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestEnsurePgDeltaVerifyCA(t *testing.T) {
	t.Run("adds verify-ca when sslmode is absent", func(t *testing.T) {
		input := "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?connect_timeout=10"
		got := EnsurePgDeltaVerifyCA(input)
		assert.Contains(t, got, "sslmode=verify-ca")
		assert.Contains(t, got, "connect_timeout=10")
	})

	t.Run("preserves existing verify-ca", func(t *testing.T) {
		input := "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=verify-ca"
		assert.Equal(t, input, EnsurePgDeltaVerifyCA(input))
	})

	t.Run("preserves existing verify-full", func(t *testing.T) {
		input := "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=verify-full"
		assert.Equal(t, input, EnsurePgDeltaVerifyCA(input))
	})

	t.Run("replaces require with verify-ca", func(t *testing.T) {
		input := "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=require"
		got := EnsurePgDeltaVerifyCA(input)
		assert.Contains(t, got, "sslmode=verify-ca")
		assert.NotContains(t, got, "sslmode=require")
	})
}

func TestEnsurePgDeltaSSLAddsRootCertPath(t *testing.T) {
	input := "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?connect_timeout=10"
	got := ensurePgDeltaSSL(input, "/workspace/supabase/.temp/pgdelta/supabase-ca-bundle.crt")
	assert.Contains(t, got, "sslmode=verify-ca")
	assert.Contains(t, got, "sslrootcert=%2Fworkspace%2Fsupabase%2F.temp%2Fpgdelta%2Fsupabase-ca-bundle.crt")
}

func TestIsSupabaseHostedPostgresURL(t *testing.T) {
	assert.True(t, isSupabaseHostedPostgresURL("postgresql://postgres@db.ref.supabase.co:5432/postgres"))
	assert.True(t, isSupabaseHostedPostgresURL("postgresql://supabase_admin@aws-0-us-east-2.pooler.supabase.com:5432/postgres"))
	assert.False(t, isSupabaseHostedPostgresURL("postgresql://postgres@localhost:5432/postgres"))
}

func TestPreparePgDeltaPostgresRefNonPostgres(t *testing.T) {
	ref, env, err := PreparePgDeltaPostgresRef(t.Context(), "supabase/.temp/catalog.json", PgDeltaTargetSSLRootCert)
	assert.NoError(t, err)
	assert.Equal(t, "supabase/.temp/catalog.json", ref)
	assert.Empty(t, env)
}
