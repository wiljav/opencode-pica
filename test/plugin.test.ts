import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import { OpenCodeImagePlugin } from "../src/index.js"
import { describeModel, inheritProvider } from "../src/inherit.js"
import { isNewer } from "../src/update.js"
import { defaultImageDir, resolveOptions, resolveOutDir } from "../src/options.js"
import { execFileSync } from "node:child_process"

const realFetch = globalThis.fetch
const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-pica-test-"))

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

let payload: Buffer
let usagePayload: Record<string, unknown> | undefined
let failStatus: number | undefined

beforeAll(() => {
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url
    if (failStatus !== undefined && (url.includes("/images/generations") || url.includes("/images/edits"))) {
      return new Response(JSON.stringify({ error: { message: "stub failure", code: failStatus } }), {
        status: failStatus,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.includes("/images/generations") || url.includes("/images/edits")) {
      const body: any = { data: [{ b64_json: payload.toString("base64") }] }
      if (usagePayload) body.usage = usagePayload
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return realFetch(input, init)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
})

let instanceSeed = 0

/** Minimal stand-in for the v2 plugin setup context (tool + session + location + options). */
async function setup(extra: Record<string, unknown> = {}) {
  const seed = instanceSeed++
  const directory = path.join(root, "project", `p${seed}`)
  const tools = new Map<string, any>()
  const systemHooks: Array<(event: any) => void> = []
  const cleanups: Array<() => unknown> = []

  const ctx = {
    location: { directory },
    options: {
      apiKey: "test-key",
      baseURL: "http://127.0.0.1:1/v1",
      model: "test-image-model",
      maxSize: 1024,
      // Explicit outDir keeps writes out of the real global directories
      updateCheck: false,
      outDir: path.join(root, "images", `g${seed}`),
      ...extra,
    },
    tool: {
      transform: async (fn: (editor: any) => void) => {
        fn({
          add: (tool: any) => tools.set(tool.name, tool),
          list: () => [...tools.values()],
          get: (name: string) => tools.get(name),
          remove: (name: string) => tools.delete(name),
        })
      },
    },
    session: {
      hook: async (name: string, fn: (event: any) => void) => {
        if (name === "context") systemHooks.push(fn)
      },
    },
  }

  const cleanup = await OpenCodeImagePlugin.setup(ctx as any)
  if (typeof cleanup === "function") cleanups.push(cleanup)

  return { tools, systemHooks, directory, cleanup: () => Promise.all(cleanups.map((fn) => fn())) }
}

function toolContext() {
  return {
    sessionID: "s",
    messageID: "m",
    agent: "test",
    id: "call",
    signal: new AbortController().signal,
    progress: async () => {},
  } as any
}

/** Tool result text (v2 returns content as a string or a Content[] list). */
function text(res: any) {
  return typeof res.content === "string" ? res.content : res.content.find((item: any) => item.type === "text").text
}

function attachment(res: any) {
  return typeof res.content === "string" ? undefined : res.content.find((item: any) => item.type === "resource")
}

function png(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .png()
    .toBuffer()
}

describe("image_generate", () => {
  test("saves the image and renders it via a resource content block", async () => {
    payload = await png(900, 900)
    usagePayload = undefined
    failStatus = undefined
    const { tools, cleanup } = await setup()
    try {
      const res = await tools.get("image_generate").execute({ prompt: "a red square" }, toolContext())
      const output = text(res)
      expect(output).toContain("rendered automatically")
      expect(output).toContain("exactly one image per request")
      // Standard markdown image line (CSP-safe data URI for clients that render it)
      expect(output).toContain("![image](data:image/jpeg;base64,")
      // Resource content block with the same data URI for reliable rendering
      const resource = attachment(res)
      expect(resource).toBeDefined()
      expect(resource.resource.mimeType).toBe("image/jpeg")
      expect(resource.resource.uri).toMatch(/^data:image\/jpeg;base64,/)
      // Display is a CSP-compatible data URI; fixed alt text "image"
      const dataUri = /!\[image\]\((data:image\/jpeg;base64,[A-Za-z0-9+/=]+)\)/.exec(output)!
      expect(dataUri).toBeDefined()
      // Whole tool text must survive truncation: under 50 KiB (MAX_BYTES in tool-output.ts)
      expect(Buffer.byteLength(output, "utf8")).toBeLessThan(50 * 1024)
      // The downscaled JPEG renders inside the CSP allowlist
      const inline = await sharp(Buffer.from(dataUri[1]!.replace("data:image/jpeg;base64,", ""), "base64")).metadata()
      expect(inline.format).toBe("jpeg")
    } finally {
      await cleanup()
    }
  })

  test("keeps the display copy under the 50 KiB budget even for a noisy full-size image", async () => {
    payload = await sharp({
      create: {
        width: 3000,
        height: 3000,
        channels: 3,
        noise: { type: "gaussian", mean: 128, sigma: 40 },
      },
    })
      .png()
      .toBuffer()
    failStatus = undefined
    const { tools, cleanup } = await setup()
    try {
      const res = await tools.get("image_generate").execute({ prompt: "noise stress" }, toolContext())
      const output = text(res)
      expect(Buffer.byteLength(output, "utf8")).toBeLessThan(50 * 1024)
      expect(output).toContain("![image](data:image/jpeg;base64,")
    } finally {
      await cleanup()
    }
  })

  test("appends model/cost tracking from usage metadata", async () => {
    payload = await png(300, 300)
    usagePayload = { cost: 0.0137 }
    const { tools, cleanup } = await setup()
    try {
      const res = await tools.get("image_generate").execute({ prompt: "tracked" }, toolContext())
      const output = text(res)
      expect(output).toContain("[Relay to user] Model/cost report:")
      expect(output).toContain("**Model:** test-image-model")
      expect(output).toContain("**Cost:** $0.0137")
      // The prompt appears in the output text verbatim (not in the markdown alt text)
      expect(output).toContain('"tracked"')
    } finally {
      usagePayload = undefined
      await cleanup()
    }
  })

  test("reports a 401 as a credentials problem, not an unsupported-model error", async () => {
    payload = await png(300, 300)
    failStatus = 401
    const { tools, cleanup } = await setup()
    try {
      await expect(
        tools.get("image_generate").execute({ prompt: "failing" }, toolContext()),
      ).rejects.toThrow(/401 \(authentication failed\).*plugin options or PI_IMAGE_API_KEY/s)
    } finally {
      failStatus = undefined
      await cleanup()
    }
  })

  for (const [status, fragment] of [
    [402, "insufficient credits"],
    [429, "rate limited"],
  ] as Array<[number, string]>) {
    test(`reports ${status} directly with the model attempted`, async () => {
      payload = await png(300, 300)
      failStatus = status
      const { tools, cleanup } = await setup()
      try {
        await expect(
          tools.get("image_generate").execute({ prompt: "failing" }, toolContext()),
        ).rejects.toThrow(new RegExp(`${status} \\(${fragment}\\) for model test-image-model`))
      } finally {
        failStatus = undefined
        await cleanup()
      }
    })
  }

  test("keeps the unsupported-model template for a 404", async () => {
    payload = await png(300, 300)
    failStatus = 404
    const { tools, cleanup } = await setup()
    try {
      await expect(
        tools.get("image_generate").execute({ prompt: "failing" }, toolContext()),
      ).rejects.toThrow(/Image generation failed\. The currently active OpenCode provider\/model \(test-image-model\)/)
      await expect(
        tools.get("image_generate").execute({ prompt: "failing again" }, toolContext()),
      ).rejects.toThrow("404")
    } finally {
      failStatus = undefined
      await cleanup()
    }
  })

  test("respects an explicit filename", async () => {
    payload = await png(600, 600)
    const { tools, directory, cleanup } = await setup()
    try {
      const target = path.join(directory, "custom.png")
      await tools.get("image_generate").execute({ prompt: "named", filename: target }, toolContext())

      expect(fs.existsSync(target)).toBe(true)
      expect(fs.existsSync(`${target}.download`)).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test("confines relative filenames with traversal to outDir", async () => {
    payload = await png(200, 200)
    const { tools, cleanup } = await setup()
    try {
      const res = await tools.get("image_generate").execute(
        { prompt: "escape", filename: "../escaped.png" },
        toolContext(),
      )
      const saved = res.metadata.file as string
      const imagesRoot = path.join(root, "images")
      // The `..` segment is neutralized: the file lands inside the setup's outDir subtree
      expect(saved.startsWith(imagesRoot + path.sep)).toBe(true)
      expect(path.basename(saved)).toBe("escaped.png")
    } finally {
      await cleanup()
    }
  })
})

describe("image_edit", () => {
  test("normalizes a jpeg source to a png result", async () => {
    payload = await png(800, 800)
    const { tools, directory, cleanup } = await setup()
    try {
      fs.mkdirSync(directory, { recursive: true })
      const source = path.join(directory, "source.jpg")
      fs.writeFileSync(
        source,
        await sharp({ create: { width: 300, height: 300, channels: 3, background: "#0af" } }).jpeg().toBuffer(),
      )

      const res = await tools.get("image_edit").execute(
        { image: source, prompt: "make it blue", filename: path.join(directory, "edited.png") },
        toolContext(),
      )

      const out = path.join(directory, "edited.png")
      const bytes = fs.readFileSync(out)
      expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
      expect(await sharp(out).metadata()).toMatchObject({ format: "png", width: 800 })
      expect(text(res)).toContain("Image edited")
    } finally {
      await cleanup()
    }
  })

  test("rejects a missing source", async () => {
    const { tools, cleanup } = await setup()
    try {
      await expect(
        tools.get("image_edit").execute({ image: "/nope/missing.png", prompt: "x" }, toolContext()),
      ).rejects.toThrow("source image not found")
    } finally {
      await cleanup()
    }
  })
})

describe("provider inheritance", () => {
  test("inherits model and baseURL from the opencode context", async () => {
    const ctx = {
      model: {
        default: async () => ({
          data: { providerID: "ollama", modelID: "healthy-image-model", settings: {} },
        }),
      },
      provider: {
        get: async (input: any) => ({
          data: { id: input.providerID, settings: { baseURL: "http://localhost:11434/v1" } },
        }),
      },
    }
    const inherited = await inheritProvider(ctx)
    expect(inherited.model).toBe("healthy-image-model")
    expect(inherited.baseURL).toBe("http://localhost:11434/v1")

    // Plugin option wins over inherited values
    const resolved = resolveOptions({ baseURL: "http://configured/v1", model: "configured-model" })
    expect(resolved.model).toBe("configured-model")
    expect(resolved.baseURL).toBe("http://configured/v1")
  })

  test("degrades gracefully when the host exposes no provider domain", async () => {
    const inherited = await inheritProvider({})
    expect(inherited.model).toBeUndefined()
    expect(inherited.baseURL).toBeUndefined()
  })

  test("describeModel shows provider/model, keeping vendor-prefixed IDs verbatim", () => {
    expect(describeModel({ providerID: "openrouter", model: "gemini-2.5-flash-image" })).toBe(
      "openrouter/gemini-2.5-flash-image",
    )
    expect(describeModel({ providerID: "openrouter", model: "openai/gpt-6.1-terra" })).toBe("openai/gpt-6.1-terra")
    expect(describeModel({ model: "gpt-image-1" })).toBe("gpt-image-1")
    expect(describeModel({})).toBe("unknown")
  })

  test("setup fails the generate call with an actionable message when nothing is configured", async () => {
    const captured = new Map<string, any>()
    const ctx = {
      location: { directory: root },
      options: { updateCheck: false, outDir: path.join(root, "no-config-images") },
      tool: {
        transform: async (fn: (editor: any) => void) => {
          fn({
            add: (t: any) => captured.set(t.name, t),
            list: () => [...captured.values()],
            get: (n: string) => captured.get(n),
            remove: (n: string) => captured.delete(n),
          })
        },
      },
      session: { hook: async () => {} },
    }
    await OpenCodeImagePlugin.setup(ctx as any)
    await expect(
      captured.get("image_generate")!.execute({ prompt: "x" }, toolContext()),
    ).rejects.toThrow(/no image model is configured/)
  })
})

describe("update check", () => {
  test("compares versions", () => {
    expect(isNewer("0.1.2", "0.1.1")).toBe(true)
    expect(isNewer("0.1.1", "0.1.1")).toBe(false)
    expect(isNewer("0.0.9", "0.1.0")).toBe(false)
    expect(isNewer("1.0.0", "0.9.9")).toBe(true)
    expect(isNewer("1.0.0", "1.0.0-beta")).toBe(true)
    expect(isNewer("1.0.0-beta", "1.0.0")).toBe(false)
  })

  test("--update removes only this package's cache dirs", () => {
    const cache = fs.mkdtempSync(path.join(root, "cli-cache-"))
    for (const name of ["opencode-pica", "opencode-pica@latest", "opencode-pica@0.1.0", "other-plugin"]) {
      fs.mkdirSync(path.join(cache, name), { recursive: true })
    }

    const cli = fileURLToPath(new URL("../bin/cli.js", import.meta.url))
    const out = execFileSync(process.execPath, [cli, "--update"], {
      env: { ...process.env, OPENCODE_IMAGE_PLUGIN_CACHE: cache },
      encoding: "utf8",
    })

    expect(out).toContain("Cleared 3 cache directories")
    expect(fs.existsSync(path.join(cache, "opencode-pica"))).toBe(false)
    expect(fs.existsSync(path.join(cache, "opencode-pica@latest"))).toBe(false)
    expect(fs.existsSync(path.join(cache, "opencode-pica@0.1.0"))).toBe(false)
    expect(fs.existsSync(path.join(cache, "other-plugin"))).toBe(true)
  })
})

describe("output directory", () => {
  test("defaults to the opencode data dir, not the project", () => {
    expect(defaultImageDir({}, "/home/u")).toBe("/home/u/.local/share/opencode/opencode-pica")
    expect(defaultImageDir({ XDG_DATA_HOME: "/xdg" }, "/home/u")).toBe("/xdg/opencode/opencode-pica")
  })

  test("resolves relative outDir against the project and keeps absolute paths", () => {
    expect(resolveOutDir("/proj", undefined)).toBe(defaultImageDir())
    expect(resolveOutDir("/proj", ".opencode-picas")).toBe(path.join("/proj", ".opencode-picas"))
    expect(resolveOutDir("/proj", "/abs/dir")).toBe("/abs/dir")
  })
})

describe("system prompt rule", () => {
  test("injects the tool guidance by default", async () => {
    const { systemHooks, cleanup } = await setup()
    try {
      expect(systemHooks.length).toBe(1)
      const event = { system: [] as Array<{ type: "text"; text: string }> }
      systemHooks[0]!(event)
      const rule = event.system.map((part) => part.text).join("\n")
      expect(rule).toContain("image_generate")
      expect(rule).toContain("exactly ONE")
      expect(rule).toContain("Never produce")
      expect(rule).toContain("multiple variants")
    } finally {
      await cleanup()
    }
  })

  test("can be turned off", async () => {
    const { systemHooks, cleanup } = await setup({ injectPrompt: false })
    try {
      expect(systemHooks.length).toBe(0)
    } finally {
      await cleanup()
    }
  })
})