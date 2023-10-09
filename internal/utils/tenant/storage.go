package tenant

import (
	"context"
	"errors"
	"fmt"

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
		return "", errStorageVersion
	}
	return "v" + data, nil
}
