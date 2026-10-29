import { Schema } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { ProviderHttpError, editImage, fetchImageBytes, generateImage, withTimeout } from "./api.js"
import { displayDataUri, imageDimensions, persistImage, toPngBuffer } from "./image.js"
import { describeModel, inheritProvider, type InheritedConfig } from "./inherit.js"
import { resolveOptions, resolveOutDir, type PluginOptions, type ResolvedOptions } from "./options.js"
import { checkForUpdate, readOwnVersion } from "./update.js"

const PLUGIN_ID = "opencode-pica"
console.log("[opencode-pica] Module loaded, exporting plugin definition...")

const GENERATE_DESCRIPTION =
  "Generate an image from a text prompt. This is the only supported way to create images in this session: " +
  "the endpoint and API key are already configured inside this plugin, so NEVER call the image API yourself " +
  "(no curl, no scripts) and never read the API key out of opencode.json. " +
  "The result includes a resource block the UI renders automatically; you do NOT need to copy any data URI. " +
  "Relay any line starting with [Relay to user] to the user. " +
  "To refine a result, call image_edit with the returned path instead of generating a new image. " +
  "Generate exactly ONE image per request — do not produce multiple variants unless the user asks for them. " +
  "Only call this when the user explicitly asked for an image — never on your own initiative."

const EDIT_DESCRIPTION =
  "Edit an existing image with a text instruction (image-to-image). Prefer this over generating a new image " +
  "when the user wants to adjust a picture: pass the exact path returned by a previous image_generate or " +
  "image_edit call to keep refining the same one. " +
  "Same rules: never call the image API yourself and never read the API key; the result renders automatically. " +
  "Relay any line starting with [Relay to user] to the user. " +
  "Only call this when the user explicitly asked for an image change — never on your own initiative."

const SYSTEM_RULE =
  "Image generation/editing: always use the `image_generate` / `image_edit` tools provided by the " +
  "opencode-pica plugin — the endpoint and API key are already configured there. Never call the image API " +
  "directly, never read the API key from config, and do not use the imagegen skill or its CLI. " +
  "The tool result renders the image automatically; you do NOT need to embed any data URIs or URLs. " +
  "Generate exactly ONE image per user request. Do not produce multiple variants, styles, or options " +
  "unless the user explicitly asks for more than one. Never produce bonus, preview, example, or comparison " +
  "images on your own initiative, and never re-generate an image without a new request — if it is unclear " +
  "whether an image is wanted, ask first."

const GENERATE_INPUT_CONFIG_HINT =
  "opencode-pica: no image model is configured. Set 'model' and, for remote providers, 'baseURL' (and " +
  "'apiKey' or PI_IMAGE_API_KEY) in the opencode.jsonc plugin options. Local providers (Ollama, LM Studio) " +
  "only need an inherited or explicit baseURL."

const GENERATE_ERROR_TEMPLATE = (model: string, detail: string) =>
  "Image generation failed. The currently active OpenCode provider/model (" +
  `${model}) does not support image generation. Please configure a dedicated image-generation model and ` +
  `baseURL in your opencode.jsonc plugin options (e.g., 'model': '<provider>/<image-model>').\n(${detail})`

/**
 * Format a failed provider request. Status classes the provider uses for account/key state
 * get direct, actionable messages; anything else most plausibly means the endpoint or model
 * does not implement image generation at all (the generic template).
 */
function requestFailure(
  error: unknown,
  endpoint: string,
  baseURL: string,
  model: string,
): Error {
  const detail = String(error).slice(0, 400)
  if (error instanceof ProviderHttpError) {
    if (error.status === 401) {
      return new Error(
        `Image request failed: ${endpoint} at ${baseURL} returned 401 (authentication failed). ` +
          `The plugin cannot inherit the provider's API credentials, and model ${model} was requested key-less. ` +
          `Set 'apiKey' in the opencode.jsonc plugin options or PI_IMAGE_API_KEY in the environment.` +
          `\n(${error.body.slice(0, 300)})`,
      )
    }
    if (error.status === 402) {
      return new Error(
        `Image request failed: ${endpoint} at ${baseURL} returned 402 (insufficient credits) ` +
          `for model ${model}.\n(${error.body.slice(0, 300)})`,
      )
    }
    if (error.status === 429) {
      return new Error(
        `Image request failed: ${endpoint} at ${baseURL} returned 429 (rate limited) ` +
          `for model ${model}.\n(${error.body.slice(0, 300)})`,
      )
    }
  }
  // Unknown statuses and network errors: keep the generic unsupported-model template.
  return new Error(GENERATE_ERROR_TEMPLATE(model, detail))
}

/**
 * Strip surrounding quotes, backslashes, and control characters from user-supplied
 * values before using them in filenames or markdown. The model sometimes wraps
 * tool-argument strings in literal quote characters, which would otherwise produce
 * mangled filenames and malformed markdown image lines.
 */
function sanitize(str: string): string {
  return str.replace(/^["']+|["']+$/g, "").replace(/[\\\x00-\x1f\x7f]/g, "").trim()
}

const GenerateInput = Schema.Struct({
  prompt: Schema.String,
  filename: Schema.optional(Schema.String),
})

const EditInput = Schema.Struct({
  image: Schema.String,
  prompt: Schema.String,
  filename: Schema.optional(Schema.String),
})

/**
 * Inline display budget in characters. opencode truncates the whole tool text at 50 KiB
 * (tool-output.ts); the data URI line plus the other output lines must stay under it.
 */
const DISPLAY_BUDGET_CHARS = 45_000

function resolveDestination(filename: string | undefined, options: ResolvedOptions, directory: string) {
  const dir = resolveOutDir(directory, options.outDir)

  if (filename) {
    let target: string
    if (path.isAbsolute(filename)) {
      // Absolute paths are an explicit user decision and are honored.
      target = filename
    } else {
      // Relative input: resolve strictly inside the output directory. A path that would
      // escape outDir via `..` falls back to its bare name inside outDir (no traversal).
      target = path.resolve(dir, filename)
      if (target !== dir && !target.startsWith(dir + path.sep)) {
        target = path.join(dir, path.basename(filename))
      }
    }
    return `${target.replace(/\.[A-Za-z0-9]+$/, "")}.png`
  }
  const stamp = new Date().toISOString().replace(/\..+$/, "").replace(/[:T]/g, "-")
  const suffix = Math.random().toString(36).slice(2, 6)
  return path.join(dir, `image-${stamp}-${suffix}.png`)
}

/** A resource block for the tool result — the web UI renders image resources inline */
async function previewAttachment(file: string): Promise<Attachment> {
  try {
    const uri = await displayDataUri(file, DISPLAY_BUDGET_CHARS)
    return { type: "resource" as const, resource: { uri, mimeType: "image/jpeg" } }
  } catch {
    return { type: "resource" as const, resource: { uri: `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`, mimeType: "image/png" } }
  }
}

type Attachment = { type: "resource"; resource: { uri: string; mimeType: string } }

/** Extract model/cost tracking info from the API usage payload (OpenRouter uses `cost`, others `total_cost`). */
function usageTrack(model: string, usage: unknown) {
  const record = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : undefined
  const rawCost = record?.cost ?? record?.total_cost
  const costText =
    typeof rawCost !== "number" || !Number.isFinite(rawCost)
      ? "unavailable"
      : "$" + rawCost.toFixed(rawCost < 0.1 ? 4 : 2)
  return `> **Model:** ${model} | **Cost:** ${costText}`
}

export const OpenCodeImagePlugin = {
  id: PLUGIN_ID,
  setup: async (ctx: any) => {
    const rawOptions = resolveOptions(ctx.options as PluginOptions | undefined)
    // Precedence: plugin option > PI_IMAGE_BASE_URL env (already merged in resolveOptions) > inherited provider.
    const inherited: InheritedConfig = await inheritProvider(ctx)
    const options: ResolvedOptions = {
      ...rawOptions,
      baseURL: rawOptions.baseURL ?? inherited.baseURL,
      model: rawOptions.model ?? inherited.model,
    }
    // Full display identity (provider/model) for failures and the cost report. When the
    // model came from inheritance and IDs like OpenRouter's already embed a vendor prefix,
    // describeModel keeps them verbatim.
    const modelIdentity = options.model
      ? describeModel({
          providerID: options.model === inherited.model ? inherited.providerID : undefined,
          model: options.model,
        })
      : "unknown"
    const directory = ctx.location.directory

    // Check npm for the latest version when the first image is generated; cached in-process, checked at most once
    const selfVersion = readOwnVersion()
    let updateHint: string | undefined
    let updateChecked = false
    const upgradeNotice = async () => {
      if (!options.updateCheck || updateChecked || !selfVersion) return updateHint
      updateChecked = true
      updateHint = await checkForUpdate(selfVersion)
      return updateHint
    }

    /** Throw a configuration-specific message instead of a generic network error. */
    const requireProviderConfig = () => {
      if (!options.baseURL || !options.model) {
        throw new Error(GENERATE_INPUT_CONFIG_HINT)
      }
      return { baseURL: options.baseURL, apiKey: options.apiKey, model: options.model, timeoutMs: options.timeoutMs }
    }

    /**
     * Assemble the tool return value.
     * The tool result includes a resource content block (data URI JPEG) that the web UI
     * renders inline. The text block also includes a Markdown `![image](data:...)` line
     * for clients that support it; the resource block is the reliable rendering path.
     * The full-resolution PNG stays on disk for image_edit refinement.
     */
    const render = async (label: string, prompt: string, file: string, progress: (m: string) => void, usage: unknown) => {
      const { width, height } = await imageDimensions(file)
      let display: string
      try {
        const dataUri = await displayDataUri(file, DISPLAY_BUDGET_CHARS)
        display = `![image](${dataUri})`
      } catch (error) {
        display = `[opencode-pica: cannot read generated image, cannot render inline: ${String(error)}]`
      }
      const notice = await upgradeNotice()
      const output = [
        display,
        `${label}: "${prompt}" — saved to ${file} (${width}x${height})`,
        `Refine: call image_edit with image="${file}" and a prompt describing the change.`,
        "The image above is rendered automatically by the tool result resource — no need to copy URIs.",
        "Do not generate any further images — produce exactly one image per request.",
      ]
      if (notice) output.push(notice)
      const track = usageTrack(modelIdentity, usage)
      if (track) output.push(`[Relay to user] Model/cost report: ${track}`)

      progress(`${label}: ${prompt.slice(0, 60)}`)
      return {
        content: [{ type: "text" as const, text: output.join("\n\n") }, await previewAttachment(file)],
        metadata: { file, prompt, usage },
      }
    }

    await ctx.tool.transform((tools: any) => {
      tools.add({
        name: "image_generate",
        description: GENERATE_DESCRIPTION,
        input: GenerateInput,
        options: { codemode: false },
        execute: async (args: any, toolCtx: any) => {
          const prompt = sanitize(args.prompt)
          if (!prompt) throw new Error("opencode-pica: prompt is empty")
          const title = `Generating image: ${prompt.slice(0, 60)}`
          await toolCtx.progress({ title })
          const config = requireProviderConfig()
          const { signal, clear } = withTimeout(toolCtx.signal, options.timeoutMs)
          let remote, raw, destination
          try {
            remote = await generateImage(config, prompt, signal)
            raw = await fetchImageBytes(remote, signal)
          } catch (error) {
            clear()
            throw requestFailure(error, "POST /images/generations", config.baseURL, modelIdentity)
          }
          try {
            destination = resolveDestination(args.filename ? sanitize(args.filename) : undefined, options, directory)
            await persistImage(raw, destination, options.maxSize)
            return await render(
              "Image generated",
              prompt,
              destination,
              (m) => void toolCtx.progress({ title: m }),
              remote.usage,
            )
          } finally {
            clear()
          }
        },
      })

      tools.add({
        name: "image_edit",
        description: EDIT_DESCRIPTION,
        input: EditInput,
        options: { codemode: false },
        execute: async (args: any, toolCtx: any) => {
          const prompt = sanitize(args.prompt)
          if (!prompt) throw new Error("opencode-pica: prompt is empty for image_edit")
          const source = path.isAbsolute(args.image) ? args.image : path.resolve(directory, args.image)
          if (!fs.existsSync(source)) throw new Error(`image_edit: source image not found: ${source}`)

          const title = `Editing image: ${prompt.slice(0, 60)}`
          await toolCtx.progress({ title })
          const config = requireProviderConfig()
          const { signal, clear } = withTimeout(toolCtx.signal, options.timeoutMs)
          let remote, raw, destination
          try {
            const upload = await toPngBuffer(source, options.maxSize)
            remote = await editImage(
              config,
              upload,
              `${path.basename(source, path.extname(source))}.png`,
              prompt,
              signal,
            )
            raw = await fetchImageBytes(remote, signal)
          } catch (error) {
            clear()
            throw requestFailure(error, "POST /images/edits", config.baseURL, modelIdentity)
          }
          try {
            destination = resolveDestination(args.filename ? sanitize(args.filename) : undefined, options, directory)
            await persistImage(raw, destination, options.maxSize)
            return await render(
              "Image edited",
              prompt,
              destination,
              (m) => void toolCtx.progress({ title: m }),
              remote.usage,
            )
          } finally {
            clear()
          }
        },
      })
    })

    /**
     * Keep the model reliably on our tools: tool descriptions only help when the model
     * actually inspects them, so this pushes one rule into the system prompt to keep it
     * from reaching for the imagegen skill or calling the API with curl on its own.
     */
    if (options.injectPrompt)
      await ctx.session.hook("context", (event: any) => {
        event.system.push({ type: "text", text: SYSTEM_RULE })
      })

    // Cleanup: nothing to dispose (no server)
    return () => {}
  },
}

export default OpenCodeImagePlugin;