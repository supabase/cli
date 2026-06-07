package cp

import (
	"context"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/storage/client"
	"github.com/supabase/cli/internal/storage/ls"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/queue"
	"github.com/supabase/cli/pkg/storage"
)

var errUnsupportedOperation = errors.New("Unsupported operation")

func Run(ctx context.Context, src, dst string, recursive bool, maxJobs uint, fsys afero.Fs, opts ...func(*storage.FileOptions)) error {
	srcParsed, err := url.Parse(src)
	if err != nil {
		return errors.Errorf("failed to parse src url: %w", err)
	}
	dstParsed, err := url.Parse(dst)
	if err != nil {
		return errors.Errorf("failed to parse dst url: %w", err)
	}
	api, err := client.NewStorageAPI(ctx, flags.ProjectRef)
	if err != nil {
		return err
	}
	if strings.EqualFold(srcParsed.Scheme, client.STORAGE_SCHEME) && dstParsed.Scheme == "" {
		localPath := dst
		if !filepath.IsAbs(dst) {
			localPath = filepath.Join(utils.CurrentDirAbs, dst)
		}
		if recursive {
			return DownloadStorageObjectAll(ctx, api, srcParsed.Path, localPath, maxJobs, fsys)
		}
		return api.DownloadObject(ctx, srcParsed.Path, localPath, fsys)
	} else if srcParsed.Scheme == "" && strings.EqualFold(dstParsed.Scheme, client.STORAGE_SCHEME) {
		localPath := src
		if !filepath.IsAbs(localPath) {
			localPath = filepath.Join(utils.CurrentDirAbs, localPath)
		}
		if recursive {
			return UploadStorageObjectAll(ctx, api, dstParsed.Path, localPath, maxJobs, fsys, opts...)
		}
		return api.UploadObject(ctx, dstParsed.Path, src, utils.NewRootFS(fsys), opts...)
	} else if strings.EqualFold(srcParsed.Scheme, client.STORAGE_SCHEME) && strings.EqualFold(dstParsed.Scheme, client.STORAGE_SCHEME) {
		return errors.New("Copying between buckets is not supported")
	}
	utils.CmdSuggestion = fmt.Sprintf("Run %s to copy between local directories.", utils.Aqua("cp -r <src> <dst>"))
	return errors.New(errUnsupportedOperation)
}

func DownloadStorageObjectAll(ctx context.Context, api storage.StorageAPI, remotePath, localPath string, maxJobs uint, fsys afero.Fs) error {
	// Prepare local directory for download
	if fi, err := fsys.Stat(localPath); err == nil && fi.IsDir() {
		localPath = filepath.Join(localPath, path.Base(remotePath))
	}
	// No need to be atomic because it's incremented only on main thread
	count := 0
	jq := queue.NewJobQueue(maxJobs)
	err := ls.IterateStoragePathsAll(ctx, api, remotePath, func(objectPath string) error {
		relPath := strings.TrimPrefix(objectPath, remotePath)
		dstPath := filepath.Join(localPath, filepath.FromSlash(relPath))
		fmt.Fprintln(os.Stderr, "Downloading:", objectPath, "=>", dstPath)
		count++
		job := func() error {
			if strings.HasSuffix(objectPath, "/") {
				return utils.MkdirIfNotExistFS(fsys, dstPath)
			}
			if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(dstPath)); err != nil {
				return err
			}
			// Overwrites existing file when using --recursive flag
			f, err := fsys.OpenFile(dstPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
			if err != nil {
				return errors.Errorf("failed to create file: %w", err)
			}
			defer f.Close()
			return api.DownloadObjectStream(ctx, objectPath, f)
		}
		return jq.Put(job)
	})
	if count == 0 {
		return errors.New("Object not found: " + remotePath)
	}
	return errors.Join(err, jq.Collect())
}

func UploadStorageObjectAll(ctx context.Context, api storage.StorageAPI, remotePath, localPath string, maxJobs uint, fsys afero.Fs, opts ...func(*storage.FileOptions)) error {
	noSlash := strings.TrimSuffix(remotePath, "/")
	// Check if directory exists on remote
	dirExists := false
	fileExists := false
	if len(noSlash) > 0 {
		callback := func(objectName string) error {
			if objectName == path.Base(noSlash) {
				fileExists = true
			}
			if objectName == path.Base(noSlash)+"/" {
				dirExists = true
			}
			return nil
		}
		if err := ls.IterateStoragePaths(ctx, api, noSlash, callback); err != nil {
			return err
		}
	}
	// Overwrites existing object when using --recursive flag
	opts = append(opts, func(fo *storage.FileOptions) {
		fo.Overwrite = true
	})
	baseName := filepath.Base(localPath)
	jq := queue.NewJobQueue(maxJobs)
	err := afero.Walk(fsys, localPath, func(filePath string, info fs.FileInfo, err error) error {
		if err != nil {
			return errors.New(err)
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		relPath, err := filepath.Rel(localPath, filePath)
		if err != nil {
			return errors.Errorf("failed to resolve relative path: %w", err)
		}
		dstPath := remotePath
		// Copying single file
		if relPath == "." {
			_, prefix := client.SplitBucketPrefix(dstPath)
			if IsDir(prefix) || (dirExists && !fileExists) {
				// Keep the file name when destination is a directory
				dstPath = path.Join(dstPath, info.Name())
			}
		} else {
			if baseName != "." && (dirExists || len(noSlash) == 0) {
				dstPath = path.Join(dstPath, baseName)
			}
			dstPath = path.Join(dstPath, relPath)
		}
		fmt.Fprintln(os.Stderr, "Uploading:", filePath, "=>", dstPath)
		job := func() error {
			err := api.UploadObject(ctx, dstPath, filePath, utils.NewRootFS(fsys), opts...)
			if err != nil && strings.Contains(err.Error(), `"error":"Bucket not found"`) {
				// Retry after creating bucket
				if bucket, prefix := client.SplitBucketPrefix(dstPath); len(prefix) > 0 {
					body := storage.CreateBucketRequest{Name: bucket}
					if config, ok := utils.Config.Storage.Buckets[bucket]; ok {
						body.Public = config.Public
						body.FileSizeLimit = int64(config.FileSizeLimit)
						body.AllowedMimeTypes = config.AllowedMimeTypes
					}
					if _, err := api.CreateBucket(ctx, body); err != nil {
						return err
					}
					err = api.UploadObject(ctx, dstPath, filePath, utils.NewRootFS(fsys), opts...)
				}
			}
			return err
		}
		return jq.Put(job)
	})
	return errors.Join(err, jq.Collect())
}

func IsDir(objectPrefix string) bool {
	return len(objectPrefix) == 0 || strings.HasSuffix(objectPrefix, "/")
}
