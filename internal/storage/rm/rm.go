package rm

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/storage/cp"
	"github.com/supabase/cli/internal/storage/ls"
	"github.com/supabase/cli/internal/utils"
)

type PrefixGroup struct {
	Bucket   string
	Prefixes []string
}

func Run(ctx context.Context, paths []string, recursive bool, fsys afero.Fs) error {
	// Group paths by buckets
	groups := map[string][]string{}
	for _, objectPath := range paths {
		remotePath, err := ls.ParseStorageURL(objectPath)
		if err != nil {
			return err
		}
		bucket, prefix := ls.SplitBucketPrefix(remotePath)
		// Ignore attempts to delete all buckets
		if len(bucket) == 0 {
			return errors.New("You must specify a bucket to delete.")
		}
		if cp.IsDir(prefix) && !recursive {
			return errors.New("You must specify -r flag to delete directories.")
		}
		groups[bucket] = append(groups[bucket], prefix)
	}
	projectRef, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	for bucket, prefixes := range groups {
		if utils.SliceContains(prefixes, "") {
			fmt.Fprintln(os.Stderr, "Deleting bucket:", bucket)
			if err := RemoveStoragePathAll(ctx, projectRef, bucket, ""); err != nil {
				return err
			}
			if data, err := client.DeleteStorageBucket(ctx, projectRef, bucket); err == nil {
				fmt.Fprintln(os.Stderr, data.Message)
			} else if !strings.Contains(err.Error(), `"error":"Bucket not found"`) {
				return err
			} else {
				fmt.Fprintln(os.Stderr, "Bucket not found")
			}
			continue
		}
		fmt.Fprintln(os.Stderr, "Deleting objects:", prefixes)
		removed, err := client.DeleteStorageObjects(ctx, projectRef, bucket, prefixes)
		if err != nil {
			return err
		}
		if !recursive {
			if len(removed) == 0 {
				utils.CmdSuggestion = "You must specify -r flag to delete directories."
				return errors.New("Object not found")
			}
			continue
		}
		set := map[string]struct{}{}
		for _, object := range removed {
			set[object.Name] = struct{}{}
		}
		for _, prefix := range prefixes {
			if _, ok := set[prefix]; !ok {
				if err := RemoveStoragePathAll(ctx, projectRef, bucket, prefix+"/"); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// Expects prefix to be terminated by "/"
func RemoveStoragePathAll(ctx context.Context, projectRef, bucket, prefix string) error {
	queue := make([]string, 0)
	queue = append(queue, prefix)
	for len(queue) > 0 {
		dirPrefix := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		paths, err := ls.ListStoragePaths(ctx, projectRef, fmt.Sprintf("/%s/%s", bucket, dirPrefix))
		if err != nil {
			return err
		}
		if len(paths) == 0 {
			return errors.New("Object not found")
		}
		var files []string
		for _, objectName := range paths {
			objectPrefix := dirPrefix + objectName
			if strings.HasSuffix(objectName, "/") {
				queue = append(queue, objectPrefix)
			} else {
				files = append(files, objectPrefix)
			}
		}
		if len(files) > 0 {
			fmt.Fprintln(os.Stderr, "Deleting objects:", files)
			if _, err := client.DeleteStorageObjects(ctx, projectRef, bucket, files); err != nil {
				return err
			}
		}
	}
	return nil
}
