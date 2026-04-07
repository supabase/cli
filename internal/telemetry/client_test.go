package telemetry

import (
	"testing"

	"github.com/posthog/posthog-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeQueue struct {
	messages []posthog.Message
	closed   bool
}

func (f *fakeQueue) Enqueue(msg posthog.Message) error {
	f.messages = append(f.messages, msg)
	return nil
}

func (f *fakeQueue) Close() error {
	f.closed = true
	return nil
}

func TestNewClient(t *testing.T) {
	t.Run("uses endpoint and enables analytics when key is set", func(t *testing.T) {
		var gotKey string
		var gotConfig posthog.Config

		client, err := NewClient("phc_test", "https://eu.i.posthog.com", map[string]any{"platform": "cli"}, func(apiKey string, config posthog.Config) (queueClient, error) {
			gotKey = apiKey
			gotConfig = config
			return &fakeQueue{}, nil
		})

		require.NoError(t, err)
		assert.True(t, client.Enabled())
		assert.Equal(t, "phc_test", gotKey)
		assert.Equal(t, "https://eu.i.posthog.com", gotConfig.Endpoint)
	})

	t.Run("becomes a no-op when key is empty", func(t *testing.T) {
		client, err := NewClient("", "https://eu.i.posthog.com", map[string]any{"platform": "cli"}, func(apiKey string, config posthog.Config) (queueClient, error) {
			t.Fatalf("constructor should not be called without an api key")
			return nil, nil
		})

		require.NoError(t, err)
		assert.False(t, client.Enabled())
		assert.NoError(t, client.Capture("device-1", EventCommandExecuted, map[string]any{"command": "login"}, nil))
		assert.NoError(t, client.Close())
	})
}

func TestCaptureMergesBasePropertiesAndGroups(t *testing.T) {
	queue := &fakeQueue{}
	client, err := NewClient("phc_test", "https://eu.i.posthog.com", map[string]any{
		"platform": "cli",
		"os":       "darwin",
	}, func(apiKey string, config posthog.Config) (queueClient, error) {
		return queue, nil
	})
	require.NoError(t, err)

	err = client.Capture("device-1", EventCommandExecuted, map[string]any{
		"command": "login",
	}, map[string]string{
		GroupProject: "proj_123",
	})

	require.NoError(t, err)
	require.Len(t, queue.messages, 1)
	msg, ok := queue.messages[0].(posthog.Capture)
	require.True(t, ok)
	assert.Equal(t, "device-1", msg.DistinctId)
	assert.Equal(t, EventCommandExecuted, msg.Event)
	assert.Equal(t, "cli", msg.Properties["platform"])
	assert.Equal(t, "darwin", msg.Properties["os"])
	assert.Equal(t, "login", msg.Properties["command"])
	assert.Equal(t, posthog.Groups{GroupProject: "proj_123"}, msg.Groups)
}

func TestIdentifyAliasAndGroupIdentify(t *testing.T) {
	queue := &fakeQueue{}
	client, err := NewClient("phc_test", "", map[string]any{"platform": "cli"}, func(apiKey string, config posthog.Config) (queueClient, error) {
		return queue, nil
	})
	require.NoError(t, err)

	require.NoError(t, client.Identify("user-123", map[string]any{"schema_version": 1}))
	require.NoError(t, client.Alias("user-123", "device-123"))
	require.NoError(t, client.GroupIdentify(GroupOrganization, "org_123", map[string]any{"slug": "acme"}))
	require.NoError(t, client.Close())

	require.Len(t, queue.messages, 3)

	identify, ok := queue.messages[0].(posthog.Identify)
	require.True(t, ok)
	assert.Equal(t, "user-123", identify.DistinctId)
	assert.Equal(t, "cli", identify.Properties["platform"])
	assert.Equal(t, 1, identify.Properties["schema_version"])

	alias, ok := queue.messages[1].(posthog.Alias)
	require.True(t, ok)
	assert.Equal(t, "user-123", alias.DistinctId)
	assert.Equal(t, "device-123", alias.Alias)

	groupIdentify, ok := queue.messages[2].(posthog.GroupIdentify)
	require.True(t, ok)
	assert.Equal(t, GroupOrganization, groupIdentify.Type)
	assert.Equal(t, "org_123", groupIdentify.Key)
	assert.Equal(t, "cli", groupIdentify.Properties["platform"])
	assert.Equal(t, "acme", groupIdentify.Properties["slug"])
	assert.True(t, queue.closed)
}
