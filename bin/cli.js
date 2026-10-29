#!/usr/bin/env node
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const PACKAGE = "opencode-pica"

const args = process.argv.slice(2)

const version = (() => {
  try {
    const file = new URL("../package.json", import.meta.url)
    return JSON.parse(fs.readFileSync(file, "utf8")).version ?? "unknown"
  } catch {
    return "unknown"
  }
})()

const USAGE = `${PACKAGE} v${version}

Usage:
  npx ${PACKAGE} --update              Clear opencode's plugin cache, then restart opencode to install the latest version
  npx ${PACKAGE} --version             Show version
  npx ${PACKAGE} --help                Show help

Why --update is needed:
  opencode does not version-check npm-based plugins — once a package is in its cache directory it is reused as-is.
  So after publishing a new version the cache must be cleared before opencode re-downloads. See the "Upgrading" section in the README.
`

function flag(name) {
  const index = args.indexOf(name)
  return index >= 0 ? (args[index + 1] ?? "") : undefined
}

/** opencode's plugin cache lives at <cache>/packages/<spec>; spec is either opencode-pica or opencode-pica@latest */
function pluginCacheRoot() {
  return process.env.OPENCODE_IMAGE_PLUGIN_CACHE ?? path.join(os.homedir(), ".cache", "opencode", "packages")
}

function update() {
  const root = pluginCacheRoot()
  if (!fs.existsSync(root)) {
    console.log(`Cache directory does not exist, nothing to clear: ${root}`)
    console.log("Just restart opencode.")
    return
  }

  const targets = fs
    .readdirSync(root)
    .filter((entry) => entry === PACKAGE || entry.startsWith(`${PACKAGE}@`))
    .map((entry) => path.join(root, entry))

  if (targets.length === 0) {
    console.log(`No cache for ${PACKAGE} found, nothing to clear.`)
    console.log("Just restart opencode.")
    return
  }

  for (const target of targets) {
    fs.rmSync(target, { recursive: true, force: true })
    console.log(`Removed ${target}`)
  }
  console.log("")
  console.log(`✅ Cleared ${targets.length} cache directories; restarting opencode will re-download the latest version.`)
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE)
  process.exit(0)
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(version)
  process.exit(0)
}

if (args.includes("--update")) {
  update()
  process.exit(0)
}

console.log(USAGE)
process.exit(1)
