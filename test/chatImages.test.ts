import { describe, expect, it } from 'vitest';
import { validateChatImages, MAX_IMAGE_BYTES } from '../src/shared/chatImages';
import { claudeHistory, codexHistory } from '../src/main/chat/history';
import { ChatLog } from '../src/main/chat/log';
import { codexItemEntry } from '../src/main/chat/codexItems';
import { withViewedImage } from '../src/main/chat/viewedImage';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEntry } from '../src/shared/types';

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

  it('keeps the pictures a tool returned, apart from its text', () => {
    const source = { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' };
    const claude = claudeHistory([
      JSON.stringify({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:\\shots\\one.png' } }] } }),
      JSON.stringify({ type: 'user', uuid: 'b', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source }] }] } })
    ]);
    expect(claude).toHaveLength(1);
    expect(claude[0].entry).toMatchObject({ kind: 'tool', output: '', images: [{ name: 'one.png', dataUrl: image.dataUrl }] });

    const codex = codexHistory([JSON.stringify({
      type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'Take a shot' }] } }
    }), JSON.stringify({
      type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'McpToolCall', id: 'm1', server: 'shots', tool: 'take', status: 'completed',
        result: { content: [{ type: 'text', text: 'Saved' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] }
      } }
    })]);
    expect(codex[1].entry).toMatchObject({ kind: 'tool', output: 'Saved', images: [{ dataUrl: image.dataUrl }] });
  });

  it('keeps what was asked and what was answered on a question step', () => {
    const questions = [
      { question: 'Which "mode"?', header: 'Mode', multiSelect: false, options: [{ label: 'Fast', description: 'Quick' }, { label: 'Safe' }] },
      { question: 'Which files?', header: 'Files', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }
    ];
    const ask = JSON.stringify({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions } }] } });
    const text = 'Your questions have been answered: "Which "mode"?"="Safe", "Which files?"="A, B". You can now continue with these answers in mind.';
    const reply = (extra: object) => JSON.stringify({ type: 'user', uuid: 'b', message: { content: [{ type: 'tool_result', tool_use_id: 'q1', content: text }] }, ...extra });
    const answers = { 'Which "mode"?': 'Safe', 'Which files?': 'A, B' };
    // From the result's text alone, and from the structured copy when the CLI wrote one.
    expect(claudeHistory([ask, reply({})])[0].entry).toMatchObject({ kind: 'tool', questions: [{ id: 'Which "mode"?', options: [{ label: 'Fast' }, { label: 'Safe' }] }, { multiSelect: true }], answers });
    expect(claudeHistory([ask, reply({ toolUseResult: { answers: { 'Which files?': 'B' } } })])[0].entry).toMatchObject({ answers: { 'Which files?': 'B' } });
    const skipped = claudeHistory([ask, JSON.stringify({ type: 'user', uuid: 'b', message: { content: [{ type: 'tool_result', tool_use_id: 'q1', is_error: true, content: 'No answer was provided.' }] } })])[0].entry;
    expect(skipped).toMatchObject({ status: 'error', output: 'No answer was provided.' });
    expect(skipped).not.toHaveProperty('answers');
  });

  it('drops the oldest steps\' pictures once a conversation holds too many', () => {
    const step = (id: string): ChatEntry => ({ kind: 'tool', id, tool: 'Read', title: 'Read', detail: null, input: null, output: null, images: [image], status: 'done', files: null, durationMs: null });
    const log = new ChatLog([], image.dataUrl.length * 2);
    for (const id of ['one', 'two', 'three']) log.upsert(step(id));
    expect(log.get('one')).toMatchObject({ output: '[image no longer kept]' });
    expect(log.get('one')).not.toHaveProperty('images');
    expect(log.get('two')).toMatchObject({ images: [image] });
    expect(log.get('three')).toMatchObject({ images: [image] });
  });

  it('shows the picture behind a Codex "Viewed image" step, read from the path Codex reports', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atc-viewed-'));
    try {
      fs.writeFileSync(path.join(dir, 'shot.png'), 'hello');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
      const step = (file: string) => codexItemEntry({ type: 'imageView', id: 'v', path: file })!;
      expect(withViewedImage(step(path.join(dir, 'shot.png')))).toMatchObject({ title: 'Viewed image', detail: 'shot.png', images: [{ name: 'shot.png', dataUrl: image.dataUrl }] });
      expect(withViewedImage(step('shot.png'), { cwd: dir })).toMatchObject({ images: [{ name: 'shot.png' }] });
      // No picture: a relative path with nowhere to start from, a file that isn't an image, one that is gone,
      // and (in history) one changed after the agent looked at it.
      expect(withViewedImage(step('shot.png'))).not.toHaveProperty('images');
      expect(withViewedImage(step(path.join(dir, 'notes.txt')))).not.toHaveProperty('images');
      expect(withViewedImage(step(path.join(dir, 'gone.png')))).not.toHaveProperty('images');
      expect(withViewedImage(step(path.join(dir, 'shot.png')), { at: '2020-01-01T00:00:00Z' })).not.toHaveProperty('images');

      const record = (item: unknown) => JSON.stringify({ type: 'event_msg', timestamp: new Date(Date.now() + 60_000).toISOString(), payload: { type: 'item_completed', item } });
      const history = codexHistory([record({ type: 'ImageView', id: 'v', path: path.join(dir, 'shot.png') }), record({ type: 'AgentMessage', id: 'a', text: 'Looks right.' })]);
      expect(history[0].entry).toMatchObject({ tool: 'view_image', images: [{ name: 'shot.png' }] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
