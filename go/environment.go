// Runtime environment introspection — os + runtime stdlib only.
package capture

import (
	"runtime"
	"time"
)

var processStart = time.Now()

// GetEnvironmentContext mirrors the Node SDK's EnvironmentContext
// shape. ``Node`` stores the Go runtime version. Memory totals come
// from runtime.MemStats (HeapInuse + Sys) since Go doesn't expose
// a cheap "total physical memory" call from stdlib.
func GetEnvironmentContext() *EnvironmentContext {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return &EnvironmentContext{
		Node:          runtime.Version(),
		Platform:      runtime.GOOS,
		Arch:          runtime.GOARCH,
		CPUCount:      runtime.NumCPU(),
		TotalMemoryMB: int(m.Sys / (1024 * 1024)),
		FreeMemoryMB:  int((m.HeapIdle) / (1024 * 1024)),
		HeapUsedMB:    int(m.HeapInuse / (1024 * 1024)),
		HeapTotalMB:   int(m.HeapAlloc / (1024 * 1024)),
		Uptime:        int(time.Since(processStart).Seconds()),
	}
}
