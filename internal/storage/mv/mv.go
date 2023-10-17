package mv

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/storage/ls"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, src, dst string, recursive bool, fsys afero.Fs) error {
	srcParsed, err := ls.ParseStorageURL(src)
	if err != nil {
		return err
	}
	dstParsed, err := ls.ParseStorageURL(dst)
	if err != nil {
		return err
	}
	projectRef, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	srcBucket, srcPrefix := ls.SplitBucketPrefix(srcParsed)
	dstBucket, dstPrefix := ls.SplitBucketPrefix(dstParsed)
	if srcBucket != dstBucket {
		return errors.New("Moving between buckets is unsupported")
	}
	fmt.Fprintln(os.Stderr, "Moving object:", srcParsed, "=>", dstParsed)
	data, err := client.MoveStorageObject(ctx, projectRef, srcBucket, srcPrefix, dstPrefix)
	if err == nil {
		fmt.Fprintln(os.Stderr, data.Message)
	} else if strings.Contains(err.Error(), `"error":"not_found"`) && recursive {
		return MoveStorageObjectAll(ctx, projectRef, srcParsed+"/", dstParsed)
	}
	return err
}

// Expects srcPath to be terminated by "/"
func MoveStorageObjectAll(ctx context.Context, projectRef, srcPath, dstPath string) error {
	_, dstPrefix := ls.SplitBucketPrefix(dstPath)
	queue := make([]string, 0)
	queue = append(queue, srcPath)
	for len(queue) > 0 {
		dirPath := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		paths, err := ls.ListStoragePaths(ctx, projectRef, dirPath)
		if err != nil {
			return err
		}
		for _, objectName := range paths {
			objectPath := dirPath + objectName
			if strings.HasSuffix(objectName, "/") {
				queue = append(queue, objectPath)
				continue
			}
			relPath := strings.TrimPrefix(objectPath, srcPath)
			srcBucket, srcPrefix := ls.SplitBucketPrefix(objectPath)
			absPath := path.Join(dstPrefix, relPath)
			fmt.Fprintln(os.Stderr, "Moving object:", objectPath, "=>", path.Join(dstPath, relPath))
			if _, err := client.MoveStorageObject(ctx, projectRef, srcBucket, srcPrefix, absPath); err != nil {
				return err
			}
		}
	}
	return nil
}
