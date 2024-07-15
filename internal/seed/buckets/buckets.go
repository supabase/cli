package buckets

import (
	"context"
	"fmt"

	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, console *utils.Console) error {
	api, err := client.NewStorageAPI(ctx, projectRef)
	if err != nil {
		return err
	}
	if console == nil {
		return api.UpsertBuckets(ctx, utils.Config.Storage.Buckets)
	}
	filter := func(bucketId string) bool {
		label := fmt.Sprintf("Bucket %s already exists. Do you want to overwrite its properties?", utils.Bold(bucketId))
		shouldOverwrite, err := console.PromptYesNo(ctx, label, true)
		if err != nil {
			fmt.Fprintln(utils.GetDebugLogger(), err)
		}
		return shouldOverwrite
	}
	return api.UpsertBuckets(ctx, utils.Config.Storage.Buckets, filter)
}
