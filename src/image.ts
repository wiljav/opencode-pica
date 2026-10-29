import * as fs from "node:fs"
import * as path from "node:path"
import sharp from "sharp"

export type Dimensions = { width: number; height: number }

/** Sharp resize options: scale uniformly so the longest side fits within max, never upscale */
export function fitInside(max: number) {
  return { width: max, height: max, fit: "inside" as const, withoutEnlargement: true }
}

/** Read image dimensions; throws when the file is not a valid image */
export async function imageDimensions(file: string): Promise<Dimensions> {
  const meta = await sharp(file).metadata()
  if (!meta.width || !meta.height) {
    throw new Error(`opencode-pica: cannot read image dimensions: ${file}`)
  }
  return { width: meta.width, height: meta.height }
}

/** Read any image and resize as needed, always outputting PNG bytes (for upload endpoints, so the mime is accurate) */
export async function toPngBuffer(source: string, maxSize: number): Promise<Buffer> {
  const current = await imageDimensions(source)
  const pipeline =
    Math.max(current.width, current.height) > maxSize ? sharp(source).resize(fitInside(maxSize)) : sharp(source)
  return pipeline.png().toBuffer()
}

/**
 * Downscale ladder for the inline display copy. opencode truncates tool output at
 * 50 KiB (MAX_BYTES in opencode 2.1.4's tool-output.ts); the full-resolution data URI
 * never survives it, so the model receives the saved-file path instead of a renderable
 * image. The display copy starts at 512px JPEG and steps down until it fits the budget.
 */
const DISPLAY_LADDER: Array<{ size: number; quality: number }> = [
  { size: 512, quality: 80 },
  { size: 384, quality: 70 },
  { size: 256, quality: 60 },
]

/**
 * Build an inline display copy as a JPEG data URI whose encoded length fits within
 * `budgetChars`. Returns a data URI in all cases — at worst the smallest rung of the
 * ladder — so the caller's Markdown line stays renderable whenever possible.
 */
export async function displayDataUri(file: string, budgetChars: number): Promise<string> {
  const dims = await imageDimensions(file)
  for (const step of DISPLAY_LADDER) {
    const pipeline =
      Math.max(dims.width, dims.height) > step.size ? sharp(file).resize(fitInside(step.size)) : sharp(file)
    const bytes = await pipeline.jpeg({ quality: step.quality }).toBuffer()
    const uri = `data:image/jpeg;base64,${bytes.toString("base64")}`
    if (uri.length <= budgetChars) return uri
  }
  const bytes = await sharp(file).resize(fitInside(160)).jpeg({ quality: 50 }).toBuffer()
  return `data:image/jpeg;base64,${bytes.toString("base64")}`
}

/** Generate a uniformly scaled PNG preview; return the original path when the source already fits within max */
export async function renderPreview(source: string, destination: string, max: number): Promise<string> {
  const current = await imageDimensions(source)
  if (Math.max(current.width, current.height) <= max) return source
  await sharp(source).resize(fitInside(max)).png().toFile(destination)
  return destination
}

/**
 * Normalize the raw bytes returned by the API into a PNG on disk:
 * 1. Write a staging file first, then read dimensions from the persisted bytes
 *    (avoids a truncated download being treated as the finished product)
 * 2. Scale down uniformly when it exceeds maxSize
 * 3. Convert to PNG, so the extension, mime and actual bytes all agree
 */
export async function persistImage(raw: Buffer, destination: string, maxSize: number): Promise<Dimensions> {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const staging = `${destination}.${process.pid}-${Date.now()}.download`
  fs.writeFileSync(staging, raw)
  try {
    const meta = await sharp(staging).metadata()
    const width = meta.width ?? 0
    const height = meta.height ?? 0
    if (!width || !height) throw new Error("opencode-pica: response is not a decodable image")
    const pipeline =
      Math.max(width, height) > maxSize ? sharp(staging).resize(fitInside(maxSize)) : sharp(staging)
    await pipeline.png().toFile(destination)
  } finally {
    fs.rmSync(staging, { force: true })
  }
  return imageDimensions(destination)
}
