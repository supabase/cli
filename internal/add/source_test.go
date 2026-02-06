package add

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/go-errors/errors"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type roundTripFunc func(req *http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func newResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}

func TestFetchURLWithContextOptionalNotFound(t *testing.T) {
	client := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return newResponse(http.StatusBadRequest, `{"statusCode":"404","error":"not_found","message":"Object not found"}`), nil
		}),
	}

	_, err := fetchURLWithContext(context.Background(), client, "https://example.test/missing", false)
	require.Error(t, err)
	assert.True(t, errors.Is(err, os.ErrNotExist))

	_, err = fetchURLWithContext(context.Background(), client, "https://example.test/missing", true)
	require.Error(t, err)
	assert.ErrorContains(t, err, "status 400")
}
