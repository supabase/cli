package storage

import (
	"context"
	"net/http"

	"github.com/supabase/cli/pkg/fetcher"
)

type BucketResponse struct {
	Id               string   `json:"id"`                 // "test"
	Name             string   `json:"name"`               // "test"
	Owner            string   `json:"owner"`              // ""
	Public           bool     `json:"public"`             // true
	FileSizeLimit    *int     `json:"file_size_limit"`    // null
	AllowedMimeTypes []string `json:"allowed_mime_types"` // null
	CreatedAt        string   `json:"created_at"`         // "2023-10-13T17:48:58.491Z"
	UpdatedAt        string   `json:"updated_at"`         // "2023-10-13T17:48:58.491Z"
}

func (s *StorageAPI) ListBuckets(ctx context.Context) ([]BucketResponse, error) {
	resp, err := s.Send(ctx, http.MethodGet, "/storage/v1/bucket", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return fetcher.ParseJSON[[]BucketResponse](resp.Body)
}

type CreateBucketRequest struct {
	Name             string   `json:"name"`                         // "string",
	Id               string   `json:"id,omitempty"`                 // "string",
	Public           bool     `json:"public,omitempty"`             // false,
	FileSizeLimit    int      `json:"file_size_limit,omitempty"`    // 0,
	AllowedMimeTypes []string `json:"allowed_mime_types,omitempty"` // ["string"]
}

type CreateBucketResponse struct {
	Name string `json:"name"`
}

func (s *StorageAPI) CreateBucket(ctx context.Context, bucketName string) (CreateBucketResponse, error) {
	body := CreateBucketRequest{Name: bucketName}
	resp, err := s.Send(ctx, http.MethodPost, "/storage/v1/bucket", body)
	if err != nil {
		return CreateBucketResponse{}, err
	}
	defer resp.Body.Close()
	return fetcher.ParseJSON[CreateBucketResponse](resp.Body)
}

type DeleteBucketResponse struct {
	Message string `json:"message"`
}

func (s *StorageAPI) DeleteBucket(ctx context.Context, bucketId string) (DeleteBucketResponse, error) {
	resp, err := s.Send(ctx, http.MethodDelete, "/storage/v1/bucket/"+bucketId, nil)
	if err != nil {
		return DeleteBucketResponse{}, err
	}
	defer resp.Body.Close()
	return fetcher.ParseJSON[DeleteBucketResponse](resp.Body)
}
