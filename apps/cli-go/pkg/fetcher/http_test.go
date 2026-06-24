package fetcher

import (
	"context"
	"net"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSendSuggestsApiPortConflictForMalformedLocalResponse(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer listener.Close()

	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = conn.Write([]byte(`{"type":"Tier1","version":"1.0"}`))
	}()

	api := NewFetcher("http://" + listener.Addr().String())
	_, err = api.Send(context.Background(), "GET", "/storage/v1/bucket", nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "malformed HTTP response")
	assert.Contains(t, err.Error(), "Another process may be listening on the configured API port")
	assert.Contains(t, err.Error(), "lsof -nP -iTCP:")
	assert.Contains(t, err.Error(), "api.port")

	<-done
}
