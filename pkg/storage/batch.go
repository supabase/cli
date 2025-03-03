package storage

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/queue"
)

func (s *StorageAPI) UpsertBuckets(ctx context.Context, bucketConfig config.BucketConfig, filter ...func(string) bool) error {
	buckets, err := s.ListBuckets(ctx)
	if err != nil {
		return err
	}
	exists := make(map[string]string, len(buckets))
	for _, b := range buckets {
		exists[b.Name] = b.Id
	}
OUTER:
	for name, bucket := range bucketConfig {
		// Update bucket properties if already exists
		if bucketId, ok := exists[name]; ok {
			for _, keep := range filter {
				if !keep(bucketId) {
					continue OUTER
				}
			}
			fmt.Fprintln(os.Stderr, "Updating Storage bucket:", bucketId)
			body := UpdateBucketRequest{
				Id:               bucketId,
				Public:           bucket.Public,
				FileSizeLimit:    int64(bucket.FileSizeLimit),
				AllowedMimeTypes: bucket.AllowedMimeTypes,
			}
			if _, err := s.UpdateBucket(ctx, body); err != nil {
				return err
			}
		} else {
			fmt.Fprintln(os.Stderr, "Creating Storage bucket:", name)
			body := CreateBucketRequest{
				Name:             name,
				Public:           bucket.Public,
				FileSizeLimit:    int64(bucket.FileSizeLimit),
				AllowedMimeTypes: bucket.AllowedMimeTypes,
			}
			if _, err := s.CreateBucket(ctx, body); err != nil {
				return err
			}
		}
	}
	return nil
}

type UploadOptions struct {
	MaxConcurrency uint
	KeyPrefix      string
}

func (s *StorageAPI) UpsertObjects(ctx context.Context, bucketConfig config.BucketConfig, fsys fs.FS, opts ...func(*UploadOptions)) error {
	uo := UploadOptions{MaxConcurrency: 5}
	for _, apply := range opts {
		apply(&uo)
	}
	jq := queue.NewJobQueue(uo.MaxConcurrency)
	for name, bucket := range bucketConfig {
		localPath := bucket.ObjectsPath
		if len(localPath) == 0 {
			continue
		}
		upload := func(filePath string, info fs.DirEntry, err error) error {
			if err != nil {
				return errors.New(err)
			}
			if !info.Type().IsRegular() {
				return nil
			}
			dstPath := uo.KeyPrefix
			relPath, err := filepath.Rel(localPath, filePath)
			if err != nil {
				return errors.Errorf("failed to resolve relative path: %w", err)
			} else if relPath == "." {
				// Copying single file
				dstPath = path.Join(name, info.Name())
			} else {
				dstPath = path.Join(name, filepath.ToSlash(relPath))
			}
			fmt.Fprintln(os.Stderr, "Uploading:", filePath, "=>", dstPath)
			job := func() error {
				return s.UploadObject(ctx, dstPath, filePath, fsys, func(fo *FileOptions) {
					fo.Overwrite = true
				})
			}
			return jq.Put(job)
		}
		if err := fs.WalkDir(fsys, localPath, upload); err != nil {
			return err
		}
	}
	return jq.Collect()
}
