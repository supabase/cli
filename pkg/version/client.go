package version

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/supabase/cli/pkg/fetcher"
)

type ServiceGateway struct {
	*fetcher.Fetcher
}

func NewServiceGateway(server, token string, opts ...fetcher.FetcherOption) ServiceGateway {
	client := &http.Client{
		Timeout: 10 * time.Second,
	}
	header := func(req *http.Request) {
		req.Header.Add("apikey", token)
	}
	opts = append([]fetcher.FetcherOption{
		fetcher.WithHTTPClient(client),
		fetcher.WithRequestEditor(header),
		fetcher.WithExpectedStatus(http.StatusOK),
	}, opts...)
	return ServiceGateway{Fetcher: fetcher.NewFetcher(server, opts...)}
}

type ServiceVersion struct {
	Auth      string
	PostgREST string
	Storage   string
}

func (t *ServiceGateway) GetServiceVersions(ctx context.Context) (ServiceVersion, error) {
	var result ServiceVersion
	var wg sync.WaitGroup
	wg.Add(3)
	reason := make([]error, 3)
	go func() {
		defer wg.Done()
		result.Auth, reason[0] = t.GetGotrueVersion(ctx)
	}()
	go func() {
		defer wg.Done()
		result.PostgREST, reason[1] = t.GetPostgrestVersion(ctx)
	}()
	go func() {
		defer wg.Done()
		result.Storage, reason[2] = t.GetStorageVersion(ctx)
	}()
	wg.Wait()
	return result, errors.Join(reason...)
}
