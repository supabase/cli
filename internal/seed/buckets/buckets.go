package buckets

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
)

func Run(ctx context.Context, projectRef string, interactive bool, fsys afero.Fs) error {
	api, err := client.NewStorageAPI(ctx, projectRef)
	if err != nil {
		return err
	}
	console := utils.NewConsole()
	if !interactive {
		console.IsTTY = false
	}
	filter := func(bucketId string) bool {
		label := fmt.Sprintf("Bucket %s already exists. Do you want to overwrite its properties?", utils.Bold(bucketId))
		shouldOverwrite, err := console.PromptYesNo(ctx, label, true)
		if err != nil {
			fmt.Fprintln(utils.GetDebugLogger(), err)
		}
		return shouldOverwrite
	}
	if err := api.UpsertBuckets(ctx, utils.Config.Storage.Buckets, filter); err != nil {
		return err
	}
	resolved := config.BucketConfig{}
	for name, bucket := range utils.Config.Storage.Buckets {
		if len(bucket.ObjectsPath) > 0 && !filepath.IsAbs(bucket.ObjectsPath) {
			bucket.ObjectsPath = filepath.Join(utils.SupabaseDirPath, bucket.ObjectsPath)
		}
		resolved[name] = bucket
	}
	return api.UpsertObjects(ctx, resolved, utils.NewRootFS(fsys))
}
