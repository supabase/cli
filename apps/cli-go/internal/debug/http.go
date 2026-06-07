package debug

import (
	"log"
	"net/http"
	"os"
)

type debugTransport struct {
	http.RoundTripper
	logger *log.Logger
}

func (t *debugTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.logger.Printf("%s: %s\n", req.Method, req.URL)
	return t.RoundTripper.RoundTrip(req)
}

func NewTransport() http.RoundTripper {
	return &debugTransport{
		http.DefaultTransport,
		log.New(os.Stderr, "HTTP ", log.LstdFlags|log.Lmsgprefix),
	}
}
