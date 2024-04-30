package mv

import (
	"context"
	"fmt"
	"os"
	"path"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/storage/ls"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/storage"
)

var (
	errUnsupportedMove = errors.New("Moving between buckets is unsupported")
	errMissingPath     = errors.New("You must specify an object path")
)

func Run(ctx context.Context, src, dst string, recursive bool, fsys afero.Fs) error {
	srcParsed, err := client.ParseStorageURL(src)
	if err != nil {
		return err
	}
	dstParsed, err := client.ParseStorageURL(dst)
	if err != nil {
		return err
	}
	srcBucket, srcPrefix := client.SplitBucketPrefix(srcParsed)
	dstBucket, dstPrefix := client.SplitBucketPrefix(dstParsed)
	if len(srcPrefix) == 0 && len(dstPrefix) == 0 {
		return errors.New(errMissingPath)
	}
	if srcBucket != dstBucket {
		return errors.New(errUnsupportedMove)
	}
	api, err := client.NewStorageAPI(ctx, flags.ProjectRef)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Moving object:", srcParsed, "=>", dstParsed)
	data, err := api.MoveObject(ctx, srcBucket, srcPrefix, dstPrefix)
	if err == nil {
		fmt.Fprintln(os.Stderr, data.Message)
	} else if strings.Contains(err.Error(), `"error":"not_found"`) && recursive {
		return MoveStorageObjectAll(ctx, api, srcParsed+"/", dstParsed)
	}
	return err
}

// Expects srcPath to be terminated by "/"
func MoveStorageObjectAll(ctx context.Context, api storage.StorageAPI, srcPath, dstPath string) error {
	_, dstPrefix := client.SplitBucketPrefix(dstPath)
	// Cannot iterate because pagination result may be updated during move
	count := 0
	queue := make([]string, 0)
	queue = append(queue, srcPath)
	for len(queue) > 0 {
		dirPath := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		paths, err := ls.ListStoragePaths(ctx, api, dirPath)
		if err != nil {
			return err
		}
		for _, objectName := range paths {
			objectPath := dirPath + objectName
			if strings.HasSuffix(objectName, "/") {
				queue = append(queue, objectPath)
				continue
			}
			count++
			relPath := strings.TrimPrefix(objectPath, srcPath)
			srcBucket, srcPrefix := client.SplitBucketPrefix(objectPath)
			absPath := path.Join(dstPrefix, relPath)
			fmt.Fprintln(os.Stderr, "Moving object:", objectPath, "=>", path.Join(dstPath, relPath))
			if _, err := api.MoveObject(ctx, srcBucket, srcPrefix, absPath); err != nil {
				return err
			}
		}
	}
	if count == 0 {
		return errors.New("Object not found: " + srcPath)
	}
	return nil
}
