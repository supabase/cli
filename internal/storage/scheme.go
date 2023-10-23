package storage

import (
	"errors"
	"net/url"
	"strings"
)

const STORAGE_SCHEME = "ss"

var ErrInvalidURL = errors.New("URL must match pattern ss:///bucket/[prefix]")

func ParseStorageURL(objectURL string) (string, error) {
	parsed, err := url.Parse(objectURL)
	if err != nil {
		return "", err
	}
	if strings.ToLower(parsed.Scheme) != STORAGE_SCHEME || len(parsed.Path) == 0 || len(parsed.Host) > 0 {
		return "", ErrInvalidURL
	}
	return parsed.Path, nil
}

func SplitBucketPrefix(objectPath string) (string, string) {
	if objectPath == "" || objectPath == "/" {
		return "", ""
	}
	start := 0
	if objectPath[0] == '/' {
		start = 1
	}
	sep := strings.IndexByte(objectPath[start:], '/')
	if sep < 0 {
		return objectPath[start:], ""
	}
	return objectPath[start : sep+start], objectPath[sep+start+1:]
}
