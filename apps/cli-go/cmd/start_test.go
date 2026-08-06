package cmd

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

// internal/start was deleted outright (CLI-1966): the previous full/bundled
// build split relied on `cli-go-ci.yml`'s "Start" job to verify this error
// text -- and the command/flag/`__complete` surface below -- against a real
// binary. That job is gone along with the split, so this test is now the
// only thing pinning the stub's exact behavior.
func TestStartIsUnavailable(t *testing.T) {
	// utils.CmdSuggestion is a shared package global other tests in this
	// package also mutate (see TestEnsureLocalPostgresImageCurrent) -- reset
	// and restore it so this test neither depends on run order nor leaks its
	// suggestion into whatever runs after it.
	original := utils.CmdSuggestion
	t.Cleanup(func() { utils.CmdSuggestion = original })
	utils.CmdSuggestion = ""

	err := startCmd.RunE(startCmd, nil)

	require.Error(t, err)
	assert.EqualError(t, err, "start is not available in supabase-go; the Supabase CLI's start command talks to Docker directly and does not use this binary")
	assert.Contains(t, utils.CmdSuggestion, "supabase start")
}

// Pins the cobra registration/flag surface cmd/start.go keeps around solely
// for --help/__complete parity now that RunE never reads any of these flags.
func TestStartCommandSurface(t *testing.T) {
	require.Same(t, rootCmd, startCmd.Parent())

	excludeFlag := startCmd.Flags().Lookup("exclude")
	require.NotNil(t, excludeFlag)
	assert.False(t, excludeFlag.Hidden)

	ignoreHealthCheckFlag := startCmd.Flags().Lookup("ignore-health-check")
	require.NotNil(t, ignoreHealthCheckFlag)
	assert.False(t, ignoreHealthCheckFlag.Hidden)

	previewFlag := startCmd.Flags().Lookup("preview")
	require.NotNil(t, previewFlag)
	assert.True(t, previewFlag.Hidden)
}
