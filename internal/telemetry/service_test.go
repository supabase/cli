package telemetry

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/pkg/api"
)

type captureCall struct {
	distinctID string
	event      string
	properties map[string]any
	groups     map[string]string
}

type identifyCall struct {
	distinctID string
	properties map[string]any
}

type aliasCall struct {
	distinctID string
	alias      string
}

type groupIdentifyCall struct {
	groupType  string
	groupKey   string
	properties map[string]any
}

type fakeAnalytics struct {
	enabled         bool
	captures        []captureCall
	identifies      []identifyCall
	aliases         []aliasCall
	groupIdentifies []groupIdentifyCall
	closed          bool
}

func (f *fakeAnalytics) Enabled() bool { return f.enabled }

func (f *fakeAnalytics) Capture(distinctID string, event string, properties map[string]any, groups map[string]string) error {
	f.captures = append(f.captures, captureCall{distinctID: distinctID, event: event, properties: properties, groups: groups})
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
	f.groupIdentifies = append(f.groupIdentifies, groupIdentifyCall{groupType: groupType, groupKey: groupKey, properties: properties})
	return nil
}

func (f *fakeAnalytics) Close() error {
	f.closed = true
	return nil
}

func TestServiceCaptureIncludesBasePropertiesAndCommandContext(t *testing.T) {
	now := time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC)
	t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
	fsys := afero.NewMemMapFs()
	analytics := &fakeAnalytics{enabled: true}

	service, err := NewService(fsys, Options{
		Analytics: analytics,
		Now:       func() time.Time { return now },
		IsTTY:     true,
		IsCI:      true,
		IsAgent:   true,
		EnvSignals: map[string]any{
			"CLAUDE_CODE":  true,
			"TERM_PROGRAM": "iTerm.app",
		},
		CLIName: "1.2.3",
		GOOS:    "darwin",
		GOARCH:  "arm64",
	})
	require.NoError(t, err)

	ctx := WithCommandContext(context.Background(), CommandContext{
		RunID:   "run-123",
		Command: "login",
		Flags: map[string]any{
			"token": "<redacted>",
		},
	})

	require.NoError(t, service.Capture(ctx, EventCommandExecuted, map[string]any{
		PropDurationMs: 42,
	}, nil))

	require.Len(t, analytics.captures, 1)
	call := analytics.captures[0]
	assert.NoError(t, uuid.Validate(call.distinctID))
	assert.Equal(t, EventCommandExecuted, call.event)
	assert.Equal(t, "cli", call.properties[PropPlatform])
	assert.Equal(t, SchemaVersion, call.properties[PropSchemaVersion])
	assert.Equal(t, true, call.properties[PropIsFirstRun])
	assert.Equal(t, true, call.properties[PropIsTTY])
	assert.Equal(t, true, call.properties[PropIsCI])
	assert.Equal(t, true, call.properties[PropIsAgent])
	assert.Equal(t, map[string]any{
		"CLAUDE_CODE":  true,
		"TERM_PROGRAM": "iTerm.app",
	}, call.properties[PropEnvSignals])
	assert.Equal(t, "darwin", call.properties[PropOS])
	assert.Equal(t, "arm64", call.properties[PropArch])
	assert.Equal(t, "1.2.3", call.properties[PropCLIVersion])
	assert.Equal(t, "run-123", call.properties[PropCommandRunID])
	assert.Equal(t, "login", call.properties[PropCommand])
	assert.Equal(t, map[string]any{"token": "<redacted>"}, call.properties[PropFlags])
	_, hasFlagsUsed := call.properties["flags_used"]
	assert.False(t, hasFlagsUsed)
	_, hasFlagValues := call.properties["flag_values"]
	assert.False(t, hasFlagValues)
	assert.Equal(t, 42, call.properties[PropDurationMs])
}

func TestServiceStitchLoginPersistsDistinctID(t *testing.T) {
	now := time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC)
	t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
	fsys := afero.NewMemMapFs()
	analytics := &fakeAnalytics{enabled: true}

	service, err := NewService(fsys, Options{
		Analytics: analytics,
		Now:       func() time.Time { return now },
	})
	require.NoError(t, err)
	deviceID := service.state.DeviceID

	require.NoError(t, service.StitchLogin("user-123"))
	require.NoError(t, service.Capture(context.Background(), EventLoginCompleted, nil, nil))

	require.Len(t, analytics.aliases, 1)
	assert.Equal(t, "user-123", analytics.aliases[0].distinctID)
	assert.Equal(t, deviceID, analytics.aliases[0].alias)
	require.Len(t, analytics.identifies, 1)
	assert.Equal(t, "user-123", analytics.identifies[0].distinctID)
	require.Len(t, analytics.captures, 1)
	assert.Equal(t, "user-123", analytics.captures[0].distinctID)

	state, err := LoadState(fsys)
	require.NoError(t, err)
	assert.Equal(t, "user-123", state.DistinctID)
}

func TestServiceClearDistinctIDFallsBackToDeviceID(t *testing.T) {
	now := time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC)
	t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
	fsys := afero.NewMemMapFs()
	analytics := &fakeAnalytics{enabled: true}

	service, err := NewService(fsys, Options{
		Analytics: analytics,
		Now:       func() time.Time { return now },
	})
	require.NoError(t, err)
	deviceID := service.state.DeviceID
	require.NoError(t, service.StitchLogin("user-123"))

	require.NoError(t, service.ClearDistinctID())
	require.NoError(t, service.Capture(context.Background(), EventLoginCompleted, nil, nil))

	require.Len(t, analytics.captures, 1)
	assert.Equal(t, deviceID, analytics.captures[0].distinctID)

	state, err := LoadState(fsys)
	require.NoError(t, err)
	assert.Empty(t, state.DistinctID)
}

func TestServiceCaptureIncludesLinkedProjectGroups(t *testing.T) {
	now := time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC)
	t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
	fsys := afero.NewMemMapFs()
	analytics := &fakeAnalytics{enabled: true}
	require.NoError(t, SaveLinkedProject(api.V1ProjectWithDatabaseResponse{
		Ref:              "proj_123",
		Name:             "My Project",
		OrganizationId:   "org_123",
		OrganizationSlug: "acme",
	}, fsys))

	service, err := NewService(fsys, Options{
		Analytics: analytics,
		Now:       func() time.Time { return now },
	})
	require.NoError(t, err)

	require.NoError(t, service.Capture(context.Background(), EventStackStarted, nil, nil))

	require.Len(t, analytics.captures, 1)
	assert.Equal(t, map[string]string{
		GroupOrganization: "org_123",
		GroupProject:      "proj_123",
	}, analytics.captures[0].groups)
}

func TestServiceNeedsIdentityStitch(t *testing.T) {
	now := time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC)
	t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
	fsys := afero.NewMemMapFs()
	analytics := &fakeAnalytics{enabled: true}

	service, err := NewService(fsys, Options{
		Analytics: analytics,
		Now:       func() time.Time { return now },
	})
	require.NoError(t, err)

	t.Run("true when DistinctID is empty", func(t *testing.T) {
		assert.True(t, service.NeedsIdentityStitch())
	})

	t.Run("false after StitchLogin", func(t *testing.T) {
		require.NoError(t, service.StitchLogin("user-123"))
		assert.False(t, service.NeedsIdentityStitch())
	})
}

func TestServiceCaptureHonorsConsentAndEnvOptOut(t *testing.T) {
	now := time.Date(2026, time.April, 1, 12, 0, 0, 0, time.UTC)

	t.Run("disabled telemetry file suppresses capture", func(t *testing.T) {
		t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
		fsys := afero.NewMemMapFs()
		analytics := &fakeAnalytics{enabled: true}
		require.NoError(t, SaveState(State{
			Enabled:           false,
			DeviceID:          uuid.NewString(),
			SessionID:         uuid.NewString(),
			SessionLastActive: now,
			SchemaVersion:     SchemaVersion,
		}, fsys))

		service, err := NewService(fsys, Options{
			Analytics: analytics,
			Now:       func() time.Time { return now },
		})
		require.NoError(t, err)

		require.NoError(t, service.Capture(context.Background(), EventCommandExecuted, nil, nil))
		assert.Empty(t, analytics.captures)
	})

	t.Run("DO_NOT_TRACK suppresses capture", func(t *testing.T) {
		t.Setenv("SUPABASE_HOME", "/tmp/supabase-home")
		t.Setenv("DO_NOT_TRACK", "1")
		fsys := afero.NewMemMapFs()
		analytics := &fakeAnalytics{enabled: true}

		service, err := NewService(fsys, Options{
			Analytics: analytics,
			Now:       func() time.Time { return now },
		})
		require.NoError(t, err)

		require.NoError(t, service.Capture(context.Background(), EventCommandExecuted, nil, nil))
		assert.Empty(t, analytics.captures)
	})
}
