package start

import (
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSuggestFromUnhealthyLogs(t *testing.T) {
	t.Run("suggests recovery for exec format error", func(t *testing.T) {
		suggestion := SuggestFromUnhealthyLogs("exec /mailpit: exec format error\n")
		require.NotEmpty(t, suggestion)
		assert.Contains(t, suggestion, "exec format error")
		assert.Contains(t, suggestion, "supabase stop --no-backup")
		assert.Contains(t, suggestion, "supabase start")
		assert.Contains(t, suggestion, "linux/"+runtime.GOARCH)
	})

	t.Run("suggests recovery for storage migrations_name_key", func(t *testing.T) {
		logs := `Migration failed. Reason: duplicate key value violates unique constraint "migrations_name_key"`
		suggestion := SuggestFromUnhealthyLogs(logs)
		require.NotEmpty(t, suggestion)
		assert.Contains(t, suggestion, "Storage migrations failed")
		assert.Contains(t, suggestion, "supabase stop --no-backup")
		assert.Contains(t, suggestion, "supabase start")
	})

	t.Run("suggests recovery for studio invalid package config", func(t *testing.T) {
		logs := "Error: Invalid package config /app/apps/studio/node_modules/next/package.json.\n  code: 'ERR_INVALID_PACKAGE_CONFIG'"
		suggestion := SuggestFromUnhealthyLogs(logs)
		require.NotEmpty(t, suggestion)
		assert.Contains(t, suggestion, "Studio")
		assert.Contains(t, suggestion, "supabase stop --no-backup")
		assert.Contains(t, suggestion, "supabase start")
	})

	t.Run("combines multiple failure suggestions", func(t *testing.T) {
		logs := "exec /mailpit: exec format error\nmigrations_name_key\nERR_INVALID_PACKAGE_CONFIG"
		suggestion := SuggestFromUnhealthyLogs(logs)
		require.NotEmpty(t, suggestion)
		assert.Contains(t, suggestion, "exec format error")
		assert.Contains(t, suggestion, "Storage migrations failed")
		assert.Contains(t, suggestion, "Studio")
	})

	t.Run("returns empty for unrelated logs", func(t *testing.T) {
		assert.Empty(t, SuggestFromUnhealthyLogs("listening on :5432\nready\n"))
	})
}
