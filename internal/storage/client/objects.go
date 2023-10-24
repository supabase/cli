package client

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/tenant"
)

const PAGE_LIMIT = 100

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

func ListStorageObjects(ctx context.Context, projectRef, bucket, prefix string, page int) ([]ObjectResponse, error) {
	url := fmt.Sprintf("https://%s/storage/v1/object/list/%s", utils.GetSupabaseHost(projectRef), bucket)
	apiKey, err := tenant.GetApiKeys(ctx, projectRef)
	if err != nil {
		return nil, err
	}
	dir, name := path.Split(prefix)
	query := ListObjectsQuery{
		Prefix: dir,
		Search: name,
		Limit:  PAGE_LIMIT,
		Offset: PAGE_LIMIT * page,
	}
	data, err := tenant.JsonResponseWithBearer[[]ObjectResponse](ctx, http.MethodPost, url, apiKey.ServiceRole, query)
	if err != nil {
		return nil, err
	}
	return *data, nil
}

func UploadStorageObject(ctx context.Context, projectRef, remotePath, localPath string, fsys afero.Fs) error {
	f, err := fsys.Open(localPath)
	if err != nil {
		return err
	}
	defer f.Close()
	// Decode mimetype
	header := io.LimitReader(f, 512)
	buf, err := io.ReadAll(header)
	if err != nil {
		return err
	}
	mimetype := http.DetectContentType(buf)
	_, err = f.Seek(0, io.SeekStart)
	if err != nil {
		return err
	}
	// Prepare request
	apiKey, err := tenant.GetApiKeys(ctx, projectRef)
	if err != nil {
		return err
	}
	remotePath = strings.TrimPrefix(remotePath, "/")
	url := fmt.Sprintf("https://%s/storage/v1/object/%s", utils.GetSupabaseHost(projectRef), remotePath)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, f)
	if err != nil {
		return err
	}
	req.Header.Add("Authorization", "Bearer "+apiKey.ServiceRole)
	req.Header.Add("Content-Type", mimetype)
	// Use default value of storage-js: https://github.com/supabase/storage-js/blob/main/src/packages/StorageFileApi.ts#L22
	req.Header.Add("Cache-Control", "max-age=3600")
	// Sends request
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
		return fmt.Errorf("Error status %d: %s", resp.StatusCode, body)
	}
	return nil
}

func DownloadStorageObject(ctx context.Context, projectRef, remotePath, localPath string, fsys afero.Fs) error {
	apiKey, err := tenant.GetApiKeys(ctx, projectRef)
	if err != nil {
		return err
	}
	remotePath = strings.TrimPrefix(remotePath, "/")
	url := fmt.Sprintf("https://%s/storage/v1/object/%s", utils.GetSupabaseHost(projectRef), remotePath)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Add("Authorization", "Bearer "+apiKey.ServiceRole)
	// Sends request
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
		return fmt.Errorf("Error status %d: %s", resp.StatusCode, body)
	}
	// Streams to file
	f, err := fsys.OpenFile(localPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
}

type MoveObjectRequest struct {
	BucketId       string `json:"bucketId"`
	SourceKey      string `json:"sourceKey"`
	DestinationKey string `json:"destinationKey"`
}

type MoveObjectResponse = DeleteBucketResponse

func MoveStorageObject(ctx context.Context, projectRef, bucketId, srcPath, dstPath string) (*MoveObjectResponse, error) {
	url := fmt.Sprintf("https://%s/storage/v1/object/move", utils.GetSupabaseHost(projectRef))
	apiKey, err := tenant.GetApiKeys(ctx, projectRef)
	if err != nil {
		return nil, err
	}
	body := MoveObjectRequest{
		BucketId:       bucketId,
		SourceKey:      srcPath,
		DestinationKey: dstPath,
	}
	return tenant.JsonResponseWithBearer[MoveObjectResponse](ctx, http.MethodPost, url, apiKey.ServiceRole, body)
}

type CopyObjectRequest = MoveObjectRequest

type CopyObjectResponse struct {
	Key string `json:"key"`
}

func CopyStorageObject(ctx context.Context, projectRef, bucketId, srcPath, dstPath string) (*CopyObjectResponse, error) {
	url := fmt.Sprintf("https://%s/storage/v1/object/copy", utils.GetSupabaseHost(projectRef))
	apiKey, err := tenant.GetApiKeys(ctx, projectRef)
	if err != nil {
		return nil, err
	}
	body := CopyObjectRequest{
		BucketId:       bucketId,
		SourceKey:      srcPath,
		DestinationKey: dstPath,
	}
	return tenant.JsonResponseWithBearer[CopyObjectResponse](ctx, http.MethodPost, url, apiKey.ServiceRole, body)
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

func DeleteStorageObjects(ctx context.Context, projectRef, bucket string, prefixes []string) ([]DeleteObjectsResponse, error) {
	url := fmt.Sprintf("https://%s/storage/v1/object/%s", utils.GetSupabaseHost(projectRef), bucket)
	apiKey, err := tenant.GetApiKeys(ctx, projectRef)
	if err != nil {
		return nil, err
	}
	body := DeleteObjectsRequest{Prefixes: prefixes}
	data, err := tenant.JsonResponseWithBearer[[]DeleteObjectsResponse](ctx, http.MethodDelete, url, apiKey.ServiceRole, body)
	if err != nil {
		return nil, err
	}
	return *data, nil
}
