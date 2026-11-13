import { describe, expect, it } from 'vitest';
import { cheapestModel, explainArgs, explainPrompt, parseExplanation } from '../src/main/chat/explain';
import type { ChatItem } from '../src/shared/types';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

function step(patch: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: 'tool', id: 't1', tool: 'Bash', title: 'Edited', detail: 't12_summary.ps1',
    input: "sed -i 's/a/b/' t12_summary.ps1; grep -c b t12_summary.ps1", output: '3', status: 'done', files: null, durationMs: 40,
    seq: 1, rev: 1, at: '2026-11-13T00:00:00.000Z', ...patch
  };
}

describe('step explanations', () => {
  it('sends the step alone: what ran, how it ended, what came back', () => {
    const prompt = explainPrompt(step());
    expect(prompt).toContain('Step: Edited t12_summary.ps1\nTool: Bash\nResult: finished without an error');
    expect(prompt).toContain("<command>\nsed -i 's/a/b/' t12_summary.ps1; grep -c b t12_summary.ps1\n</command>");
    expect(prompt).toContain('<output>\n3\n</output>');
    expect(prompt).not.toContain('<changes>');
    expect(explainPrompt(step({ status: 'error', output: 'sed: no such file' }))).toContain('Result: failed');
  });

  it('gives other tools their input and file edits their diff', () => {
    const prompt = explainPrompt(step({ tool: 'Edit', title: 'Edited', detail: 'a.ts', input: 'src/a.ts', output: null, files: [{ path: 'src/a.ts', kind: 'update', diff: '-old\n+new' }] }));
    expect(prompt).toContain('<input>\nsrc/a.ts\n</input>');
    expect(prompt).toContain('<changes>\nupdate src/a.ts\n-old\n+new\n</changes>');
    expect(prompt).not.toContain('<output>');
  });

  it('keeps a long output to its start and end', () => {
    const prompt = explainPrompt(step({ output: `first line\n${'x'.repeat(50_000)}\nlast line` }));
    expect(prompt.length).toBeLessThan(8000);
    expect(prompt).toContain('first line');
    expect(prompt).toContain('last line');
    expect(prompt).toContain('characters omitted');
  });

  it('runs Claude Code without tools, on its small model, saving no session', () => {
    const args = explainArgs('claude', 'haiku');
    expect(args).toEqual(expect.arrayContaining(['--print', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']));
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true });
    // `--tools ""` takes several values: an option has to follow it.
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--tools') + 2]).toMatch(/^--/);
    expect(args.slice(-2)).toEqual(['--model', 'haiku']);
    expect(explainArgs('claude', null)).not.toContain('--model');
  });

  it('runs Codex read-only and unsaved, with its overrides after the subcommand', () => {
    const args = explainArgs('codex', 'gpt-6-luna');
    expect(args[0]).toBe('exec');
    expect(args).toEqual(expect.arrayContaining(['--ephemeral', '--sandbox', 'read-only', '--json']));
    expect(args.indexOf('-c')).toBeGreaterThan(0);
    expect(args.slice(-3)).toEqual(['--model', 'gpt-6-luna', '-']);
    expect(explainArgs('codex', null)).not.toContain('--model');
  });

  it("reads Claude Code's result", () => {
    const ok = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: ' It edited the script. ', modelUsage: { 'claude-haiku-5-5': {} } });
    expect(parseExplanation('claude', ok, 'haiku')).toEqual({ text: 'It edited the script.', model: 'claude-haiku-5-5' });
    const failed = JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' });
    expect(() => parseExplanation('claude', failed, 'haiku')).toThrow('Invalid API key');
    expect(() => parseExplanation('claude', 'not json', 'haiku')).toThrow('Claude Code gave no explanation');
  });

  it("reads Codex's last message, past the retries it reports as errors", () => {
    const lines = [
      { type: 'thread.started', thread_id: 't' },
      { type: 'error', message: 'Reconnecting... 2/5 (request timed out)' },
      { type: 'item.completed', item: { id: 'item_1', type: 'error', message: 'Falling back from WebSockets to HTTPS transport.' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'It edited the script.' } },
      { type: 'turn.completed', usage: {} }
    ].map((event) => JSON.stringify(event));
    expect(parseExplanation('codex', lines.join('\n'), 'gpt-6-luna')).toEqual({ text: 'It edited the script.', model: 'gpt-6-luna' });
    expect(() => parseExplanation('codex', lines.slice(0, 2).join('\n'), null)).toThrow('Reconnecting');
    expect(() => parseExplanation('codex', '', null)).toThrow('Codex gave no explanation');
  });

  it('picks the cheapest model the account lists, when prices are known', () => {
    const rates: Record<string, number> = { 'gpt-6.1-sol': 2, 'gpt-6-luna': 0.1, 'gpt-5.6-luna': 0.2 };
    const rateFor = (id: string) => (id in rates ? ({ input: rates[id] } as any) : null);
    expect(cheapestModel(['gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-luna', 'gpt-next'], rateFor)).toBe('gpt-6-luna');
    expect(cheapestModel(['gpt-next'], rateFor)).toBeNull();
    expect(cheapestModel([], rateFor)).toBeNull();
    // The shipped table knows the models Codex accounts list today.
    expect(cheapestModel(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol'])).toBe('gpt-6-luna');
  });
});
