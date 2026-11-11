import { invoke } from '@tauri-apps/api/core';
import { dirname, resolve } from '@tauri-apps/api/path';
import { extractAssetReferences } from '../utils/documentAssets';
import type { ImageSettings } from '../types';

export async function assetReferenceForDocument(markdownPath: string, absolutePath: string, settings: Readonly<ImageSettings>) {
  return invoke<string>('asset_path_to_reference', {
    markdownPath, path: absolutePath, useRelativePath: settings.useRelativePath,
    ensureDotSlash: settings.ensureDotSlash, escapePath: settings.escapePath,
  });
}
/** Assets are written to the original frozen directory; Save As only changes the final reference. */
export async function rebasePendingImagePaths(markdown: string, originalPath: string, currentPath: string, settings: Readonly<ImageSettings>) {
  if (originalPath === currentPath) return markdown;
  const references = extractAssetReferences(markdown).filter(reference => !reference.external);
  const originalDirectory = await dirname(originalPath);
  const replacements = await Promise.all(references.map(async reference => {
    let decoded = reference.source;
    try { decoded = decodeURIComponent(decoded); } catch { /* Preserve the literal path if it was not encoded. */ }
    const absolute = await resolve(originalDirectory, decoded);
    return { ...reference, insert: await assetReferenceForDocument(currentPath, absolute, settings) };
  }));
  let result = markdown;
  for (const reference of replacements.reverse()) result = result.slice(0, reference.from) + reference.insert + result.slice(reference.to);
  return result;
}
