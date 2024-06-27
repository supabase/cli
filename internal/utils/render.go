package utils

import (
	"fmt"
	"time"
)

const (
	layoutVersion = "20060102150405"
	layoutHuman   = "2006-01-02 15:04:05"
)

func FormatTimestamp(timestamp string) string {
	return parse(time.RFC3339, timestamp)
}

func FormatTimestampVersion(timestamp string) string {
	return parse(layoutVersion, timestamp)
}

func parse(layout, value string) string {
	t, err := time.Parse(layout, value)
	if err != nil {
		fmt.Fprintln(GetDebugLogger(), err)
		return value
	}
	return t.UTC().Format(layoutHuman)
}
