package cp

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/storage"
	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/storage/ls"
	"github.com/supabase/cli/internal/utils"
)

var errUnsupportedOperation = errors.New("Unsupported operation")

func Run(ctx context.Context, src, dst string, recursive bool, fsys afero.Fs) error {
	srcParsed, err := url.Parse(src)
	if err != nil {
		return err
	}
	dstParsed, err := url.Parse(dst)
	if err != nil {
		return err
	}
	projectRef, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	if strings.ToLower(srcParsed.Scheme) == storage.STORAGE_SCHEME && dstParsed.Scheme == "" {
		if recursive {
			return DownloadStorageObjectAll(ctx, projectRef, srcParsed.Path, dst, fsys)
		}
		return client.DownloadStorageObject(ctx, projectRef, srcParsed.Path, dst, fsys)
	} else if srcParsed.Scheme == "" && strings.ToLower(dstParsed.Scheme) == storage.STORAGE_SCHEME {
		if recursive {
			return UploadStorageObjectAll(ctx, projectRef, dstParsed.Path, src, fsys)
		}
		return client.UploadStorageObject(ctx, projectRef, dstParsed.Path, src, fsys)
	} else if strings.ToLower(srcParsed.Scheme) == storage.STORAGE_SCHEME && strings.ToLower(dstParsed.Scheme) == storage.STORAGE_SCHEME {
		return errors.New("Copying between buckets is not supported")
	}
	utils.CmdSuggestion = fmt.Sprintf("Run %s to copy between local directories.", utils.Aqua("cp -r <src> <dst>"))
	return errUnsupportedOperation
}

func DownloadStorageObjectAll(ctx context.Context, projectRef, remotePath, localPath string, fsys afero.Fs) error {
	// Prepare local directory for download
	if fi, err := fsys.Stat(localPath); err == nil && fi.IsDir() {
		localPath = filepath.Join(localPath, path.Base(remotePath))
	}
	count := 0
	if err := ls.IterateStoragePathsAll(ctx, projectRef, remotePath, func(objectPath string) error {
		relPath := strings.TrimPrefix(objectPath, remotePath)
		dstPath := filepath.Join(localPath, filepath.FromSlash(relPath))
		fmt.Fprintln(os.Stderr, "Downloading:", objectPath, "=>", dstPath)
		count++
		if strings.HasSuffix(objectPath, "/") {
			return utils.MkdirIfNotExistFS(fsys, dstPath)
		}
		if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(dstPath)); err != nil {
			return err
		}
		return client.DownloadStorageObject(ctx, projectRef, objectPath, dstPath, fsys)
	}); err != nil {
		return err
	}
	if count == 0 {
		return errors.New("Object not found: " + remotePath)
	}
	return nil
}

func UploadStorageObjectAll(ctx context.Context, projectRef, remotePath, localPath string, fsys afero.Fs) error {
	noSlash := strings.TrimSuffix(remotePath, "/")
	// Check if directory exists on remote
	dirExists := false
	fileExists := false
	if err := ls.IterateStoragePaths(ctx, projectRef, noSlash, func(objectName string) error {
		if objectName == path.Base(noSlash) {
			fileExists = true
		}
		if objectName == path.Base(noSlash)+"/" {
			dirExists = true
		}
		return nil
	}); err != nil {
		return err
	}
	baseName := filepath.Base(localPath)
	return afero.Walk(fsys, localPath, func(filePath string, info fs.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		relPath, err := filepath.Rel(localPath, filePath)
		if err != nil {
			return err
		}
		dstPath := remotePath
		// Copying single file
		if relPath == "." {
			if IsDir(dstPath) || (dirExists && !fileExists) {
				dstPath = path.Join(dstPath, info.Name())
			}
		} else {
			if baseName != "." && (dirExists || len(noSlash) == 0) {
				dstPath = path.Join(dstPath, baseName)
			}
			dstPath = path.Join(dstPath, relPath)
		}
		fmt.Fprintln(os.Stderr, "Uploading:", filePath, "=>", dstPath)
		err = client.UploadStorageObject(ctx, projectRef, dstPath, filePath, fsys)
		if err != nil && strings.Contains(err.Error(), `"error":"Bucket not found"`) {
			// Retry after creating bucket
			if bucket, prefix := storage.SplitBucketPrefix(dstPath); len(prefix) > 0 {
				if _, err := client.CreateStorageBucket(ctx, projectRef, bucket); err != nil {
					return err
				}
				err = client.UploadStorageObject(ctx, projectRef, dstPath, filePath, fsys)
			}
		}
		return err
	})
}

func IsDir(objectPath string) bool {
	return len(objectPath) == 0 || strings.HasSuffix(objectPath, "/")
}
