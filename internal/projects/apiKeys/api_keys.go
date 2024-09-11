package apiKeys

import (
	"context"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs) (*[]api.ApiKeyResponse, error) {
	keys, err := RunGetApiKeys(ctx, projectRef)
	if err != nil {
		return nil, err
	}

	return keys, nil
}

func RunGetApiKeys(ctx context.Context, projectRef string) (*[]api.ApiKeyResponse, error) {
	resp, err := utils.GetSupabase().V1GetProjectApiKeysWithResponse(ctx, projectRef)
	if err != nil {
		return nil, errors.Errorf("failed to get api keys: %w", err)
	}
	if resp.JSON200 == nil {
		return nil, errors.New("Unexpected error retrieving project api-keys: " + string(resp.Body))
	}
	return resp.JSON200, nil
}
