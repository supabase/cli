package utils

import (
	"fmt"
	"time"
)

const (
	layoutVersion = "20060102150405"
	layoutHuman   = "2006-01-02 15:04:05"
)

func FormatTime(t time.Time) string {
	return t.UTC().Format(layoutHuman)
}

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
	return FormatTime(t)
}

var regionMap = map[string]string{
	"ap-east-1":      "East Asia (Hong Kong)",
	"ap-northeast-1": "Northeast Asia (Tokyo)",
	"ap-northeast-2": "Northeast Asia (Seoul)",
	"ap-south-1":     "South Asia (Mumbai)",
	"ap-southeast-1": "Southeast Asia (Singapore)",
	"ap-southeast-2": "Oceania (Sydney)",
	"ca-central-1":   "Canada (Central)",
	"eu-central-1":   "Central EU (Frankfurt)",
	"eu-central-2":   "Central Europe (Zurich)",
	"eu-north-1":     "North EU (Stockholm)",
	"eu-west-1":      "West EU (Ireland)",
	"eu-west-2":      "West Europe (London)",
	"eu-west-3":      "West EU (Paris)",
	"sa-east-1":      "South America (São Paulo)",
	"us-east-1":      "East US (North Virginia)",
	"us-east-2":      "East US (Ohio)",
	"us-west-1":      "West US (North California)",
	"us-west-2":      "West US (Oregon)",
}

func FormatRegion(region string) string {
	if readable, ok := regionMap[region]; ok {
		return readable
	}
	return region
}
