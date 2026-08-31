/** Display ViewerOne version — v6+ uses zero-padded minor.patch (6.0.0 → 6.00.00). */
export function formatViewerOneVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!m) return version
  const major = Number(m[1])
  if (major >= 6) {
    return `${major}.${m[2].padStart(2, '0')}.${m[3].padStart(2, '0')}`
  }
  return version
}
