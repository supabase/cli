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
	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/storage/ls"
	"github.com/supabase/cli/internal/utils"
)

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
	if strings.ToLower(srcParsed.Scheme) == ls.STORAGE_SCHEME && dstParsed.Scheme == "" {
		if recursive {
			return DownloadStorageObjectAll(ctx, projectRef, srcParsed.Path, dst, fsys)
		}
		// TODO: Check if destination is a directory
		return client.DownloadStorageObject(ctx, projectRef, srcParsed.Path, dst, fsys)
	} else if srcParsed.Scheme == "" && strings.ToLower(dstParsed.Scheme) == ls.STORAGE_SCHEME {
		if recursive {
			return UploadStorageObjectAll(ctx, projectRef, dstParsed.Path, src, fsys)
		}
		// TODO: Check if destination is a directory
		return client.UploadStorageObject(ctx, projectRef, dstParsed.Path, src, fsys)
	}
	return errors.New("Unsupported operation")
}

func DownloadStorageObjectAll(ctx context.Context, projectRef, remotePath, localPath string, fsys afero.Fs) error {
	remotePath = path.Join("/", remotePath)
	if fi, err := fsys.Stat(localPath); err == nil && fi.IsDir() {
		localPath = filepath.Join(localPath, path.Base(remotePath))
	}
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(localPath)); err != nil {
		return err
	}
	if !IsDir(remotePath) {
		fmt.Fprintln(os.Stderr, "Downloading:", remotePath, "=>", localPath)
		if err := client.DownloadStorageObject(ctx, projectRef, remotePath, localPath, fsys); err != nil && strings.Contains(err.Error(), `"error":"Not Found"`) {
			// Retry downloading as directory
			remotePath += "/"
		} else {
			return err
		}
	}
	queue := make([]string, 0)
	queue = append(queue, remotePath)
	for len(queue) > 0 {
		dirPath := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		paths, err := ls.ListStoragePaths(ctx, projectRef, dirPath)
		if err != nil {
			return err
		}
		if strings.Count(dirPath, "/") > 2 && len(paths) == 0 {
			return errors.New("Object not found: " + dirPath)
		}
		for _, objectName := range paths {
			objectPath := dirPath + objectName
			relPath := strings.TrimPrefix(objectPath, remotePath)
			dstPath := filepath.Join(localPath, filepath.FromSlash(relPath))
			fmt.Fprintln(os.Stderr, "Downloading:", objectPath, "=>", dstPath)
			if strings.HasSuffix(objectName, "/") {
				if err := utils.MkdirIfNotExistFS(fsys, dstPath); err != nil {
					return err
				}
				queue = append(queue, objectPath)
				continue
			}
			if err := client.DownloadStorageObject(ctx, projectRef, objectPath, dstPath, fsys); err != nil {
				return err
			}
		}
	}
	return nil
}

func UploadStorageObjectAll(ctx context.Context, projectRef, remotePath, localPath string, fsys afero.Fs) error {
	noSlash := strings.TrimSuffix(remotePath, "/")
	paths, err := ls.ListStoragePaths(ctx, projectRef, noSlash)
	if err != nil {
		return err
	}
	// Check if directory exists on remote
	dirExists := false
	fileExists := false
	for _, p := range paths {
		if p == path.Base(noSlash) {
			fileExists = true
		}
		if p == path.Base(noSlash)+"/" {
			dirExists = true
		}
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
			if bucket, prefix := ls.SplitBucketPrefix(dstPath); len(prefix) > 0 {
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
