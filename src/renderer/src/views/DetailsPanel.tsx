// The side panel's Details tab: what the context window holds (by part, as
// Claude Code reports it for a running chat; a single meter otherwise), what the
// session cost, its tokens, plan usage and the session itself.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Copy, FolderOpen, RefreshCw } from 'lucide-react';
import { PROVIDER_LABEL, type AgentInfo, type ContextPart, type ContextUsage, type IdleMode } from '@shared/types';
import { call, errorMessage } from '../api';
import { useApp } from '../store';
import { ago, compact, duration, usd } from '../format';
import { Meter, Select, useTicker } from '../ui';
import { IDLE_MODE_OPTIONS, KEEP_WARM_OPTIONS } from '../idleMode';

/** Palette slots 3–8 (and a neutral for anything newer), in the bar's fixed order: a part keeps its color whatever else shows. */
const PART_COLOR: Record<ContextPart, string> = {
  system: 'var(--series-3)',
  tools: 'var(--series-4)',
  mcp: 'var(--series-5)',
  memory: 'var(--series-6)',
  skills: 'var(--series-7)',
  messages: 'var(--series-8)',
  other: 'var(--text-muted)'
};

/** Last known breakdown per agent, so switching tabs or agents doesn't flash the fallback meter. */
const known = new Map<string, ContextUsage>();

function useContextUsage(agent: AgentInfo) {
  const live = agent.provider === 'claude' && agent.mode === 'chat' && !agent.endedAt;
  const [usage, setUsage] = useState<ContextUsage | null>(() => (live ? known.get(agent.id) ?? null : null));
  const [loading, setLoading] = useState(false);
  const current = useRef(agent.id);
  current.current = agent.id;
  const load = async () => {
    if (!live) return;
    const id = agent.id;
    setLoading(true);
    try {
      const next = await call('chat.contextUsage', id);
      if (next) known.set(id, next);
      if (current.current === id) setUsage(next ?? known.get(id) ?? null);
    } catch {
      // Keep what's shown.
    } finally {
      if (current.current === id) setLoading(false);
    }
  };
  useEffect(() => {
    setUsage(live ? known.get(agent.id) ?? null : null);
    void load();
  }, [agent.id, agent.runId, live]);
  // After each response (and when the turn ends) the window has changed.
  useEffect(() => {
    if (agent.status === 'idle' || agent.status === 'needs-input') void load();
  }, [agent.status, agent.telemetry?.requests, agent.telemetry?.compactions]);
  return { usage, loading, live, load };
}

const share = (tokens: number, window: number) => (window ? (tokens / window) * 100 : 0);
const pct = (value: number) => (value >= 10 || value === 0 ? `${Math.round(value)}%` : value < 0.1 ? '<0.1%' : `${value.toFixed(1)}%`);

function ContextBreakdown({ usage, compactions, lastCompactionAt }: { usage: ContextUsage; compactions: number; lastCompactionAt: string | null }) {
  const [active, setActive] = useState<string | null>(null);
  const window = usage.windowTokens;
  const used = share(usage.usedTokens, window);
  const hover = (key: string | null) => ({ onMouseEnter: () => setActive(key), onMouseLeave: () => setActive(null) });
  const dim = (key: string) => (active && active !== key ? 'dim' : '');
  return (
    <>
      <div className="ctx-total">
        <span>
          <strong>{compact(usage.usedTokens)}</strong> of {compact(window)} tokens
        </span>
        <span className="ctx-pct">{pct(used)}</span>
      </div>
      <div className="ctx-bar" role="img" aria-label={`Context window ${pct(used)} full`}>
        {usage.parts.map((p) => (
          <span
            key={p.part}
            className={`ctx-seg ${dim(p.part)}`}
            style={{ width: `${share(p.tokens, window)}%`, background: PART_COLOR[p.part] }}
            title={`${p.label}: ${compact(p.tokens)} tokens (${pct(share(p.tokens, window))})`}
            {...hover(p.part)}
          />
        ))}
        <span className="ctx-free" />
        {usage.bufferTokens ? (
          <span
            className={`ctx-seg ctx-buffer ${dim('buffer')}`}
            style={{ width: `${share(usage.bufferTokens, window)}%` }}
            title={`Autocompact buffer: ${compact(usage.bufferTokens)} tokens kept free for compaction`}
            {...hover('buffer')}
          />
        ) : null}
      </div>
      <ul className="ctx-legend">
        {usage.parts.map((p) => (
          <li key={p.part} className={dim(p.part)} {...hover(p.part)}>
            <span className="ctx-swatch" style={{ background: PART_COLOR[p.part] }} aria-hidden="true" />
            <span className="ctx-name">{p.label}</span>
            <span className="ctx-num">{compact(p.tokens)}</span>
            <span className="ctx-num muted">{pct(share(p.tokens, window))}</span>
          </li>
        ))}
        <li className={dim('free')} {...hover('free')}>
          <span className="ctx-swatch free" aria-hidden="true" />
          <span className="ctx-name">Free space</span>
          <span className="ctx-num">{compact(usage.freeTokens)}</span>
          <span className="ctx-num muted">{pct(share(usage.freeTokens, window))}</span>
        </li>
        {usage.bufferTokens ? (
          <li className={dim('buffer')} {...hover('buffer')}>
            <span className="ctx-swatch buffer" aria-hidden="true" />
            <span className="ctx-name">Autocompact buffer</span>
            <span className="ctx-num">{compact(usage.bufferTokens)}</span>
            <span className="ctx-num muted">{pct(share(usage.bufferTokens, window))}</span>
          </li>
        ) : null}
      </ul>
      <div className="ctx-note">
        {usage.autoCompactAt ? `Compacts automatically at ${compact(usage.autoCompactAt)}` : 'Auto-compact is off'}
        {' · '}
        {compactions === 1 ? '1 compaction' : `${compactions} compactions`}
        {lastCompactionAt ? `, last ${ago(lastCompactionAt)}` : ''}
        {usage.deferredTokens ? (
          <div>{compact(usage.deferredTokens)} of tool definitions stay out of the window until Claude searches for them.</div>
        ) : null}
      </div>
      <div className="ctx-lists">
        {usage.messages ? <Fold title="Messages" items={usage.messages.map((m) => ({ key: m.label, label: m.label, tokens: m.tokens }))} /> : null}
        <Fold title="MCP servers" items={usage.mcpServers.map((s) => ({ key: s.name, label: s.name, sub: `${s.tools} ${s.tools === 1 ? 'tool' : 'tools'} loaded`, tokens: s.tokens }))} />
        <Fold title="Memory files" items={usage.memoryFiles.map((f) => ({ key: f.path, label: f.path.split(/[\\/]/).slice(-2).join('/'), title: f.path, tokens: f.tokens }))} />
        <Fold title="Skills" items={usage.skills.map((s) => ({ key: `${s.source}:${s.name}`, label: s.name, sub: s.source, tokens: s.tokens }))} />
        <Fold title="Custom agents" items={usage.agents.map((a) => ({ key: `${a.source}:${a.name}`, label: a.name, sub: a.source, tokens: a.tokens }))} />
      </div>
    </>
  );
}

/** A collapsed list behind one of the parts: what in it takes the tokens. */
function Fold({ title, items }: { title: string; items: Array<{ key: string; label: string; sub?: string; title?: string; tokens: number }> }) {
  if (!items.length) return null;
  const total = items.reduce((sum, i) => sum + i.tokens, 0);
  return (
    <details className="ctx-fold">
      <summary>
        <ChevronRight size={13} className="chev" aria-hidden="true" />
        <span className="ctx-name">{title}</span>
        <span className="ctx-count">{items.length}</span>
        <span className="ctx-num">{compact(total)}</span>
      </summary>
      <ul>
        {items.map((i) => (
          <li key={i.key} title={i.title ?? i.label}>
            <span className="ctx-name">
              {i.label}
              {i.sub ? <span className="ctx-sub"> · {i.sub}</span> : null}
            </span>
            <span className="ctx-num">{compact(i.tokens)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** What this Claude session does when it sits idle until shortly before its prompt cache expires. */
function IdleModeSection({ agent }: { agent: AgentInfo }) {
  const toast = useApp((s) => s.toast);
  const chat = agent.mode === 'chat';
  const mode = agent.idleMode ?? 'compact';
  const note = mode === 'compact'
    ? 'Claude Code may compact it about 54 minutes after the last reply, if Anthropic has turned this on for the account.'
    : 'Claude Code leaves the conversation as it is while it sits idle.';
  const timing = chat || agent.endedAt ? null : 'Takes effect the next time this session starts.';
  return (
    <section>
      <div className="details-head">
        <h3>When idle</h3>
      </div>
      <Select
        aria-label="When this session sits idle"
        value={mode}
        onChange={(value) => call('chat.setIdleMode', agent.id, value as IdleMode).catch((error) => toast('error', errorMessage(error)))}
        options={IDLE_MODE_OPTIONS}
      />
      <div className="ctx-note">{note}{timing ? ` ${timing}` : ''}</div>
      {chat ? <KeepWarm agent={agent} /> : null}
    </section>
  );
}

/** Keeping a chat's prompt cache warm for a while after its last reply, and how that is going. */
function KeepWarm({ agent }: { agent: AgentInfo }) {
  const toast = useApp((s) => s.toast);
  const hours = agent.keepWarmHours ?? 0;
  const allowed = agent.idleMode === 'off';
  const k = agent.cacheKeepalive?.forActivityAt === agent.lastModelActivityAt ? agent.cacheKeepalive : null;
  const turn = Date.parse(agent.lastModelActivityAt ?? '');
  const until = hours > 0 && Number.isFinite(turn) ? turn + hours * 3_600_000 : null;
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const costs = k?.refreshUsd != null && k.rebuildUsd != null ? ` Each refresh ≈ ${usd(k.refreshUsd)}; rebuilding the cache ≈ ${usd(k.rebuildUsd)} (list prices).` : '';
  const note = hours === 0 ? 'Off: the prompt cache expires an hour after the last reply.'
    : k?.error ? `Stopped for this reply: ${k.error}`
    : k?.pending ? 'Refreshing the cache…'
    : until !== null && Date.now() >= until ? `Done: kept warm until ${time(until)}.${costs}`
    : k?.count ? `Kept warm until ${until !== null ? time(until) : '—'}: ${k.count === 1 ? '1 refresh' : `${k.count} refreshes`} so far, last ${ago(k.lastAt)}.${costs}`
    : `Refreshed every 40 minutes for ${hours} hours after the last reply.`;
  return (
    <>
      <div className="details-head" style={{ marginTop: 10 }}>
        <h3>Keep cache warm</h3>
      </div>
      <Select
        aria-label="Keep this chat's prompt cache warm"
        disabled={!allowed || Boolean(agent.endedAt)}
        value={String(hours)}
        onChange={(value) => call('chat.setKeepWarm', agent.id, Number(value)).catch((error) => toast('error', errorMessage(error)))}
        options={KEEP_WARM_OPTIONS}
      />
      <div className="ctx-note">{allowed ? note : 'Needs “Nothing” above: Claude Code’s idle compaction would compact the chat being kept warm.'}</div>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

function Row({ label, children, title, mono }: { label: string; children: ReactNode; title?: string; mono?: boolean }) {
  return (
    <>
      <dt className="ellipsis" title={label}>
        {label}
      </dt>
      <dd className={mono ? 'mono' : undefined} title={title}>
        {children}
      </dd>
    </>
  );
}

export function AgentDetails({ agent }: { agent: AgentInfo }) {
  useTicker(5000);
  const toast = useApp((s) => s.toast);
  const t = agent.telemetry;
  const total = t?.totalUsage;
  const { usage, loading, live, load } = useContextUsage(agent);
  const cost = t?.cost.reportedUsd ?? t?.cost.totalUsd ?? null;
  const uncached = total ? Math.max(0, total.inputTokens - total.cachedInputTokens - total.cacheWriteInputTokens) : 0;
  const cacheHit = total && total.inputTokens ? (total.cachedInputTokens / total.inputTokens) * 100 : null;
  const sessionId = t?.sessionId ?? agent.sessionId ?? null;

  return (
    <div className="sp-pane details" aria-label="Agent details">
      <section>
        <div className="details-head">
          <h3>Context</h3>
          {live ? (
            <button type="button" className="btn ghost sm icon" title="Check again" aria-label="Check the context again" disabled={loading} onClick={() => void load()}>
              <RefreshCw size={13} className={loading ? 'spin' : undefined} />
            </button>
          ) : null}
        </div>
        {usage ? (
          <ContextBreakdown usage={usage} compactions={t?.compactions ?? 0} lastCompactionAt={t?.lastCompactionAt ?? null} />
        ) : t ? (
          <>
            <Meter
              label={`${compact(t.contextUsedTokens)} of ${compact(t.contextWindow)} tokens`}
              value={t.contextPercent}
              foot={t.contextWindowAssumed ? 'Window size assumed from the model; adjust in Settings' : t.source === 'status-line' ? 'Reported by Claude Code' : 'Reported by the CLI'}
            />
            <div className="ctx-note">
              {t.compactions === 1 ? '1 compaction' : `${t.compactions} compactions`}
              {t.lastCompactionAt ? `, last ${ago(t.lastCompactionAt)}` : ''}
            </div>
          </>
        ) : (
          <div className="ctx-note">Appears after the first response.</div>
        )}
      </section>

      {/* Sessions from before idle modes existed show Claude Code's behavior ('compact') and can change it too. */}
      {agent.provider === 'claude' && (agent.mode === 'chat' || agent.mode === 'interactive') ? <IdleModeSection agent={agent} /> : null}

      <section>
        <div className="details-head">
          <h3>Cost</h3>
          {t ? <span className="details-aside">{t.requests === 1 ? '1 request' : `${compact(t.requests)} requests`}</span> : null}
        </div>
        {t ? <div className="big-number">{usd(cost)}</div> : null}
        <div className="ctx-note">
          {t?.cost.reportedUsd != null
            ? `Claude Code's estimate · list-price estimate ${usd(t.cost.totalUsd)}`
            : t
              ? 'At API list prices; subscriptions are billed differently'
              : 'Appears after the first response.'}
        </div>
        {t && t.cost.byModel.length > 1 ? (
          <dl className="kv" style={{ marginTop: 8 }}>
            {t.cost.byModel.map((m) => (
              <Row key={m.model} label={m.model}>{m.usd === null ? 'unpriced' : usd(m.usd, true)}</Row>
            ))}
          </dl>
        ) : t?.cost.byModel.length === 1 ? (
          <div className="ctx-note mono">{t.cost.byModel[0].model}</div>
        ) : null}
      </section>

      {total ? (
        <section>
          <div className="details-head">
            <h3>Tokens</h3>
            <span className="details-aside">{compact(total.totalTokens)} this session</span>
          </div>
          <div className="stat-grid">
            <Stat label="Cache reads" value={compact(total.cachedInputTokens)} sub={cacheHit !== null ? `${Math.round(cacheHit)}% of input` : undefined} />
            <Stat label="Cache writes" value={compact(total.cacheWriteInputTokens)} />
            <Stat label="Input (uncached)" value={compact(uncached)} />
            <Stat label="Output" value={compact(total.outputTokens)} sub={total.reasoningOutputTokens ? `${compact(total.reasoningOutputTokens)} reasoning` : undefined} />
          </div>
        </section>
      ) : null}

      {t?.limits?.windows.length ? (
        <section>
          <h3>Plan usage</h3>
          <div style={{ display: 'grid', gap: 10 }}>
            {t.limits.windows.map((w) => (
              <Meter left key={w.id} label={w.label} value={w.usedPercent} />
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h3>Session</h3>
        <dl className="kv">
          <Row label="Tool">{PROVIDER_LABEL[agent.provider]} · {agent.mode}</Row>
          {t?.model ?? agent.model ? <Row label="Model" mono>{t?.model ?? agent.model}</Row> : null}
          {t?.effort ? <Row label="Effort">{t.effort}</Row> : null}
          {agent.permission ? <Row label="Permissions">{agent.permission}</Row> : null}
          <Row label={agent.endedAt ? 'Ran for' : 'Running'}>{duration(agent.startedAt, agent.endedAt)}</Row>
          {agent.resources ? (
            <Row label="CPU · memory">
              {agent.resources.cpuPercent.toFixed(1)}% · {Math.round(agent.resources.memoryMB)} MB{agent.resources.processCount > 1 ? ` · ${agent.resources.processCount} processes` : ''}
            </Row>
          ) : null}
          {agent.exitCode !== null ? <Row label="Exit code">{agent.exitCode}</Row> : null}
          <Row label="Session id" title={sessionId ?? ''} mono>
            {sessionId ? (
              <button type="button" className="details-copy" title="Copy the session id" onClick={() => navigator.clipboard.writeText(sessionId).then(() => toast('success', 'Session id copied.'))}>
                {sessionId.slice(0, 13)} <Copy size={11} />
              </button>
            ) : (
              '—'
            )}
          </Row>
        </dl>
        {agent.transcriptPath ? (
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => call('shell.showItem', agent.transcriptPath!)}>
            <FolderOpen size={13} /> Show session file
          </button>
        ) : null}
        {agent.commandLine ? (
          <details className="ctx-fold command">
            <summary>
              <ChevronRight size={13} className="chev" aria-hidden="true" />
              <span className="ctx-name">Command line</span>
            </summary>
            <div className="mono selectable muted command-line">{agent.commandLine}</div>
            <button type="button" className="btn ghost sm" onClick={() => navigator.clipboard.writeText(agent.commandLine!).then(() => toast('success', 'Command line copied.'))}>
              <Copy size={12} /> Copy
            </button>
          </details>
        ) : null}
      </section>
    </div>
  );
}
