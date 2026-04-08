package utils

import "net/http"

const HeaderGotrueId = "X-Gotrue-Id"

type identityTransport struct {
	http.RoundTripper
	onGotrueID func(string)
}

func (t *identityTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.RoundTripper.RoundTrip(req)
	if err != nil {
		return resp, err
	}
	if id := resp.Header.Get(HeaderGotrueId); id != "" && t.onGotrueID != nil {
		t.onGotrueID(id)
	}
	return resp, err
}
