package tenant

import (
	"context"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
)

var errStorageVersion = errors.New("Storage version not found.")

func GetStorageVersion(ctx context.Context, projectRef string) (string, error) {
	apiKey, err := GetApiKeys(ctx, projectRef)
	if err != nil {
		return "", err
	}
	url := fmt.Sprintf("https://%s/storage/v1/version", utils.GetSupabaseHost(projectRef))
	data, err := GetTextResponse(ctx, url, apiKey.Anon)
	if err != nil {
		return "", err
	}
	if len(data) == 0 || data == "0.0.0" {
		return "", errors.New(errStorageVersion)
	}
	return "v" + data, nil
}
