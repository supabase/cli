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
	return fetcher.ParseJSON[[]BucketResponse](resp.Body)
}

type CreateBucketRequest struct {
	Name             string   `json:"name"`                         // "string",
	Id               string   `json:"id,omitempty"`                 // "string",
	Public           *bool    `json:"public,omitempty"`             // false,
	FileSizeLimit    int64    `json:"file_size_limit,omitempty"`    // 0,
	AllowedMimeTypes []string `json:"allowed_mime_types,omitempty"` // ["string"]
}

type CreateBucketResponse struct {
	Name string `json:"name"`
}

func (s *StorageAPI) CreateBucket(ctx context.Context, body CreateBucketRequest) (CreateBucketResponse, error) {
	resp, err := s.Send(ctx, http.MethodPost, "/storage/v1/bucket", body)
	if err != nil {
		return CreateBucketResponse{}, err
	}
	return fetcher.ParseJSON[CreateBucketResponse](resp.Body)
}

type UpdateBucketRequest struct {
	Id               string   `json:"-"`
	Public           *bool    `json:"public,omitempty"`             // false,
	FileSizeLimit    int64    `json:"file_size_limit,omitempty"`    // 0,
	AllowedMimeTypes []string `json:"allowed_mime_types,omitempty"` // ["string"]
}

type UpdateBucketResponse struct {
	Message string `json:"message"`
}

func (s *StorageAPI) UpdateBucket(ctx context.Context, body UpdateBucketRequest) (UpdateBucketResponse, error) {
	resp, err := s.Send(ctx, http.MethodPut, "/storage/v1/bucket/"+body.Id, body)
	if err != nil {
		return UpdateBucketResponse{}, err
	}
	return fetcher.ParseJSON[UpdateBucketResponse](resp.Body)
}

type DeleteBucketResponse struct {
	Message string `json:"message"`
}

func (s *StorageAPI) DeleteBucket(ctx context.Context, bucketId string) (DeleteBucketResponse, error) {
	resp, err := s.Send(ctx, http.MethodDelete, "/storage/v1/bucket/"+bucketId, nil)
	if err != nil {
		return DeleteBucketResponse{}, err
	}
	return fetcher.ParseJSON[DeleteBucketResponse](resp.Body)
}
