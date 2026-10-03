import { describe, expect, it } from 'vitest';
import { validateChatImages, MAX_IMAGE_BYTES } from '../src/shared/chatImages';
import { codexHistory } from '../src/main/chat/history';

const image = { name: 'image.png', dataUrl: 'data:image/png;base64,aGVsbG8=' };

describe('chat image attachments', () => {
  it('rejects unsupported, malformed, oversized, and excessive attachments', () => {
    expect(() => validateChatImages([image])).not.toThrow();
    expect(() => validateChatImages(Array(6).fill(image))).toThrow(/up to 5/);
    for (const dataUrl of ['https://example.com/image.png', 'data:image/svg+xml;base64,aGVsbG8=', 'data:image/png;base64,!!!!', 'data:image/png;base64,a']) {
      expect(() => validateChatImages([{ ...image, dataUrl }])).toThrow();
    }
    const dataUrl = `data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')}`;
    expect(() => validateChatImages([{ ...image, dataUrl }])).toThrow(/5 MB/);
  });

  it('restores image-only Codex history', () => {
    const history = codexHistory([JSON.stringify({
      type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'UserMessage', id: 'image-message', content: [{ type: 'Image', url: image.dataUrl }]
      } }
    })]);
    expect(history[0].entry).toMatchObject({ kind: 'user', text: '', images: [{ dataUrl: image.dataUrl }] });
  });
});
