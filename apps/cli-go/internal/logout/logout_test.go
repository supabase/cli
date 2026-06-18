package logout

import (
	"context"
	"os"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	phtelemetry "github.com/supabase/cli/internal/telemetry"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/testing/fstest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/zalando/go-keyring"
)

type captureCall struct {
	distinctID string
	event      string
}

type fakeAnalytics struct {
	enabled  bool
	captures []captureCall
	aliases  []string
}

func (f *fakeAnalytics) Enabled() bool { return f.enabled }

func (f *fakeAnalytics) Capture(distinctID string, event string, properties map[string]any, groups map[string]string) error {
	f.captures = append(f.captures, captureCall{distinctID: distinctID, event: event})
	return nil
}

func (f *fakeAnalytics) Identify(distinctID string, properties map[string]any) error { return nil }

func (f *fakeAnalytics) Alias(distinctID string, alias string) error {
	f.aliases = append(f.aliases, distinctID)
	return nil
}

func (f *fakeAnalytics) GroupIdentify(groupType string, groupKey string, properties map[string]any) error {
	return nil
}

func (f *fakeAnalytics) Close() error { return nil }

func TestLogoutCommand(t *testing.T) {
	token := string(apitest.RandomAccessToken(t))

	t.Run("login with token and logout", func(t *testing.T) {
		keyring.MockInitWithError(keyring.ErrUnsupportedPlatform)
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.SaveAccessToken(token, fsys))
		// Run test
		err := Run(context.Background(), os.Stdout, fsys)
		// Check error
		assert.NoError(t, err)
		saved, err := utils.LoadAccessTokenFS(fsys)
		assert.ErrorIs(t, err, utils.ErrMissingToken)
		assert.Empty(t, saved)
	})

	t.Run("removes all Supabase CLI credentials", func(t *testing.T) {
		keyring.MockInit()
		require.NoError(t, credentials.StoreProvider.Set(utils.CurrentProfile.Name, token))
		require.NoError(t, credentials.StoreProvider.Set("project1", "password1"))
		require.NoError(t, credentials.StoreProvider.Set("project2", "password2"))
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Run test
		err := Run(context.Background(), os.Stdout, afero.NewMemMapFs())
		// Check error
		assert.NoError(t, err)
		// Check that access token has been removed
		saved, _ := credentials.StoreProvider.Get(utils.CurrentProfile.Name)
		assert.Empty(t, saved)
		// check that project 1 has been removed
		saved, _ = credentials.StoreProvider.Get("project1")
		assert.Empty(t, saved)
		// check that project 2 has been removed
		saved, _ = credentials.StoreProvider.Get("project2")
		assert.Empty(t, saved)
	})

	t.Run("clears telemetry identity from memory and disk", func(t *testing.T) {
		keyring.MockInit()
		t.Cleanup(fstest.MockStdin(t, "y"))
		t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
		fsys := afero.NewMemMapFs()
		require.NoError(t, utils.SaveAccessToken(token, fsys))
		analytics := &fakeAnalytics{enabled: true}
		service, err := phtelemetry.NewService(fsys, phtelemetry.Options{
			Analytics: analytics,
			IsTTY:     true,
		})
		require.NoError(t, err)
		require.NoError(t, service.StitchLogin("user-123"))
		ctx := phtelemetry.WithService(context.Background(), service)

		require.NoError(t, Run(ctx, os.Stdout, fsys))

		state, err := phtelemetry.LoadState(fsys)
		require.NoError(t, err)
		assert.Empty(t, state.DistinctID)

		require.NoError(t, service.Capture(ctx, phtelemetry.EventCommandExecuted, nil, nil))
		require.NotEmpty(t, analytics.captures)
		assert.Equal(t, state.DeviceID, analytics.captures[len(analytics.captures)-1].distinctID)
	})

	t.Run("skips logout by default", func(t *testing.T) {
		keyring.MockInit()
		require.NoError(t, credentials.StoreProvider.Set(utils.CurrentProfile.Name, token))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), os.Stdout, fsys)
		// Check error
		assert.ErrorIs(t, err, context.Canceled)
		saved, err := credentials.StoreProvider.Get(utils.CurrentProfile.Name)
		assert.NoError(t, err)
		assert.Equal(t, token, saved)
	})

	t.Run("exits 0 if not logged in", func(t *testing.T) {
		keyring.MockInit()
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), os.Stdout, fsys)
		// Check error
		assert.NoError(t, err)
	})

	t.Run("clears telemetry identity even when not logged in", func(t *testing.T) {
		keyring.MockInit()
		t.Cleanup(fstest.MockStdin(t, "y"))
		t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
		fsys := afero.NewMemMapFs()
		analytics := &fakeAnalytics{enabled: true}
		service, err := phtelemetry.NewService(fsys, phtelemetry.Options{
			Analytics: analytics,
			IsTTY:     true,
		})
		require.NoError(t, err)
		require.NoError(t, service.StitchLogin("user-123"))
		ctx := phtelemetry.WithService(context.Background(), service)

		require.NoError(t, Run(ctx, os.Stdout, fsys))

		state, err := phtelemetry.LoadState(fsys)
		require.NoError(t, err)
		assert.Empty(t, state.DistinctID)
	})

	t.Run("throws error on failure to delete", func(t *testing.T) {
		keyring.MockInitWithError(keyring.ErrNotFound)
		t.Cleanup(fstest.MockStdin(t, "y"))
		// Setup empty home directory
		t.Setenv("HOME", "")
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		err := Run(context.Background(), os.Stdout, fsys)
		// Check error
		assert.ErrorContains(t, err, "$HOME is not defined")
	})
}
