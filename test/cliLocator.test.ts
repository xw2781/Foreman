import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extensionRoots } from '../src/main/cliLocator';

describe('custom VS Code extension discovery', () => {
  it('finds sibling providers when another extension CLI is on PATH', () => {
    const root = path.resolve('custom-editor', 'extensions');
    const cli = path.join(root, 'openai.chatgpt-version', 'bin', 'windows-x86_64');
    const roots = extensionRoots({ PATH: [cli, cli, path.resolve('ordinary-bin')].join(path.delimiter) }, path.resolve('home'));
    expect(roots).toEqual([path.resolve('home', '.vscode', 'extensions'), root]);
  });
  it('includes explicit and portable roots without requiring PATH', () => {
    const portable = path.resolve('portable-data');
    const explicit = path.resolve('custom-extensions');
    expect(extensionRoots({ VSCODE_PORTABLE: portable, VSCODE_EXTENSIONS: explicit }, path.resolve('home')))
      .toEqual([path.resolve('home', '.vscode', 'extensions'), explicit, path.join(portable, 'extensions')]);
  });
});
