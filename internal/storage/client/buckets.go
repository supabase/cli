package client

import (
	"context"
	"fmt"
	"net/http"

	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/tenant"
)

type BucketResponse struct {
	Id               string  `json:"id"`                 // "test"
	Name             string  `json:"name"`               // "test"
	Owner            string  `json:"owner"`              // ""
	Public           bool    `json:"public"`             // true
	FileSizeLimit    *int    `json:"file_size_limit"`    // null
	AllowedMimeTypes *string `json:"allowed_mime_types"` // null
	CreatedAt        string  `json:"created_at"`         // "2023-10-13T17:48:58.491Z"
	UpdatedAt        string  `json:"updated_at"`         // "2023-10-13T17:48:58.491Z"
}

func ListStorageBuckets(ctx context.Context, projectRef string) ([]BucketResponse, error) {
	url := fmt.Sprintf("https://%s/storage/v1/bucket", utils.GetSupabaseHost(projectRef))
	apiKey, err := tenant.GetApiKeys(ctx, projectRef)
	if err != nil {
		return nil, err
	}
	data, err := tenant.JsonResponseWithBearer[[]BucketResponse](ctx, http.MethodGet, url, apiKey.ServiceRole, nil)
	if err != nil {
		return nil, err
	}
	return *data, nil
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

func CreateStorageBucket(ctx context.Context, projectRef, bucketName string) (*CreateBucketResponse, error) {
	url := fmt.Sprintf("https://%s/storage/v1/bucket", utils.GetSupabaseHost(projectRef))
	apiKey, err := tenant.GetApiKeys(ctx, projectRef)
	if err != nil {
		return nil, err
	}
	body := CreateBucketRequest{Name: bucketName}
	return tenant.JsonResponseWithBearer[CreateBucketResponse](ctx, http.MethodPost, url, apiKey.ServiceRole, body)
}

type DeleteBucketResponse struct {
	Message string `json:"message"`
}

func DeleteStorageBucket(ctx context.Context, projectRef, bucketId string) (*DeleteBucketResponse, error) {
	url := fmt.Sprintf("https://%s/storage/v1/bucket/%s", utils.GetSupabaseHost(projectRef), bucketId)
	apiKey, err := tenant.GetApiKeys(ctx, projectRef)
	if err != nil {
		return nil, err
	}
	return tenant.JsonResponseWithBearer[DeleteBucketResponse](ctx, http.MethodDelete, url, apiKey.ServiceRole, nil)
}
