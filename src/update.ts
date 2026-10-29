import * as fs from "node:fs"

export const REGISTRY = "https://registry.npmjs.org"
export const PACKAGE = "opencode-pica"

function parse(version: string) {
  const [core, pre = ""] = version.split("-", 2)
  const nums = core.split(".").map((part) => Number.parseInt(part, 10))
  return { nums: [nums[0] || 0, nums[1] || 0, nums[2] || 0], pre }
}

/** Compares only x.y.z + prerelease identifiers; sufficient and dependency-free */
export function isNewer(candidate: string, current: string) {
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i]
  }
  if (a.pre === b.pre) return false
  if (!a.pre) return true // 1.0.0 > 1.0.0-beta
  if (!b.pre) return false
  return a.pre > b.pre
}

/** Read the version from the package's own package.json; resolves from both dist/index.js and src/index.ts */
export function readOwnVersion(): string | undefined {
  try {
    const file = new URL("../package.json", import.meta.url)
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string }
    return pkg.version
  } catch {
    return undefined
  }
}

export function upgradeHint(latest: string, current: string) {
  return `[Relay to user] ${PACKAGE} has a new version ${latest} (current ${current}). To upgrade: run npx ${PACKAGE} --update, then restart opencode.`
}

/** Check npm for the latest version; return a hint line when outdated, undefined otherwise. Any failure counts as "not found". */
export async function checkForUpdate(current: string, timeoutMs = 3000): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${REGISTRY}/${PACKAGE}/latest`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as { version?: string }
    if (!body.version || !isNewer(body.version, current)) return undefined
    return upgradeHint(body.version, current)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
