import type { ImageSettings, PastedImageNaming } from "../types";

export type PastedImageSkipReason =
  | "disabled"
  | "unsupported-format"
  | "below-threshold"
  | "no-size-benefit"
  | "processing-failed";

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ProcessedPastedImage {
  originalFile: File;
  file: File;
  originalBytes: number;
  outputBytes: number;
  originalDimensions: ImageDimensions | null;
  outputDimensions: ImageDimensions | null;
  compressed: boolean;
  skipReason?: PastedImageSkipReason;
  warning?: string;
}

export interface ImageCompressionDecision {
  supported: boolean;
  shouldProcess: boolean;
  resizeRequired: boolean;
  outputWidth: number;
  outputHeight: number;
  skipReason?: PastedImageSkipReason;
}

const processableImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const genericImageName = /^(?:image|clipboard(?:-image)?|pasted-image)(?:[-_ ]\d+)?$/i;

export function decidePastedImageCompression(
  file: Pick<File, "size" | "type">,
  dimensions: ImageDimensions,
  settings: Pick<ImageSettings, "pasteCompressionEnabled" | "pasteCompressionThresholdBytes" | "pasteCompressionMaxDimension">,
): ImageCompressionDecision {
  const supported = processableImageTypes.has(normalizeImageType(file.type));
  if (!settings.pasteCompressionEnabled) {
    return unchangedDecision(dimensions, supported, "disabled");
  }
  if (!supported) {
    return unchangedDecision(dimensions, false, "unsupported-format");
  }
  const maxDimension = Math.max(1, settings.pasteCompressionMaxDimension);
  const longestSide = Math.max(dimensions.width, dimensions.height);
  const resizeRequired = longestSide > maxDimension;
  const overBytes = file.size > Math.max(0, settings.pasteCompressionThresholdBytes);
  if (!resizeRequired && !overBytes) {
    return unchangedDecision(dimensions, true, "below-threshold");
  }
  const scale = resizeRequired ? maxDimension / longestSide : 1;
  return {
    supported: true,
    shouldProcess: true,
    resizeRequired,
    outputWidth: Math.max(1, Math.round(dimensions.width * scale)),
    outputHeight: Math.max(1, Math.round(dimensions.height * scale)),
  };
}

export function pastedImageFileName(
  file: Pick<File, "name" | "type">,
  naming: PastedImageNaming,
  now = new Date(),
) {
  const extension = extensionForImage(file.type, file.name);
  const original = stripPath(file.name || "");
  const stem = original.replace(/\.[^.]*$/, "").trim();
  const useTimestamp = naming === "timestamp" || !stem || genericImageName.test(stem);
  if (useTimestamp) return `image-${formatTimestamp(now)}.${extension}`;
  return original.includes(".") ? original : `${original}.${extension}`;
}

export async function processPastedImage(
  originalFile: File,
  settings: ImageSettings,
  now = new Date(),
): Promise<ProcessedPastedImage> {
  const namedOriginal = renameFile(originalFile, pastedImageFileName(originalFile, settings.pastedImageNaming, now));
  if (!settings.pasteCompressionEnabled || !processableImageTypes.has(normalizeImageType(originalFile.type))) {
    return unchangedResult(
      originalFile,
      namedOriginal,
      settings.pasteCompressionEnabled ? "unsupported-format" : "disabled",
    );
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(originalFile, { imageOrientation: "from-image" });
    const originalDimensions = { width: bitmap.width, height: bitmap.height };
    const decision = decidePastedImageCompression(originalFile, originalDimensions, settings);
    if (!decision.shouldProcess) {
      return unchangedResult(originalFile, namedOriginal, decision.skipReason, originalDimensions);
    }

    const canvas = document.createElement("canvas");
    canvas.width = decision.outputWidth;
    canvas.height = decision.outputHeight;
    const context = canvas.getContext("2d", { alpha: normalizeImageType(originalFile.type) !== "image/jpeg" });
    if (!context) throw new Error("Canvas 2D context is unavailable");
    context.drawImage(bitmap, 0, 0, decision.outputWidth, decision.outputHeight);
    const outputType = normalizeImageType(originalFile.type);
    const quality = Math.min(1, Math.max(0.4, settings.pasteCompressionQuality / 100));
    const blob = await canvasToBlob(canvas, outputType, outputType === "image/png" ? undefined : quality);
    if (!decision.resizeRequired && blob.size >= originalFile.size) {
      return unchangedResult(originalFile, namedOriginal, "no-size-benefit", originalDimensions);
    }
    const file = new File([blob], namedOriginal.name, { type: outputType, lastModified: Date.now() });
    return {
      originalFile,
      file,
      originalBytes: originalFile.size,
      outputBytes: file.size,
      originalDimensions,
      outputDimensions: { width: decision.outputWidth, height: decision.outputHeight },
      compressed: true,
    };
  } catch (error) {
    return {
      ...unchangedResult(originalFile, namedOriginal, "processing-failed"),
      warning: `图片 ${namedOriginal.name} 压缩失败，已保存原图：${String(error)}`,
    };
  } finally {
    bitmap?.close();
  }
}

function unchangedDecision(
  dimensions: ImageDimensions,
  supported: boolean,
  skipReason: PastedImageSkipReason,
): ImageCompressionDecision {
  return {
    supported,
    shouldProcess: false,
    resizeRequired: false,
    outputWidth: dimensions.width,
    outputHeight: dimensions.height,
    skipReason,
  };
}

function unchangedResult(
  originalFile: File,
  file: File,
  skipReason: PastedImageSkipReason = "below-threshold",
  dimensions: ImageDimensions | null = null,
): ProcessedPastedImage {
  return {
    originalFile,
    file,
    originalBytes: originalFile.size,
    outputBytes: originalFile.size,
    originalDimensions: dimensions,
    outputDimensions: dimensions,
    compressed: false,
    skipReason,
  };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(`Unable to encode ${type}`)), type, quality);
  });
}

function renameFile(file: File, name: string) {
  if (file.name === name) return file;
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}

function normalizeImageType(value: string) {
  const normalized = value.toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function extensionForImage(type: string, name: string) {
  const byType: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
  };
  return byType[normalizeImageType(type)] || name.match(/\.([a-z0-9]{1,8})$/i)?.[1].toLowerCase() || "png";
}

function stripPath(value: string) {
  return value.split(/[\\/]/).pop() || "";
}

function formatTimestamp(date: Date) {
  const value = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}${value(date.getMonth() + 1)}${value(date.getDate())}-${value(date.getHours())}${value(date.getMinutes())}${value(date.getSeconds())}`;
}
