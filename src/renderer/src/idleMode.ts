/** Keep-warm lengths: hours after the last reply that a chat's prompt cache is refreshed. Any other number can be typed. */
export const KEEP_WARM_OPTIONS = [
  { value: '2', label: '2 hours' },
  { value: '4', label: '4 hours' },
  { value: '8', label: '8 hours' },
  { value: '12', label: '12 hours' },
  { value: '24', label: '24 hours' }
];

/** Shown in the hours box while keep-warm is off, and used when it's turned on. */
export const DEFAULT_KEEP_WARM_HOURS = 4;
