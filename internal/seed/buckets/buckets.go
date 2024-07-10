package buckets

import (
	"context"
	"fmt"

	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
)

func Run(ctx context.Context, console *utils.Console) error {
	api, err := client.NewStorageAPI(ctx, flags.ProjectRef)
	if err != nil {
		return err
	}
	config := utils.Config.Storage.GetBucketConfig()
	api.UpsertBuckets(ctx, config, func(bucketId string) bool {
		label := fmt.Sprintf("Bucket %s already exists. Do you want to overwrite its properties?", utils.Bold(bucketId))
		shouldOverwrite, err := console.PromptYesNo(ctx, label, true)
		if err != nil {
			fmt.Fprintln(utils.GetDebugLogger(), err)
		}
		return shouldOverwrite
	})
	return nil
}
