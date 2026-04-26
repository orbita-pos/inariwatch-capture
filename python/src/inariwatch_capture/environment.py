"""Environment context — captured at error time.

Mirrors ``capture/src/environment.ts`` field-for-field so payloads are
uniform across SDKs even when the backend treats the ``env`` block as a
single JSON blob. Field name: ``node``. For Python we store the
interpreter version in that field so the consumer can key off a single
name regardless of runtime.
"""

from __future__ import annotations

import os
import platform
import sys
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .types import EnvironmentContext


_PROCESS_START = time.monotonic()


def _memory_totals() -> tuple[int, int]:
    """Return (total_memory_mb, free_memory_mb).

    Tries ``os.sysconf`` (POSIX), then Windows kernel32 via ctypes, then
    a graceful (0, 0) if neither works. ``psutil`` is NOT a runtime
    dependency — we keep the core zero-deps.
    """
    # POSIX via sysconf
    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        phys_pages = os.sysconf("SC_PHYS_PAGES")
        avail_pages = os.sysconf("SC_AVPHYS_PAGES")
        total_mb = (phys_pages * page_size) // (1024 * 1024)
        free_mb = (avail_pages * page_size) // (1024 * 1024)
        return int(total_mb), int(free_mb)
    except (AttributeError, ValueError, OSError):
        pass

    # Windows via kernel32
    if sys.platform == "win32":
        try:
            import ctypes

            class _MemStatus(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            status = _MemStatus()
            status.dwLength = ctypes.sizeof(_MemStatus)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
            total_mb = int(status.ullTotalPhys // (1024 * 1024))
            free_mb = int(status.ullAvailPhys // (1024 * 1024))
            return total_mb, free_mb
        except Exception:
            pass

    return 0, 0


def _python_rss_mb() -> tuple[int, int]:
    """Return (rss_mb, heap_total_mb) for the current process.

    Python has no first-class "heap" separate from RSS, so we report the
    same number for both to stay wire-compatible with the Node shape.
    """
    # POSIX: use resource.getrusage
    try:
        import resource

        usage = resource.getrusage(resource.RUSAGE_SELF)
        # On Linux ru_maxrss is KB, on macOS it's bytes. Heuristic:
        # values above 10^9 are bytes, otherwise KB. Both convert to MB.
        maxrss = usage.ru_maxrss
        if maxrss > 10**9:
            rss_mb = int(maxrss // (1024 * 1024))
        else:
            rss_mb = int(maxrss // 1024)
        return rss_mb, rss_mb
    except (ImportError, AttributeError):
        pass

    # Windows via psapi
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            class _ProcessMemoryCounters(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            counters = _ProcessMemoryCounters()
            counters.cb = ctypes.sizeof(_ProcessMemoryCounters)
            handle = ctypes.windll.kernel32.GetCurrentProcess()
            ctypes.windll.psapi.GetProcessMemoryInfo(
                handle, ctypes.byref(counters), counters.cb
            )
            rss_mb = int(counters.WorkingSetSize // (1024 * 1024))
            return rss_mb, rss_mb
        except Exception:
            pass

    return 0, 0


def get_environment_context() -> EnvironmentContext | None:
    """Return runtime facts about the current process.

    Returns ``None`` in contexts where introspection would be unsafe or
    unhelpful (e.g. stubbed-out platform modules in a sandbox).
    """
    try:
        total_mb, free_mb = _memory_totals()
        rss_mb, heap_total_mb = _python_rss_mb()

        return {
            "node": platform.python_version(),  # field reused for Python version
            "platform": sys.platform,
            "arch": platform.machine() or "unknown",
            "cpuCount": os.cpu_count() or 0,
            "totalMemoryMB": total_mb,
            "freeMemoryMB": free_mb,
            "heapUsedMB": rss_mb,
            "heapTotalMB": heap_total_mb,
            "uptime": int(time.monotonic() - _PROCESS_START),
        }
    except Exception:
        return None


__all__ = ["get_environment_context"]
