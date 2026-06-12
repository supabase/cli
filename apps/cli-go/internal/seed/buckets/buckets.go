package buckets

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, projectRef string, interactive bool, fsys afero.Fs) error {
	hasVectorBuckets := len(utils.Config.Storage.VectorBuckets.Buckets) > 0
	if len(projectRef) == 0 &&
		len(utils.Config.Storage.Buckets) == 0 &&
		!hasVectorBuckets {
		return nil
	}
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
	prune := func(name string) bool {
		label := fmt.Sprintf("Bucket %s not found in %s. Do you want to prune it?", utils.Bold(name), utils.Bold(utils.ConfigPath))
		shouldPrune, err := console.PromptYesNo(ctx, label, false)
		if err != nil {
			fmt.Fprintln(utils.GetDebugLogger(), err)
		}
		return shouldPrune
	}
	if utils.Config.Storage.AnalyticsBuckets.Enabled && len(projectRef) > 0 {
		fmt.Fprintln(os.Stderr, "Updating analytics buckets...")
		if err := api.UpsertAnalyticsBuckets(ctx, utils.Config.Storage.AnalyticsBuckets.Buckets, prune); err != nil {
			return err
		}
	}
	if utils.Config.Storage.VectorBuckets.Enabled && hasVectorBuckets {
		fmt.Fprintln(os.Stderr, "Updating vector buckets...")
		if err := api.UpsertVectorBuckets(ctx, utils.Config.Storage.VectorBuckets.Buckets, prune); err != nil {
			if isVectorBucketsFeatureNotEnabled(err) {
				fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), "Vector buckets are not available in this project's region yet. Skipping vector bucket seeding.")
				return api.UpsertObjects(ctx, utils.Config.Storage.Buckets, utils.NewRootFS(fsys))
			}
			if isLocalVectorBucketsUnavailable(err) {
				fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), "Vector buckets are not available in the local storage service. If this project is linked, run `supabase link` to update service versions, then restart the local stack. Skipping vector bucket seeding.")
				return api.UpsertObjects(ctx, utils.Config.Storage.Buckets, utils.NewRootFS(fsys))
			}
			return err
		}
	}
	return api.UpsertObjects(ctx, utils.Config.Storage.Buckets, utils.NewRootFS(fsys))
}

func isVectorBucketsFeatureNotEnabled(err error) bool {
	return err != nil && strings.Contains(err.Error(), "FeatureNotEnabled")
}

func isLocalVectorBucketsUnavailable(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "Vector service not configured") ||
		(strings.Contains(message, "Error status 404:") &&
			strings.Contains(message, "Route POST:") &&
			strings.Contains(message, "ListVectorBuckets"))
}
