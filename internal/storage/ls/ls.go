package ls

import (
	"context"
	"fmt"
	"os"
	"path"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/storage"
	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, objectPath string, recursive bool, fsys afero.Fs) error {
	remotePath, err := storage.ParseStorageURL(objectPath)
	if err != nil {
		return err
	}
	projectRef, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	callback := func(objectPath string) error {
		fmt.Println(objectPath)
		return nil
	}
	if recursive {
		return IterateStoragePathsAll(ctx, projectRef, remotePath, callback)
	}
	return IterateStoragePaths(ctx, projectRef, remotePath, callback)
}

func ListStoragePaths(ctx context.Context, projectRef, remotePath string) ([]string, error) {
	var result []string
	err := IterateStoragePaths(ctx, projectRef, remotePath, func(objectName string) error {
		result = append(result, objectName)
		return nil
	})
	return result, err
}

func IterateStoragePaths(ctx context.Context, projectRef, remotePath string, callback func(objectName string) error) error {
	bucket, prefix := storage.SplitBucketPrefix(remotePath)
	if len(bucket) == 0 || (len(prefix) == 0 && !strings.HasSuffix(remotePath, "/")) {
		buckets, err := client.ListStorageBuckets(ctx, projectRef)
		if err != nil {
			return err
		}
		for _, b := range buckets {
			if strings.HasPrefix(b.Name, bucket) {
				if err := callback(b.Name + "/"); err != nil {
					return err
				}
			}
		}
	} else {
		pages := 1
		for i := 0; i < pages; i++ {
			objects, err := client.ListStorageObjects(ctx, projectRef, bucket, prefix, i)
			if err != nil {
				return err
			}
			for _, o := range objects {
				name := o.Name
				if o.Id == nil {
					name += "/"
				}
				if err := callback(name); err != nil {
					return err
				}
			}
			if len(objects) == client.PAGE_LIMIT {
				// TODO: show interactive prompt?
				fmt.Fprintln(os.Stderr, "Loading page:", pages)
				pages++
			}
		}
	}
	return nil
}

// Expects remotePath to be terminated by "/"
func ListStoragePathsAll(ctx context.Context, projectRef, remotePath string) ([]string, error) {
	var result []string
	err := IterateStoragePathsAll(ctx, projectRef, remotePath, func(objectPath string) error {
		result = append(result, objectPath)
		return nil
	})
	return result, err
}

func IterateStoragePathsAll(ctx context.Context, projectRef, remotePath string, callback func(objectPath string) error) error {
	basePath := remotePath
	if !strings.HasSuffix(remotePath, "/") {
		basePath, _ = path.Split(remotePath)
	}
	// BFS so we can list paths in increasing depth
	dirQueue := make([]string, 0)
	// We don't know if user passed in a directory or file, so query storage first.
	if err := IterateStoragePaths(ctx, projectRef, remotePath, func(objectName string) error {
		objectPath := basePath + objectName
		if strings.HasSuffix(objectName, "/") {
			dirQueue = append(dirQueue, objectPath)
			return nil
		}
		return callback(objectPath)
	}); err != nil {
		return err
	}
	for len(dirQueue) > 0 {
		dirPath := dirQueue[len(dirQueue)-1]
		dirQueue = dirQueue[:len(dirQueue)-1]
		empty := true
		if err := IterateStoragePaths(ctx, projectRef, dirPath, func(objectName string) error {
			empty = false
			objectPath := dirPath + objectName
			if strings.HasSuffix(objectName, "/") {
				dirQueue = append(dirQueue, objectPath)
				return nil
			}
			return callback(objectPath)
		}); err != nil {
			return err
		}
		// Also report empty buckets
		bucket, prefix := storage.SplitBucketPrefix(dirPath)
		if empty && len(prefix) == 0 {
			if err := callback(bucket + "/"); err != nil {
				return err
			}
		}
	}
	return nil
}
