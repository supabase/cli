package config

import (
	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/diff"
)

type (
	storage struct {
		Enabled             bool                 `toml:"enabled"`
		Image               string               `toml:"-"`
		TargetMigration     string               `toml:"-"`
		ImgProxyImage       string               `toml:"-"`
		FileSizeLimit       sizeInBytes          `toml:"file_size_limit"`
		ImageTransformation *imageTransformation `toml:"image_transformation"`
		S3Credentials       storageS3Credentials `toml:"-"`
		Buckets             BucketConfig         `toml:"buckets"`
	}

	imageTransformation struct {
		Enabled bool `toml:"enabled"`
	}

	storageS3Credentials struct {
		AccessKeyId     string `toml:"-"`
		SecretAccessKey string `toml:"-"`
		Region          string `toml:"-"`
	}

	BucketConfig map[string]bucket

	bucket struct {
		Public           *bool       `toml:"public"`
		FileSizeLimit    sizeInBytes `toml:"file_size_limit"`
		AllowedMimeTypes []string    `toml:"allowed_mime_types"`
		ObjectsPath      string      `toml:"objects_path"`
	}
)

func (s *storage) ToUpdateStorageConfigBody() v1API.UpdateStorageConfigBody {
	body := v1API.UpdateStorageConfigBody{
		FileSizeLimit: cast.Ptr(int64(s.FileSizeLimit)),
	}
	// When local config is not set, we assume platform defaults should not change
	if s.ImageTransformation != nil {
		body.Features = &struct {
			IcebergCatalog *struct {
				Enabled bool `json:"enabled"`
			} `json:"icebergCatalog,omitempty"`
			ImageTransformation struct {
				Enabled bool `json:"enabled"`
			} `json:"imageTransformation"`
			S3Protocol struct {
				Enabled bool `json:"enabled"`
			} `json:"s3Protocol"`
		}{}
		body.Features.ImageTransformation.Enabled = s.ImageTransformation.Enabled
	}
	return body
}

func (s *storage) FromRemoteStorageConfig(remoteConfig v1API.StorageConfigResponse) {
	s.FileSizeLimit = sizeInBytes(remoteConfig.FileSizeLimit)
	// When local config is not set, we assume platform defaults should not change
	if s.ImageTransformation != nil {
		s.ImageTransformation.Enabled = remoteConfig.Features.ImageTransformation.Enabled
	}
}

func (s *storage) DiffWithRemote(remoteConfig v1API.StorageConfigResponse) ([]byte, error) {
	copy := s.Clone()
	if s.ImageTransformation != nil {
		img := *s.ImageTransformation
		copy.ImageTransformation = &img
	}
	// Convert the config values into easily comparable remoteConfig values
	currentValue, err := ToTomlBytes(copy)
	if err != nil {
		return nil, err
	}
	copy.FromRemoteStorageConfig(remoteConfig)
	remoteCompare, err := ToTomlBytes(copy)
	if err != nil {
		return nil, err
	}
	return diff.Diff("remote[storage]", remoteCompare, "local[storage]", currentValue), nil
}
