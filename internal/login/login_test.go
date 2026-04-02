package login

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"testing"
	"time"

	"github.com/h2non/gock"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	phtelemetry "github.com/supabase/cli/internal/telemetry"
	"github.com/supabase/cli/internal/testing/apitest"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/zalando/go-keyring"
)

type MockEncryption struct {
	token     string
	publicKey string
}

func (enc *MockEncryption) encodedPublicKey() string {
	return enc.publicKey
}

func (enc *MockEncryption) decryptAccessToken(accessToken string, publicKey string, nonce string) (string, error) {
	return enc.token, nil
}

type fakeAnalytics struct {
	enabled    bool
	captures   []captureCall
	identifies []identifyCall
	aliases    []aliasCall
}

type captureCall struct {
	distinctID string
	event      string
	properties map[string]any
}

type identifyCall struct {
	distinctID string
	properties map[string]any
}

type aliasCall struct {
	distinctID string
	alias      string
}

func (f *fakeAnalytics) Enabled() bool { return f.enabled }

func (f *fakeAnalytics) Capture(distinctID string, event string, properties map[string]any, groups map[string]string) error {
	f.captures = append(f.captures, captureCall{distinctID: distinctID, event: event, properties: properties})
	return nil
}

func (f *fakeAnalytics) Identify(distinctID string, properties map[string]any) error {
	f.identifies = append(f.identifies, identifyCall{distinctID: distinctID, properties: properties})
	return nil
}

func (f *fakeAnalytics) Alias(distinctID string, alias string) error {
	f.aliases = append(f.aliases, aliasCall{distinctID: distinctID, alias: alias})
	return nil
}

func (f *fakeAnalytics) GroupIdentify(groupType string, groupKey string, properties map[string]any) error {
	return nil
}

func (f *fakeAnalytics) Close() error { return nil }

func TestLoginCommand(t *testing.T) {
	keyring.MockInit()

	t.Run("accepts --token flag and validates provided value", func(t *testing.T) {
		token := string(apitest.RandomAccessToken(t))
		assert.NoError(t, Run(context.Background(), os.Stdout, RunParams{
			Token: token,
			Fsys:  afero.NewMemMapFs(),
		}))
		saved, err := credentials.StoreProvider.Get(utils.CurrentProfile.Name)
		assert.NoError(t, err)
		assert.Equal(t, token, saved)
	})

	t.Run("goes through automated flow successfully", func(t *testing.T) {
		r, w, err := os.Pipe()
		require.NoError(t, err)

		sessionId := "random_session_id"
		token := string(apitest.RandomAccessToken(t))
		tokenName := "random_token_name"
		publicKey := "random_public_key"

		defer gock.OffAll()

		gock.New(utils.GetSupabaseAPIHost()).
			Get("/platform/cli/login/" + sessionId).
			Reply(200).
			JSON(map[string]any{
				"id":           "0b0d48f6-878b-4190-88d7-2ca33ed800bc",
				"created_at":   "2023-03-28T13:50:14.464Z",
				"access_token": "picklerick",
				"public_key":   "iddqd",
				"nonce":        "idkfa",
			})

		enc := &MockEncryption{publicKey: publicKey, token: token}
		runParams := RunParams{
			TokenName:  tokenName,
			SessionId:  sessionId,
			Fsys:       afero.NewMemMapFs(),
			Encryption: enc,
		}
		assert.NoError(t, Run(context.Background(), w, runParams))
		w.Close()

		var out bytes.Buffer
		_, _ = io.Copy(&out, r)

		expectedBrowserUrl := fmt.Sprintf("%s/cli/login?session_id=%s&token_name=%s&public_key=%s", utils.GetSupabaseDashboardURL(), sessionId, tokenName, publicKey)
		assert.Contains(t, out.String(), expectedBrowserUrl)

		saved, err := credentials.StoreProvider.Get(utils.CurrentProfile.Name)
		assert.NoError(t, err)
		assert.Equal(t, token, saved)
		assert.Empty(t, apitest.ListUnmatchedRequests())
	})
}

func TestLoginTelemetryStitching(t *testing.T) {
	keyring.MockInit()
	now := time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC)
	token := string(apitest.RandomAccessToken(t))

	newService := func(t *testing.T, fsys afero.Fs, analytics *fakeAnalytics) *phtelemetry.Service {
		t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
		service, err := phtelemetry.NewService(fsys, phtelemetry.Options{
			Analytics: analytics,
			Now:       func() time.Time { return now },
		})
		require.NoError(t, err)
		return service
	}

	t.Run("token login fetches profile and stitches with gotrue_id", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		analytics := &fakeAnalytics{enabled: true}
		ctx := phtelemetry.WithService(context.Background(), newService(t, fsys, analytics))

		err := Run(ctx, os.Stdout, RunParams{
			Token: token,
			Fsys:  fsys,
			GetProfile: func(context.Context) (string, error) {
				return "user-123", nil
			},
		})

		require.NoError(t, err)
		require.Len(t, analytics.aliases, 1)
		assert.Equal(t, "user-123", analytics.aliases[0].distinctID)
		require.Len(t, analytics.identifies, 1)
		assert.Equal(t, "user-123", analytics.identifies[0].distinctID)
		require.Len(t, analytics.captures, 1)
		assert.Equal(t, "cli_login_completed", analytics.captures[0].event)
		assert.Equal(t, "user-123", analytics.captures[0].distinctID)
		state, err := phtelemetry.LoadState(fsys)
		require.NoError(t, err)
		assert.Equal(t, "user-123", state.DistinctID)
	})

	t.Run("browser login also stitches with gotrue_id", func(t *testing.T) {
		r, w, err := os.Pipe()
		require.NoError(t, err)
		defer r.Close()
		fsys := afero.NewMemMapFs()
		analytics := &fakeAnalytics{enabled: true}
		ctx := phtelemetry.WithService(context.Background(), newService(t, fsys, analytics))

		defer gock.OffAll()
		gock.New(utils.GetSupabaseAPIHost()).
			Get("/platform/cli/login/browser-session").
			Reply(200).
			JSON(map[string]any{
				"id":           "0b0d48f6-878b-4190-88d7-2ca33ed800bc",
				"created_at":   "2023-03-28T13:50:14.464Z",
				"access_token": "picklerick",
				"public_key":   "iddqd",
				"nonce":        "idkfa",
			})

		err = Run(ctx, w, RunParams{
			TokenName:  "token_name",
			SessionId:  "browser-session",
			Fsys:       fsys,
			Encryption: &MockEncryption{publicKey: "public_key", token: token},
			GetProfile: func(context.Context) (string, error) {
				return "user-456", nil
			},
		})

		require.NoError(t, err)
		require.Len(t, analytics.captures, 1)
		assert.Equal(t, "user-456", analytics.captures[0].distinctID)
	})

	t.Run("stale distinct_id is replaced on successful profile lookup", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		analytics := &fakeAnalytics{enabled: true}
		service := newService(t, fsys, analytics)
		state, _, err := phtelemetry.LoadOrCreateState(fsys, now)
		require.NoError(t, err)
		state.DistinctID = "old-user"
		require.NoError(t, phtelemetry.SaveState(state, fsys))
		ctx := phtelemetry.WithService(context.Background(), service)

		err = Run(ctx, os.Stdout, RunParams{
			Token: token,
			Fsys:  fsys,
			GetProfile: func(context.Context) (string, error) {
				return "new-user", nil
			},
		})

		require.NoError(t, err)
		state, err = phtelemetry.LoadState(fsys)
		require.NoError(t, err)
		assert.Equal(t, "new-user", state.DistinctID)
	})

	t.Run("profile lookup failure does not fail login and clears stale distinct_id", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		analytics := &fakeAnalytics{enabled: true}
		service := newService(t, fsys, analytics)
		state, _, err := phtelemetry.LoadOrCreateState(fsys, now)
		require.NoError(t, err)
		state.DistinctID = "old-user"
		deviceID := state.DeviceID
		require.NoError(t, phtelemetry.SaveState(state, fsys))
		ctx := phtelemetry.WithService(context.Background(), service)

		err = Run(ctx, os.Stdout, RunParams{
			Token: token,
			Fsys:  fsys,
			GetProfile: func(context.Context) (string, error) {
				return "", errors.New("profile unavailable")
			},
		})

		require.NoError(t, err)
		assert.Empty(t, analytics.aliases)
		assert.Empty(t, analytics.identifies)
		require.Len(t, analytics.captures, 1)
		assert.Equal(t, deviceID, analytics.captures[0].distinctID)
		state, err = phtelemetry.LoadState(fsys)
		require.NoError(t, err)
		assert.Empty(t, state.DistinctID)
	})
}
