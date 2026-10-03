import { describe, expect, it } from 'vitest';
import { chatLinkKind } from '../src/shared/chatLinks';
import { resolveChatFile } from '../src/main/chat/fileLinks';

describe('chat file links', () => {
  const cwd = 'E:\\Projects\\Report';
  const home = 'C:\\Users\\Person';

  it('recognizes file paths without enabling arbitrary URL schemes', () => {
    for (const link of ['C:\\Documents\\report.xlsx', 'C:/Documents/report.xlsx', 'file:///C:/Documents/report.xlsx', '../report.xlsx', '/tmp/report.xlsx']) {
      expect(chatLinkKind(link)).toBe('file');
    }
    for (const link of ['https://example.com/report.xlsx', 'http://localhost:3000', '//example.com']) expect(chatLinkKind(link)).toBe('web');
    for (const link of ['javascript:alert(1)', 'data:text/html,hello', 'vscode://file/x', 'sandbox:/mnt/data/report.xlsx', '#section', '']) {
      expect(chatLinkKind(link)).toBe('unsupported');
      expect(() => resolveChatFile(link, cwd, home)).toThrow();
    }
  });

  it('opens report links relative to the session and expands home paths', () => {
    expect(resolveChatFile('ResQ%20report.xlsx', cwd, home)).toBe('E:\\Projects\\Report\\ResQ report.xlsx');
    expect(resolveChatFile('../output/report.xlsx', cwd, home)).toBe('E:\\Projects\\output\\report.xlsx');
    expect(resolveChatFile('~/Documents/report.xlsx', cwd, home)).toBe('C:\\Users\\Person\\Documents\\report.xlsx');
    expect(resolveChatFile('C:/Users/Person/Documents/report.xlsx', cwd, home)).toBe('C:\\Users\\Person\\Documents\\report.xlsx');
    expect(resolveChatFile('/C:/Users/Person/Documents/report.xlsx', cwd, home)).toBe('C:\\Users\\Person\\Documents\\report.xlsx');
  });

  it('decodes file URLs and handles source references', () => {
    expect(resolveChatFile('file:///C:/Documents/ResQ%20report.xlsx', cwd, home)).toBe('C:\\Documents\\ResQ report.xlsx');
    expect(resolveChatFile('src/main.ts#L20-L30', cwd, home)).toBe('E:\\Projects\\Report\\src\\main.ts');
    expect(resolveChatFile('C:/repo/main.ts:20:3', cwd, home)).toBe('C:\\repo\\main.ts');
    expect(resolveChatFile('report%23draft.xlsx', cwd, home)).toBe('E:\\Projects\\Report\\report#draft.xlsx');
    expect(resolveChatFile('file://server/share/report.xlsx', cwd, home)).toBe('\\\\server\\share\\report.xlsx');
    expect(() => resolveChatFile('file:///C:/bad%00name', cwd, home)).toThrow();
    expect(() => resolveChatFile('bad%ZZname.xlsx', cwd, home)).toThrow();
  });

  it('also resolves POSIX paths without using the app cwd', () => {
    expect(resolveChatFile('file:///tmp/my%20report.xlsx', '/work/repo', '/home/user')).toBe('/tmp/my report.xlsx');
    expect(resolveChatFile('../report.xlsx', '/work/repo', '/home/user')).toBe('/work/report.xlsx');
  });
});
