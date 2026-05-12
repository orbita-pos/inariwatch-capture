import { captureLog } from "../client.js"

export async function checkStorageQuota(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return

  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    if (quota === 0) return

    const pct = usage / quota
    if (pct < 0.8) return

    const usageMb = Math.round(usage / 1024 / 1024)
    const quotaMb = Math.round(quota / 1024 / 1024)
    const percentFull = Math.round(pct * 100)

    captureLog(
      `storage_quota: ${percentFull}% full (${usageMb}MB / ${quotaMb}MB)`,
      pct >= 0.95 ? "error" : "warn",
      {
        kind: "storage_quota",
        usageMb,
        quotaMb,
        percentFull,
        rating: pct >= 0.95 ? "critical" : "warning",
        url: location.href,
      },
    )
  } catch {
    // storage.estimate() can throw in private browsing mode or when quota API is unavailable
  }
}
