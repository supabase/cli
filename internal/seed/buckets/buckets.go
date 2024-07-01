package buckets

import (
	"context"
	"fmt"
	"os"

	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/storage"
)

func Run(ctx context.Context) error {
	api, err := client.NewStorageAPI(ctx, flags.ProjectRef)
	if err != nil {
		return err
	}
	buckets, err := api.ListBuckets(ctx)
	if err != nil {
		return err
	}
	var exists []string
	console := utils.NewConsole()
	for _, b := range buckets {
		props := NewBucketProps(b.Name)
		if props == nil {
			continue
		}
		exists = append(exists, b.Name)
		label := fmt.Sprintf("Bucket %s already exists. Do you want to overwrite its properties?", utils.Bold(b.Id))
		if shouldOverwrite, err := console.PromptYesNo(ctx, label, true); err != nil {
			return err
		} else if !shouldOverwrite {
			continue
		}
		body := storage.UpdateBucketRequest{
			Id:          b.Id,
			BucketProps: props,
		}
		if _, err := api.UpdateBucket(ctx, body); err != nil {
			return err
		}
	}
	for name := range utils.Config.Storage.Buckets {
		if utils.SliceContains(exists, name) {
			continue
		}
		msg := "Creating storage bucket:"
		if len(flags.ProjectRef) == 0 {
			msg = "Creating local storage bucket:"
		}
		fmt.Fprintln(os.Stderr, msg, name)
		body := storage.CreateBucketRequest{
			Name:        name,
			BucketProps: NewBucketProps(name),
		}
		if _, err := api.CreateBucket(ctx, body); err != nil {
			return err
		}
	}
	return nil
}

func NewBucketProps(name string) *storage.BucketProps {
	config, ok := utils.Config.Storage.Buckets[name]
	if !ok {
		return nil
	}
	props := storage.BucketProps{
		Public:           config.Public,
		AllowedMimeTypes: config.AllowedMimeTypes,
	}
	if config.FileSizeLimit > 0 {
		props.FileSizeLimit = int(config.FileSizeLimit)
	} else {
		props.FileSizeLimit = int(utils.Config.Storage.FileSizeLimit)
	}
	return &props
}
