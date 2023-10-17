package ls

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/utils"
)

const STORAGE_SCHEME = "ss"

func Run(ctx context.Context, objectPath string, recursive bool, fsys afero.Fs) error {
	remotePath, err := ParseStorageURL(objectPath)
	if err != nil {
		return err
	}
	projectRef, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	paths, err := ListStoragePaths(ctx, projectRef, remotePath)
	if err != nil {
		return err
	}
	if recursive {
		basePath := remotePath
		if !strings.HasSuffix(remotePath, "/") {
			basePath, _ = path.Split(remotePath)
		}
		var result []string
		for i := len(paths) - 1; i >= 0; i-- {
			name := paths[i]
			if !strings.HasSuffix(name, "/") {
				result = append(result, name)
				continue
			}
			dirPath := basePath + name
			children, err := ListStoragePathsAll(ctx, projectRef, dirPath)
			if err != nil {
				return err
			}
			result = append(result, children...)
		}
		paths = result
	}
	if len(paths) > 0 {
		fmt.Println(strings.Join(paths, "\n"))
	}
	return nil
}

func ParseStorageURL(objectPath string) (string, error) {
	parsed, err := url.Parse(objectPath)
	if err != nil {
		return "", err
	}
	if strings.ToLower(parsed.Scheme) != STORAGE_SCHEME || len(parsed.Path) == 0 || len(parsed.Host) > 0 {
		return "", errors.New("URL must match pattern ss:///bucket/prefix")
	}
	return parsed.Path, nil
}

func ListStoragePaths(ctx context.Context, projectRef, remotePath string) ([]string, error) {
	var result []string
	bucket, prefix := SplitBucketPrefix(remotePath)
	if len(bucket) == 0 || (len(prefix) == 0 && !strings.HasSuffix(remotePath, "/")) {
		buckets, err := client.ListStorageBuckets(ctx, projectRef)
		if err != nil {
			return nil, err
		}
		for _, b := range buckets {
			if strings.HasPrefix(b.Name, bucket) {
				result = append(result, b.Name+"/")
			}
		}
	} else {
		pages := 1
		for i := 0; i < pages; i++ {
			objects, err := client.ListStorageObjects(ctx, projectRef, bucket, prefix, i)
			if err != nil {
				return nil, err
			}
			for _, o := range objects {
				name := o.Name
				if o.Id == nil {
					name += "/"
				}
				result = append(result, name)
			}
			if len(objects) == client.PAGE_LIMIT {
				// TODO: show interactive prompt?
				fmt.Fprintln(os.Stderr, "Loading page:", pages)
				pages++
			}
		}
	}
	return result, nil
}

func SplitBucketPrefix(objectPath string) (string, string) {
	if objectPath == "" || objectPath == "/" {
		return "", ""
	}
	sep := strings.IndexByte(objectPath[1:], '/')
	if sep < 0 {
		return objectPath[1:], ""
	}
	return objectPath[1 : sep+1], objectPath[sep+2:]
}

// Expects remotePath to be terminated by "/"
func ListStoragePathsAll(ctx context.Context, projectRef, remotePath string) ([]string, error) {
	var result []string
	queue := make([]string, 0)
	queue = append(queue, remotePath)
	for len(queue) > 0 {
		dirPath := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		paths, err := ListStoragePaths(ctx, projectRef, dirPath)
		if err != nil {
			return result, err
		}
		if len(paths) == 0 {
			result = append(result, dirPath)
		}
		for _, objectName := range paths {
			objectPath := dirPath + objectName
			if strings.HasSuffix(objectName, "/") {
				queue = append(queue, objectPath)
			} else {
				result = append(result, objectPath)
			}
		}
	}
	return result, nil
}
