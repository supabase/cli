package cast

import "math"

// UintToInt converts a uint to an int, handling potential overflow
func UintToInt(value uint) int {
	if value <= math.MaxInt {
		return int(value)
	}
	return math.MaxInt
}

// UIntToUInt16 converts a uint to an uint16, handling potential overflow
func UIntToUInt16(value uint) uint16 {
	if value <= math.MaxUint16 {
		return uint16(value)
	}
	return math.MaxUint16
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
