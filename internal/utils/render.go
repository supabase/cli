package utils

import "time"

func FormatTimestamp(timestamp string) string {
	if t, err := time.Parse(time.RFC3339, timestamp); err == nil {
		return t.UTC().Format("2006-01-02 15:04:05")
	}
	return timestamp
}
