package cmd

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/db/diff"
)

func TestHandoffPgDeltaNextShadowTransfersOwnershipAfterAck(t *testing.T) {
	shadow := testPgDeltaNextShadow()
	var output bytes.Buffer
	var removed []string

	err := handoffPgDeltaNextPlanShadow(context.Background(), shadow, strings.NewReader("ack\n"), &output, func(container string) {
		removed = append(removed, container)
	})

	require.NoError(t, err)
	assert.Equal(t, "{\"migrations\":{\"containerId\":\"migrations-container\",\"url\":\"postgresql://postgres@migrations-host:6543/postgres?connect_timeout=10\"},\"declarative\":{\"containerId\":\"declarative-container\",\"url\":\"postgresql://postgres@declarative-host:7654/postgres?connect_timeout=10\"}}\n", output.String())
	assert.Empty(t, removed)
}

func TestHandoffPgDeltaNextShadowRetainsOwnershipOnHandshakeFailure(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr string
	}{
		{name: "EOF", wantErr: "failed to read"},
		{name: "ack without newline", input: "ack", wantErr: "failed to read"},
		{name: "bad acknowledgment", input: "nope\n", wantErr: "unexpected"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var removed []string
			err := handoffPgDeltaNextPlanShadow(context.Background(), testPgDeltaNextShadow(), strings.NewReader(tt.input), io.Discard, func(container string) {
				removed = append(removed, container)
			})

			assert.ErrorContains(t, err, tt.wantErr)
			assert.Equal(t, []string{"migrations-container", "declarative-container"}, removed)
		})
	}
}

func TestHandoffPgDeltaNextShadowCleansBothOnEncodingFailure(t *testing.T) {
	var removed []string
	err := handoffPgDeltaNextPlanShadow(context.Background(), testPgDeltaNextShadow(), strings.NewReader("ack\n"), failingWriter{}, func(container string) {
		removed = append(removed, container)
	})

	assert.ErrorContains(t, err, "failed to encode")
	assert.Equal(t, []string{"migrations-container", "declarative-container"}, removed)
}

func TestHandoffPgDeltaNextShadowCleansBothOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	reader, writer := io.Pipe()
	cancel()
	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})
	var removed []string

	err := handoffPgDeltaNextPlanShadow(ctx, testPgDeltaNextShadow(), reader, io.Discard, func(container string) {
		removed = append(removed, container)
	})

	assert.ErrorIs(t, err, context.Canceled)
	assert.Equal(t, []string{"migrations-container", "declarative-container"}, removed)
}

func TestHandoffPgDeltaNextMigrationsShadowTransfersOneContainer(t *testing.T) {
	shadow := testPgDeltaNextShadow().Migrations
	var output bytes.Buffer
	var removed []string

	err := handoffPgDeltaNextMigrationsShadow(context.Background(), shadow, strings.NewReader("ack\n"), &output, func(container string) {
		removed = append(removed, container)
	})

	require.NoError(t, err)
	assert.Equal(t, "{\"migrations\":{\"containerId\":\"migrations-container\",\"url\":\"postgresql://postgres@migrations-host:6543/postgres?connect_timeout=10\"}}\n", output.String())
	assert.Empty(t, removed)
}

func TestHandoffPgDeltaNextMigrationsShadowCleansOneContainerOnFailure(t *testing.T) {
	shadow := testPgDeltaNextShadow().Migrations
	var removed []string

	err := handoffPgDeltaNextMigrationsShadow(context.Background(), shadow, strings.NewReader("nope\n"), io.Discard, func(container string) {
		removed = append(removed, container)
	})

	assert.ErrorContains(t, err, "unexpected")
	assert.Equal(t, []string{"migrations-container"}, removed)
}

func testPgDeltaNextShadow() diff.PgDeltaNextPlanShadow {
	return diff.PgDeltaNextPlanShadow{
		Migrations: diff.PgDeltaNextShadowDatabase{
			Container: "migrations-container",
			Config: pgconn.Config{
				Host:     "migrations-host",
				Port:     6543,
				User:     "postgres",
				Password: "must-not-be-emitted",
				Database: "postgres",
			},
		},
		Declarative: diff.PgDeltaNextShadowDatabase{
			Container: "declarative-container",
			Config: pgconn.Config{
				Host:     "declarative-host",
				Port:     7654,
				User:     "postgres",
				Password: "must-not-be-emitted",
				Database: "postgres",
			},
		},
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) {
	return 0, errors.New("write failed")
}
