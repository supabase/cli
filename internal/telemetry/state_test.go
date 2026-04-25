package telemetry

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTelemetryPath(t *testing.T) {
	t.Run("uses SUPABASE_HOME when set", func(t *testing.T) {
		t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
		t.Setenv("HOME", "/tmp/ignored-home")

		path, err := telemetryPath()

		require.NoError(t, err)
		assert.Equal(t, "/tmp/supabase-home/telemetry.json", path)
	})

	t.Run("falls back to HOME/.supabase", func(t *testing.T) {
		t.Setenv("SUPABASE_HOME", "")
		t.Setenv("HOME", "/tmp/home")

		path, err := telemetryPath()

		require.NoError(t, err)
		assert.Equal(t, "/tmp/home/.supabase/telemetry.json", path)
	})
}

func TestLoadOrCreateState(t *testing.T) {
	now := time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC)

	t.Run("creates default state and writes it", func(t *testing.T) {
		t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
		fsys := afero.NewMemMapFs()

		state, created, err := LoadOrCreateState(fsys, now)

		require.NoError(t, err)
		assert.True(t, created)
		assert.True(t, state.Enabled)
		assert.Equal(t, SchemaVersion, state.SchemaVersion)
		assert.Equal(t, now, state.SessionLastActive)
		assert.Empty(t, state.DistinctID)
		assert.NoError(t, uuid.Validate(state.DeviceID))
		assert.NoError(t, uuid.Validate(state.SessionID))

		saved, err := LoadState(fsys)
		require.NoError(t, err)
		assert.Equal(t, state, saved)
	})

	t.Run("updates last active and preserves existing state", func(t *testing.T) {
		t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
		fsys := afero.NewMemMapFs()
		initial := State{
			Enabled:           false,
			DeviceID:          uuid.NewString(),
			SessionID:         uuid.NewString(),
			SessionLastActive: now.Add(-10 * time.Minute),
			DistinctID:        "user-123",
			SchemaVersion:     SchemaVersion,
		}
		require.NoError(t, SaveState(initial, fsys))

		state, created, err := LoadOrCreateState(fsys, now)

		require.NoError(t, err)
		assert.False(t, created)
		assert.False(t, state.Enabled)
		assert.Equal(t, initial.DeviceID, state.DeviceID)
		assert.Equal(t, initial.SessionID, state.SessionID)
		assert.Equal(t, "user-123", state.DistinctID)
		assert.Equal(t, now, state.SessionLastActive)
	})

	t.Run("recovers from corrupted state file", func(t *testing.T) {
		// Each entry simulates a real-world corruption shape we've observed.
		corruptions := map[string][]byte{
			"empty file":             []byte{},
			"truncated json":         []byte(`{"enabled":tru`),
			"session_last_active is a number (not a string)": []byte(`{"enabled":true,"device_id":"d","session_id":"s","session_last_active":1776770348993,"schema_version":1}`),
			"session_last_active is a malformed string":      []byte(`{"enabled":true,"device_id":"d","session_id":"s","session_last_active":"not-a-time","schema_version":1}`),
		}
		for label, contents := range corruptions {
			t.Run(label, func(t *testing.T) {
				t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
				fsys := afero.NewMemMapFs()
				path, err := telemetryPath()
				require.NoError(t, err)
				require.NoError(t, fsys.MkdirAll("/tmp/supabase-home", 0755))
				require.NoError(t, afero.WriteFile(fsys, path, contents, 0644))

				state, created, err := LoadOrCreateState(fsys, now)

				require.NoError(t, err)
				assert.True(t, created)
				assert.True(t, state.Enabled)
				assert.Equal(t, SchemaVersion, state.SchemaVersion)
				assert.NoError(t, uuid.Validate(state.DeviceID))
				assert.NoError(t, uuid.Validate(state.SessionID))
				saved, err := LoadState(fsys)
				require.NoError(t, err)
				assert.Equal(t, state, saved)
			})
		}
	})

	t.Run("rotates stale session after inactivity threshold", func(t *testing.T) {
		t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
		fsys := afero.NewMemMapFs()
		initial := State{
			Enabled:           true,
			DeviceID:          uuid.NewString(),
			SessionID:         uuid.NewString(),
			SessionLastActive: now.Add(-(sessionRotationThreshold + time.Minute)),
			DistinctID:        "user-123",
			SchemaVersion:     SchemaVersion,
		}
		require.NoError(t, SaveState(initial, fsys))

		state, created, err := LoadOrCreateState(fsys, now)

		require.NoError(t, err)
		assert.False(t, created)
		assert.Equal(t, initial.DeviceID, state.DeviceID)
		assert.NotEqual(t, initial.SessionID, state.SessionID)
		assert.Equal(t, "user-123", state.DistinctID)
		assert.Equal(t, now, state.SessionLastActive)

		saved, err := LoadState(fsys)
		require.NoError(t, err)
		assert.Equal(t, state, saved)
	})
}

func TestTelemetryDisabled(t *testing.T) {
	now := time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC)

	t.Run("honors DO_NOT_TRACK", func(t *testing.T) {
		t.Setenv("DO_NOT_TRACK", "1")
		fsys := afero.NewMemMapFs()

		disabled, err := Disabled(fsys, now)

		require.NoError(t, err)
		assert.True(t, disabled)
	})

	t.Run("honors SUPABASE_TELEMETRY_DISABLED", func(t *testing.T) {
		t.Setenv("SUPABASE_TELEMETRY_DISABLED", "1")
		fsys := afero.NewMemMapFs()

		disabled, err := Disabled(fsys, now)

		require.NoError(t, err)
		assert.True(t, disabled)
	})

	t.Run("honors disabled state file", func(t *testing.T) {
		t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
		fsys := afero.NewMemMapFs()
		require.NoError(t, SaveState(State{
			Enabled:           false,
			DeviceID:          uuid.NewString(),
			SessionID:         uuid.NewString(),
			SessionLastActive: now,
			SchemaVersion:     SchemaVersion,
		}, fsys))

		disabled, err := Disabled(fsys, now)

		require.NoError(t, err)
		assert.True(t, disabled)
	})

	t.Run("creates enabled state when missing", func(t *testing.T) {
		t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
		fsys := afero.NewMemMapFs()

		disabled, err := Disabled(fsys, now)

		require.NoError(t, err)
		assert.False(t, disabled)
	})
}

func TestSetEnabledAndStatus(t *testing.T) {
	now := time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC)

	t.Run("disable preserves identity fields", func(t *testing.T) {
		t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
		fsys := afero.NewMemMapFs()
		initial, _, err := LoadOrCreateState(fsys, now)
		require.NoError(t, err)
		initial.DistinctID = "user-123"
		require.NoError(t, SaveState(initial, fsys))

		state, err := SetEnabled(fsys, false, now.Add(time.Minute))

		require.NoError(t, err)
		assert.False(t, state.Enabled)
		assert.Equal(t, initial.DeviceID, state.DeviceID)
		assert.Equal(t, initial.SessionID, state.SessionID)
		assert.Equal(t, "user-123", state.DistinctID)
	})

	t.Run("enable flips disabled state back on", func(t *testing.T) {
		t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
		fsys := afero.NewMemMapFs()
		require.NoError(t, SaveState(State{
			Enabled:           false,
			DeviceID:          uuid.NewString(),
			SessionID:         uuid.NewString(),
			SessionLastActive: now,
			SchemaVersion:     SchemaVersion,
		}, fsys))

		state, err := SetEnabled(fsys, true, now.Add(time.Minute))

		require.NoError(t, err)
		assert.True(t, state.Enabled)
	})

	t.Run("status creates default state when missing", func(t *testing.T) {
		t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
		fsys := afero.NewMemMapFs()

		state, created, err := Status(fsys, now)

		require.NoError(t, err)
		assert.True(t, created)
		assert.True(t, state.Enabled)
		assert.NoError(t, uuid.Validate(state.DeviceID))
	})
}
