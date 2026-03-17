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
		S3Protocol          *s3Protocol          `toml:"s3_protocol"`
		S3Credentials       storageS3Credentials `toml:"-"`
		Buckets             BucketConfig         `toml:"buckets"`
		AnalyticsBuckets    analyticsBuckets     `toml:"analytics"`
		VectorBuckets       vectorBuckets        `toml:"vector"`
	}

	imageTransformation struct {
		Enabled bool `toml:"enabled"`
	}

	analyticsBuckets struct {
		Enabled       bool                `toml:"enabled"`
		MaxNamespaces uint                `toml:"max_namespaces"`
		MaxTables     uint                `toml:"max_tables"`
		MaxCatalogs   uint                `toml:"max_catalogs"`
		Buckets       map[string]struct{} `toml:"buckets"`
	}

	vectorBuckets struct {
		Enabled    bool                `toml:"enabled"`
		MaxBuckets uint                `toml:"max_buckets"`
		MaxIndexes uint                `toml:"max_indexes"`
		Buckets    map[string]struct{} `toml:"buckets"`
	}

	s3Protocol struct {
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
		Features: &struct {
			IcebergCatalog *struct {
				Enabled       bool `json:"enabled"`
				MaxCatalogs   int  `json:"maxCatalogs"`
				MaxNamespaces int  `json:"maxNamespaces"`
				MaxTables     int  `json:"maxTables"`
			} `json:"icebergCatalog,omitempty"`
			ImageTransformation *struct {
				Enabled bool `json:"enabled"`
			} `json:"imageTransformation,omitempty"`
			S3Protocol *struct {
				Enabled bool `json:"enabled"`
			} `json:"s3Protocol,omitempty"`
			VectorBuckets *struct {
				Enabled    bool `json:"enabled"`
				MaxBuckets int  `json:"maxBuckets"`
				MaxIndexes int  `json:"maxIndexes"`
			} `json:"vectorBuckets,omitempty"`
		}{},
	}
	// When local config is not set, we assume platform defaults should not change
	if s.ImageTransformation != nil {
		body.Features.ImageTransformation = &struct {
			Enabled bool `json:"enabled"`
		}{
			Enabled: s.ImageTransformation.Enabled,
		}
	}
	// Disabling analytics and vector buckets means leaving platform values unchanged
	if s.AnalyticsBuckets.Enabled {
		body.Features.IcebergCatalog = &struct {
			Enabled       bool `json:"enabled"`
			MaxCatalogs   int  `json:"maxCatalogs"`
			MaxNamespaces int  `json:"maxNamespaces"`
			MaxTables     int  `json:"maxTables"`
		}{
			Enabled:       true,
			MaxNamespaces: cast.UintToInt(s.AnalyticsBuckets.MaxNamespaces),
			MaxTables:     cast.UintToInt(s.AnalyticsBuckets.MaxTables),
			MaxCatalogs:   cast.UintToInt(s.AnalyticsBuckets.MaxCatalogs),
		}
	}
	if s.VectorBuckets.Enabled {
		body.Features.VectorBuckets = &struct {
			Enabled    bool `json:"enabled"`
			MaxBuckets int  `json:"maxBuckets"`
			MaxIndexes int  `json:"maxIndexes"`
		}{
			Enabled:    true,
			MaxBuckets: cast.UintToInt(s.VectorBuckets.MaxBuckets),
			MaxIndexes: cast.UintToInt(s.VectorBuckets.MaxIndexes),
		}
	}
	if s.S3Protocol != nil {
		body.Features.S3Protocol = &struct {
			Enabled bool `json:"enabled"`
		}{
			Enabled: s.S3Protocol.Enabled,
		}
	}
	return body
}

func (s *storage) FromRemoteStorageConfig(remoteConfig v1API.StorageConfigResponse) {
	s.FileSizeLimit = sizeInBytes(remoteConfig.FileSizeLimit)
	s.TargetMigration = remoteConfig.MigrationVersion
	// When local config is not set, we assume platform defaults should not change
	if s.ImageTransformation != nil {
		s.ImageTransformation.Enabled = remoteConfig.Features.ImageTransformation.Enabled
	}
	if s.AnalyticsBuckets.Enabled {
		s.AnalyticsBuckets.Enabled = remoteConfig.Features.IcebergCatalog.Enabled
		s.AnalyticsBuckets.MaxNamespaces = cast.IntToUint(remoteConfig.Features.IcebergCatalog.MaxNamespaces)
		s.AnalyticsBuckets.MaxTables = cast.IntToUint(remoteConfig.Features.IcebergCatalog.MaxTables)
		s.AnalyticsBuckets.MaxCatalogs = cast.IntToUint(remoteConfig.Features.IcebergCatalog.MaxCatalogs)
	}
	if s.VectorBuckets.Enabled {
		s.VectorBuckets.Enabled = remoteConfig.Features.VectorBuckets.Enabled
		s.VectorBuckets.MaxBuckets = cast.IntToUint(remoteConfig.Features.VectorBuckets.MaxBuckets)
		s.VectorBuckets.MaxIndexes = cast.IntToUint(remoteConfig.Features.VectorBuckets.MaxIndexes)
	}
	if s.S3Protocol != nil {
		s.S3Protocol.Enabled = remoteConfig.Features.S3Protocol.Enabled
	}
}

func (s *storage) DiffWithRemote(remoteConfig v1API.StorageConfigResponse) ([]byte, error) {
	copy := s.Clone()
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
