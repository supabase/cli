package utils

func RemoveDuplicates[T comparable](slice []T) (result []T) {
	set := make(map[T]struct{})
	for _, item := range slice {
		if _, exists := set[item]; !exists {
			set[item] = struct{}{}
			result = append(result, item)
		}
	}
	return result
}
