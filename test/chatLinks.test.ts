import { describe, expect, it } from 'vitest';
import { chatLinkKind, normalizeFileLinks } from '../src/shared/chatLinks';
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

  it('repairs file links Markdown would show as raw text', () => {
    const dir = 'file:///Z:/Rate Indications/2026Q3 Penn';
    expect(normalizeFileLinks(`- <${dir}/data/Net Trend Penn 3Q2026.xlsx>`))
      .toBe('- [Net Trend Penn 3Q2026.xlsx](file:///Z:/Rate%20Indications/2026Q3%20Penn/data/Net%20Trend%20Penn%203Q2026.xlsx)');
    expect(normalizeFileLinks('<C:\\My Docs\\a_b.xlsx>')).toBe('[a\\_b.xlsx](C:/My%20Docs/a_b.xlsx)');
    expect(normalizeFileLinks('<\\\\server\\share\\My Report.xlsx>')).toBe('[My Report.xlsx](file://server/share/My%20Report.xlsx)');
    expect(normalizeFileLinks('[Report](C:/My Docs/Report (1).xlsx)')).toBe('[Report](C:/My%20Docs/Report%20%281%29.xlsx)');
    expect(normalizeFileLinks('[Report](data/My Report #2.xlsx)')).toBe('[Report](data/My%20Report%20%232.xlsx)');
    expect(normalizeFileLinks('[main](src/my file.ts#L20-L30)')).toBe('[main](src/my%20file.ts#L20-L30)');
    expect(normalizeFileLinks('Saved to file:///C:/out/report.xlsx.')).toBe('Saved to [report.xlsx](file:///C:/out/report.xlsx).');
    expect(normalizeFileLinks('<file:///C:/out/50% off.xlsx>')).toBe('[50% off.xlsx](file:///C:/out/50%25%20off.xlsx)');
  });

  it('repaired links resolve to the file the agent meant', () => {
    const href = (text: string) => /\]\((.*)\)$/.exec(normalizeFileLinks(text))![1];
    expect(resolveChatFile(href('<file:///Z:/Rate Indications/Net Trend #2.xlsx>'), cwd, home)).toBe('Z:\\Rate Indications\\Net Trend #2.xlsx');
    expect(resolveChatFile(href('<\\\\server\\share\\My Report.xlsx>'), cwd, home)).toBe('\\\\server\\share\\My Report.xlsx');
    expect(resolveChatFile(href('[r](out/50% off (1).xlsx)'), cwd, home)).toBe('E:\\Projects\\Report\\out\\50% off (1).xlsx');
  });

  it('leaves valid Markdown, web links and code alone', () => {
    for (const text of [
      '[Report](<file:///C:/My Docs/a.xlsx>)',
      '[Report](C:/Docs/a.xlsx)',
      '[site](https://example.com "A title")',
      '[file](report.xlsx "A title")',
      '[note](see the thing)',
      '<https://example.com/a b>',
      'Use `<file:///C:/My Docs/a.xlsx>` here',
      '```\n<file:///C:/My Docs/a.xlsx>\n```',
      'a < b and c:/x > d'
    ]) expect(normalizeFileLinks(text)).toBe(text);
  });

  it('also resolves POSIX paths without using the app cwd', () => {
    expect(resolveChatFile('file:///tmp/my%20report.xlsx', '/work/repo', '/home/user')).toBe('/tmp/my report.xlsx');
    expect(resolveChatFile('../report.xlsx', '/work/repo', '/home/user')).toBe('/work/report.xlsx');
  });
});
