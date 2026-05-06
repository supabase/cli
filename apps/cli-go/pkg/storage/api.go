package storage

import "github.com/supabase/cli/pkg/fetcher"

type StorageAPI struct {
	*fetcher.Fetcher
}

const PAGE_LIMIT = 100
