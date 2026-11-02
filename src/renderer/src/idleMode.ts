import type { IdleMode } from '@shared/types';

/** Whether Claude Code may compact a session while it sits idle, as the side panel offers it. */
export const IDLE_MODE_OPTIONS: Array<{ value: IdleMode; label: string; hint: string }> = [
  { value: 'compact', label: 'Claude Code compacts', hint: 'Its own idle compaction, where Anthropic has turned it on' },
  { value: 'off', label: 'Nothing', hint: 'Leave the conversation as it is' }
];

/** Keep-warm lengths: hours after the last reply that a chat's prompt cache is refreshed. */
export const KEEP_WARM_OPTIONS = [
  { value: '0', label: 'Off' },
  { value: '2', label: '2 hours' },
  { value: '4', label: '4 hours' },
  { value: '8', label: '8 hours' },
  { value: '12', label: '12 hours' },
  { value: '24', label: '24 hours' }
];
