package utils

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestIdentityTransport_CapturesGotrueIdHeader(t *testing.T) {
	var captured string
	cb := func(id string) { captured = id }
	transport := &identityTransport{
		RoundTripper: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: 200,
				Header:     http.Header{"X-Gotrue-Id": []string{"user-abc-123"}},
			}, nil
		}),
		onGotrueID: &cb,
	}
	req, _ := http.NewRequest("GET", "https://api.supabase.io/v1/projects", nil)
	resp, err := transport.RoundTrip(req)
	assert.NoError(t, err)
	assert.Equal(t, 200, resp.StatusCode)
	assert.Equal(t, "user-abc-123", captured)
}

func TestIdentityTransport_IgnoresWhenHeaderMissing(t *testing.T) {
	var captured string
	cb := func(id string) { captured = id }
	transport := &identityTransport{
		RoundTripper: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: 200,
				Header:     http.Header{},
			}, nil
		}),
		onGotrueID: &cb,
	}
	req, _ := http.NewRequest("GET", "https://api.supabase.io/v1/projects", nil)
	_, err := transport.RoundTrip(req)
	assert.NoError(t, err)
	assert.Empty(t, captured)
}

func TestIdentityTransport_NilCallbackDoesNotPanic(t *testing.T) {
	transport := &identityTransport{
		RoundTripper: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: 200,
				Header:     http.Header{"X-Gotrue-Id": []string{"user-abc-123"}},
			}, nil
		}),
		onGotrueID: nil,
	}
	req, _ := http.NewRequest("GET", "https://api.supabase.io/v1/projects", nil)
	resp, err := transport.RoundTrip(req)
	assert.NoError(t, err)
	assert.Equal(t, 200, resp.StatusCode)
}

func TestIdentityTransport_NilFuncBehindPointerDoesNotPanic(t *testing.T) {
	var cb func(string) // nil func
	transport := &identityTransport{
		RoundTripper: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: 200,
				Header:     http.Header{"X-Gotrue-Id": []string{"user-abc-123"}},
			}, nil
		}),
		onGotrueID: &cb,
	}
	req, _ := http.NewRequest("GET", "https://api.supabase.io/v1/projects", nil)
	resp, err := transport.RoundTrip(req)
	assert.NoError(t, err)
	assert.Equal(t, 200, resp.StatusCode)
}

func TestIdentityTransport_InnerTransportError(t *testing.T) {
	var captured string
	cb := func(id string) { captured = id }
	transport := &identityTransport{
		RoundTripper: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return nil, assert.AnError
		}),
		onGotrueID: &cb,
	}
	req, _ := http.NewRequest("GET", "https://api.supabase.io/v1/projects", nil)
	resp, err := transport.RoundTrip(req)
	assert.Error(t, err)
	assert.Nil(t, resp)
	assert.Empty(t, captured)
}

// roundTripFunc is a test helper to create inline RoundTrippers.
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}
