package buckets

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/storage/cp"
	"github.com/supabase/cli/internal/utils"
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
	for _, bucket := range utils.Config.Storage.Buckets {
		localPath := filepath.Join(utils.SupabaseDirPath, bucket.ObjectsPath)
		if err := cp.UploadStorageObjectAll(ctx, api, "", localPath, 5, fsys); err != nil {
			return err
		}
	}
	return nil
}
