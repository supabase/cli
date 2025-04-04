package config

import (
	"strings"
	"testing"

	"github.com/go-viper/mapstructure/v2"
	"github.com/stretchr/testify/assert"
)

func TestParseImage(t *testing.T) {
	output := map[string]string{}
	err := mapstructure.Decode(Images, &output)
	assert.NoError(t, err)
	assert.Len(t, output, strings.Count(dockerImage, "FROM"))
	for _, v := range output {
		assert.NotEmpty(t, v)
	}
}
