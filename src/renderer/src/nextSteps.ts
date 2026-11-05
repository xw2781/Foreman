/**
 * Suggested next steps: the list an agent often ends a finished task with
 * ("Next steps:", "Want me to…", "I'd suggest:"), lifted out of its closing
 * message so each one can be sent with a click.
 */

export interface NextStep {
  /** What goes to the agent when the card is clicked. */
  prompt: string;
  /** The card's heading: the item's bold lead-in, or the whole item. */
  title: string;
  /** What followed the bold lead-in, if there was one. */
  detail: string | null;
}

/** A line that introduces suggestions rather than findings. */
const INTRO =
  /\b(next steps?|follow[- ]?ups?|recommend(?:ed|ations?)?|suggest(?:ed|ions?)?|what(?:'|’)?s next|what to do next|where to go from here|options|could (?:also )?(?:do|try)|want me to|would you like(?: me)? to|i can (?:also )?|shall i|should i|happy to)\b/i;
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const BOLD_LINE = /^\s{0,3}(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/;
const ITEM = /^(\s*)(?:[-*+]|\d{1,2}[.)])\s+(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)/;

const MAX_STEPS = 6;
const MAX_STEP_LENGTH = 400;
/** What may follow the list and still leave it the message's ending: "Let me know which you'd like." */
const MAX_TAIL = 240;

function isIntro(line: string): boolean {
  const heading = HEADING.exec(line) ?? BOLD_LINE.exec(line);
  const text = heading ? heading[1] : /[:?]\s*$/.test(line) ? line : null;
  return text !== null && text.length <= 160 && INTRO.test(text);
}

function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,:;!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function toStep(raw: string): NextStep | null {
  const text = raw.replace(/^\[[ xX]\]\s+/, '').trim();
  if (!text || text.length > MAX_STEP_LENGTH) return null;
  const lead = /^(?:\*\*|__)(.+?)(?:\*\*|__)\s*(?:[-–—:.]\s*)?(.*)$/.exec(text);
  const prompt = plain(text);
  if (lead) {
    const title = plain(lead[1]).replace(/[:.]$/, '');
    const detail = plain(lead[2]);
    return { prompt, title, detail: detail || null };
  }
  return { prompt, title: prompt, detail: null };
}

/**
 * The suggestions closing `markdown`, or none. Only a list that ends the
 * message counts (a short sign-off may follow it), so a "Recommendations"
 * section in the middle of a report doesn't turn into buttons.
 */
export function extractNextSteps(markdown: string): NextStep[] {
  // Code blocks can hold anything: blank them so they read as an ordinary paragraph.
  const lines: string[] = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      lines.push('\u0000code');
      continue;
    }
    lines.push(fenced ? '\u0000code' : line);
  }

  for (let start = lines.length - 1; start >= 0; start -= 1) {
    if (!isIntro(lines[start])) continue;
    const items: string[] = [];
    let indent = -1;
    let i = start + 1;
    while (i < lines.length && !lines[i].trim()) i += 1;
    for (; i < lines.length; i += 1) {
      const line = lines[i];
      const item = ITEM.exec(line);
      if (item && (indent < 0 || item[1].length <= indent)) {
        indent = item[1].length;
        items.push(item[2]);
        continue;
      }
      if (!items.length) break;
      if (!line.trim()) {
        // A blank line ends the list unless another item follows.
        let next = i + 1;
        while (next < lines.length && !lines[next].trim()) next += 1;
        const following = next < lines.length ? ITEM.exec(lines[next]) : null;
        if (following && following[1].length <= indent) {
          i = next - 1;
          continue;
        }
        break;
      }
      // Nested items and wrapped lines belong to the item above; a nested list's details stay out of the prompt.
      if (/^\s{2,}/.test(line)) {
        if (!ITEM.test(line)) items[items.length - 1] += ` ${line.trim()}`;
        continue;
      }
      break;
    }
    if (!items.length) continue;
    const tail = lines.slice(i).filter((line) => line.trim());
    const tailText = tail.join(' ');
    if (tailText.length > MAX_TAIL || tail.some((line) => ITEM.test(line) || HEADING.test(line) || line.startsWith('\u0000'))) return [];
    if (items.length > MAX_STEPS) return [];
    return items.map(toStep).filter((step): step is NextStep => step !== null);
  }
  return [];
}
