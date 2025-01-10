package storage

import (
	"context"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/pkg/fetcher"
)

type ListObjectsQuery struct {
	Prefix string `json:"prefix"`
	Search string `json:"search,omitempty"`
	Limit  int    `json:"limit,omitempty"`
	Offset int    `json:"offset,omitempty"`
}

type ObjectResponse struct {
	Name           string          `json:"name"`             // "abstract.pdf"
	Id             *string         `json:"id"`               // "9b7f9f48-17a6-4ca8-b14a-39b0205a63e9"
	UpdatedAt      *string         `json:"updated_at"`       // "2023-10-13T18:08:22.068Z"
	CreatedAt      *string         `json:"created_at"`       // "2023-10-13T18:08:22.068Z"
	LastAccessedAt *string         `json:"last_accessed_at"` // "2023-10-13T18:08:22.068Z"
	Metadata       *ObjectMetadata `json:"metadata"`         // null
}

type ObjectMetadata struct {
	ETag           string `json:"eTag"`           // "\"887ea9be3c68e6f2fca7fd2d7c77d8fe\""
	Size           int    `json:"size"`           // 82702
	Mimetype       string `json:"mimetype"`       // "application/pdf"
	CacheControl   string `json:"cacheControl"`   // "max-age=3600"
	LastModified   string `json:"lastModified"`   // "2023-10-13T18:08:22.000Z"
	ContentLength  int    `json:"contentLength"`  // 82702
	HttpStatusCode int    `json:"httpStatusCode"` // 200
}

func (s *StorageAPI) ListObjects(ctx context.Context, bucket, prefix string, page int) ([]ObjectResponse, error) {
	dir, name := path.Split(prefix)
	query := ListObjectsQuery{
		Prefix: dir,
		Search: name,
		Limit:  PAGE_LIMIT,
		Offset: PAGE_LIMIT * page,
	}
	resp, err := s.Send(ctx, http.MethodPost, "/storage/v1/object/list/"+bucket, query)
	if err != nil {
		return nil, err
	}
	return fetcher.ParseJSON[[]ObjectResponse](resp.Body)
}

type FileOptions struct {
	CacheControl string
	ContentType  string
	Overwrite    bool
}

func ParseFileOptions(f fs.File, opts ...func(*FileOptions)) (*FileOptions, error) {
	// Customise file options
	fo := &FileOptions{}
	for _, apply := range opts {
		apply(fo)
	}
	// Use default value of storage-js: https://github.com/supabase/storage-js/blob/main/src/packages/StorageFileApi.ts#L22
	if len(fo.CacheControl) == 0 {
		fo.CacheControl = "max-age=3600"
	}
	// Decode mimetype
	if len(fo.ContentType) == 0 {
		header := io.LimitReader(f, 512)
		buf, err := io.ReadAll(header)
		if err != nil {
			return nil, errors.Errorf("failed to read file: %w", err)
		}
		fo.ContentType = http.DetectContentType(buf)
		if s, ok := f.(io.Seeker); !ok {
			return nil, errors.Errorf("file is not seekable")
		} else if _, err = s.Seek(0, io.SeekStart); err != nil {
			return nil, errors.Errorf("failed to seek file: %w", err)
		}
	}
	return fo, nil
}

func (s *StorageAPI) UploadObject(ctx context.Context, remotePath, localPath string, fsys fs.FS, opts ...func(*FileOptions)) error {
	f, err := fsys.Open(localPath)
	if err != nil {
		return errors.Errorf("failed to open file: %w", err)
	}
	defer f.Close()
	fo, err := ParseFileOptions(f, opts...)
	if err != nil {
		return err
	}
	// For text/plain content types, we try to determine a more specific type
	// based on the file extension, as the initial detection might be too generic
	if strings.Contains(fo.ContentType, "text/plain") {
		if extensionType := mime.TypeByExtension(filepath.Ext(localPath)); extensionType != "" {
			fo.ContentType = extensionType
		}
	}
	return s.UploadObjectStream(ctx, remotePath, f, *fo)
}

func (s *StorageAPI) UploadObjectStream(ctx context.Context, remotePath string, localFile io.Reader, fo FileOptions) error {
	headers := func(req *http.Request) {
		if len(fo.ContentType) > 0 {
			req.Header.Add("Content-Type", fo.ContentType)
		}
		if len(fo.CacheControl) > 0 {
			req.Header.Add("Cache-Control", fo.CacheControl)
		}
		if fo.Overwrite {
			req.Header.Add("x-upsert", "true")
		}
	}
	// Prepare request
	remotePath = strings.TrimPrefix(remotePath, "/")
	resp, err := s.Send(ctx, http.MethodPost, "/storage/v1/object/"+remotePath, io.NopCloser(localFile), headers)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

func (s *StorageAPI) DownloadObject(ctx context.Context, remotePath, localPath string, fsys afero.Fs) error {
	f, err := fsys.OpenFile(localPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return errors.Errorf("failed to create file: %w", err)
	}
	defer f.Close()
	return s.DownloadObjectStream(ctx, remotePath, f)
}

func (s *StorageAPI) DownloadObjectStream(ctx context.Context, remotePath string, localFile io.Writer) error {
	remotePath = strings.TrimPrefix(remotePath, "/")
	resp, err := s.Send(ctx, http.MethodGet, "/storage/v1/object/"+remotePath, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, err = io.Copy(localFile, resp.Body)
	return err
}

type MoveObjectRequest struct {
	BucketId       string `json:"bucketId"`
	SourceKey      string `json:"sourceKey"`
	DestinationKey string `json:"destinationKey"`
}

type MoveObjectResponse = DeleteBucketResponse

func (s *StorageAPI) MoveObject(ctx context.Context, bucketId, srcPath, dstPath string) (MoveObjectResponse, error) {
	body := MoveObjectRequest{
		BucketId:       bucketId,
		SourceKey:      srcPath,
		DestinationKey: dstPath,
	}
	resp, err := s.Send(ctx, http.MethodPost, "/storage/v1/object/move", body)
	if err != nil {
		return MoveObjectResponse{}, err
	}
	return fetcher.ParseJSON[MoveObjectResponse](resp.Body)
}

type CopyObjectRequest = MoveObjectRequest

type CopyObjectResponse struct {
	Key string `json:"key"`
}

func (s *StorageAPI) CopyObject(ctx context.Context, bucketId, srcPath, dstPath string) (CopyObjectResponse, error) {
	body := CopyObjectRequest{
		BucketId:       bucketId,
		SourceKey:      srcPath,
		DestinationKey: dstPath,
	}
	resp, err := s.Send(ctx, http.MethodPost, "/storage/v1/object/copy", body)
	if err != nil {
		return CopyObjectResponse{}, err
	}
	return fetcher.ParseJSON[CopyObjectResponse](resp.Body)
}

type DeleteObjectsRequest struct {
	Prefixes []string `json:"prefixes"`
}

type DeleteObjectsResponse struct {
	BucketId       string         `json:"bucket_id"`        // "private"
	Owner          string         `json:"owner"`            // ""
	OwnerId        string         `json:"owner_id"`         // ""
	Version        string         `json:"version"`          // "cf5c5c53-ee73-4806-84e3-7d92c954b436"
	Name           string         `json:"name"`             // "abstract.pdf"
	Id             string         `json:"id"`               // "9b7f9f48-17a6-4ca8-b14a-39b0205a63e9"
	UpdatedAt      string         `json:"updated_at"`       // "2023-10-13T18:08:22.068Z"
	CreatedAt      string         `json:"created_at"`       // "2023-10-13T18:08:22.068Z"
	LastAccessedAt string         `json:"last_accessed_at"` // "2023-10-13T18:08:22.068Z"
	Metadata       ObjectMetadata `json:"metadata"`         // null
}

func (s *StorageAPI) DeleteObjects(ctx context.Context, bucket string, prefixes []string) ([]DeleteObjectsResponse, error) {
	body := DeleteObjectsRequest{Prefixes: prefixes}
	resp, err := s.Send(ctx, http.MethodDelete, "/storage/v1/object/"+bucket, body)
	if err != nil {
		return nil, err
	}
	return fetcher.ParseJSON[[]DeleteObjectsResponse](resp.Body)
}
