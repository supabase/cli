package telemetry

import (
	"strings"

	"github.com/go-errors/errors"
	"github.com/posthog/posthog-go"
)

type Analytics interface {
	Enabled() bool
	Capture(distinctID string, event string, properties map[string]any, groups map[string]string) error
	Identify(distinctID string, properties map[string]any) error
	Alias(distinctID string, alias string) error
	GroupIdentify(groupType string, groupKey string, properties map[string]any) error
	Close() error
}

type queueClient interface {
	Enqueue(posthog.Message) error
	Close() error
}

type constructor func(apiKey string, config posthog.Config) (queueClient, error)

type Client struct {
	client         queueClient
	baseProperties posthog.Properties
}

func NewClient(apiKey string, endpoint string, baseProperties map[string]any, factory constructor) (*Client, error) {
	if strings.TrimSpace(apiKey) == "" {
		return &Client{baseProperties: makeProperties(baseProperties)}, nil
	}
	if factory == nil {
		factory = func(apiKey string, config posthog.Config) (queueClient, error) {
			return posthog.NewWithConfig(apiKey, config)
		}
	}
	config := posthog.Config{}
	if endpoint != "" {
		config.Endpoint = endpoint
	}
	client, err := factory(apiKey, config)
	if err != nil {
		return nil, errors.Errorf("failed to initialize posthog client: %w", err)
	}
	return &Client{
		client:         client,
		baseProperties: makeProperties(baseProperties),
	}, nil
}

func (c *Client) Enabled() bool {
	return c != nil && c.client != nil
}

func (c *Client) Capture(distinctID string, event string, properties map[string]any, groups map[string]string) error {
	if !c.Enabled() {
		return nil
	}
	msg := posthog.Capture{
		DistinctId: distinctID,
		Event:      event,
		Properties: c.properties(properties),
	}
	if len(groups) > 0 {
		msg.Groups = makeGroups(groups)
	}
	return c.client.Enqueue(msg)
}

func (c *Client) Identify(distinctID string, properties map[string]any) error {
	if !c.Enabled() {
		return nil
	}
	return c.client.Enqueue(posthog.Identify{
		DistinctId: distinctID,
		Properties: c.properties(properties),
	})
}

func (c *Client) Alias(distinctID string, alias string) error {
	if !c.Enabled() {
		return nil
	}
	return c.client.Enqueue(posthog.Alias{
		DistinctId: distinctID,
		Alias:      alias,
	})
}

func (c *Client) GroupIdentify(groupType string, groupKey string, properties map[string]any) error {
	if !c.Enabled() {
		return nil
	}
	return c.client.Enqueue(posthog.GroupIdentify{
		Type:       groupType,
		Key:        groupKey,
		Properties: c.properties(properties),
	})
}

func (c *Client) Close() error {
	if !c.Enabled() {
		return nil
	}
	return c.client.Close()
}

func (c *Client) properties(properties map[string]any) posthog.Properties {
	merged := posthog.NewProperties()
	merged.Merge(c.baseProperties)
	merged.Merge(makeProperties(properties))
	return merged
}

func makeProperties(values map[string]any) posthog.Properties {
	props := posthog.NewProperties()
	for key, value := range values {
		props.Set(key, value)
	}
	return props
}

func makeGroups(values map[string]string) posthog.Groups {
	groups := posthog.NewGroups()
	for key, value := range values {
		groups.Set(key, value)
	}
	return groups
}
