package tenant

import (
	"context"
	"io"
	"net/http"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/pkg/fetcher"
)

var errStorageVersion = errors.New("Storage version not found.")

func GetStorageVersion(ctx context.Context, api *fetcher.Fetcher) (string, error) {
	resp, err := api.Send(ctx, http.MethodGet, "/storage/v1/version", nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", errors.Errorf("failed to read response body: %w", err)
	}
	if len(data) == 0 || string(data) == "0.0.0" {
		return "", errors.New(errStorageVersion)
	}
	return "v" + string(data), nil
}
