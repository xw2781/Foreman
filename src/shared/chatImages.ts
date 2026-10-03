import type { ChatImage } from './types';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_IMAGES = 5;

/** Also checked in the main process before anything reaches a CLI. */
export function validateChatImages(images: ChatImage[]): void {
  if (!Array.isArray(images) || images.length > MAX_CHAT_IMAGES) throw new Error('Attach up to 5 images per message.');
  for (const image of images) {
    if (!image || typeof image.name !== 'string' || typeof image.dataUrl !== 'string') throw new Error('Invalid image attachment.');
    if (image.dataUrl.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40) throw new Error('Each image must be 5 MB or smaller.');
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
    if (!match || match[2].length % 4 !== 0) throw new Error('Attach a PNG, JPEG, GIF, or WebP image.');
    const bytes = match[2].length * 3 / 4 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
    if (bytes > MAX_IMAGE_BYTES) throw new Error('Each image must be 5 MB or smaller.');
  }
}

/** Inline images saved by either provider, used for live echoes and history. */
export function contentImages(content: unknown): ChatImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): ChatImage[] => {
    const type = String(part?.type ?? '').toLowerCase();
    const dataUrl = type === 'image' ? part.url ?? (part.source?.type === 'base64' ? `data:${part.source.media_type};base64,${part.source.data}` : null)
      : type === 'input_image' ? part.image_url : null;
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(dataUrl)) return [];
    return [{ name: 'Attached image', dataUrl }];
  });
}
