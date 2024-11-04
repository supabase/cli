package cast

import (
	"math"
	"strings"
)

// UintToInt converts a uint to an int, handling potential overflow
func UintToInt(value uint) int {
	if value <= math.MaxInt {
		result := int(value)
		return result
	}
	maxInt := math.MaxInt
	return maxInt
}

// IntToUint converts an int to a uint, handling negative values
func IntToUint(value int) uint {
	if value < 0 {
		return 0
	}
	return uint(value)
}

func UintToIntPtr(value *uint) *int {
	if value == nil {
		return nil
	}
	return Ptr(UintToInt(*value))
}

func IntToUintPtr(value *int) *uint {
	if value == nil {
		return nil
	}
	return Ptr(IntToUint(*value))
}

func Ptr[T any](v T) *T {
	return &v
}

func Val[T any](v *T, def T) T {
	if v == nil {
		return def
	}
	return *v
}

func StrToArr(v string) []string {
	// Avoid returning [""] if v is empty
	if len(v) == 0 {
		return nil
	}
	return strings.Split(v, ",")
}
