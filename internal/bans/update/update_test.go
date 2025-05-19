package update

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestPrivateSubnet(t *testing.T) {
	err := validateIps([]string{"12.3.4.5", "10.0.0.0", "1.2.3.1"})
	assert.NoError(t, err)
}

func TestIPv6(t *testing.T) {
	err := validateIps([]string{"2001:db8:abcd:0012::0", "::0"})
	assert.NoError(t, err)
}

func TestInvalidAddress(t *testing.T) {
	err := validateIps([]string{"12.3.4"})
	assert.ErrorContains(t, err, "invalid IP address: 12.3.4")
}
