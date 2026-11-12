/**
 * Slack citation helpers.
 *
 * The LLM emits citations as `[source](refN)` / `[source](https://refN.xyz)`.
 * The web UI rewrites those into numbered chips; Slack's markdown→mrkdwn
 * converter turns them into broken `<refN|source>` links. Rewrite resolvable
 * numbered citations and strip remaining tiny-ref links before conversion.
 */

export type SlackCitationLike = {
  citationData: {
    chunkIndex?: string | number;
    metadata: {
      recordId?: string;
      recordType?: string;
      webUrl?: string;
      connector?: string;
      recordName?: string;
    };
  };
};

const FRAGMENT_DIRECTIVE_DELIMITER = ":~:";

/**
 * Drop a text-fragment directive (`:~:text=...`) and keep any anchor before it.
 * Mirrors `strip_fragment_directive` in
 * backend/python/app/utils/text_fragments/url.py: the directive is appended
 * after an existing anchor, so the split is on the first `:~:` in the fragment
 * and not on `#:~:text=`. `:~:` is legal in a path or query, so those are left alone.
 */
export function stripFragmentDirective(url: string): string {
  const fragmentStart = url.indexOf('#');
  const index =
    fragmentStart < 0
      ? -1
      : url.indexOf(FRAGMENT_DIRECTIVE_DELIMITER, fragmentStart + 1);
  if (index < 0) {
    return url;
  }
  const page = url.slice(0, index);
  return page.endsWith("#") ? page.slice(0, -1) : page;
}

/** Keep incomplete Markdown links together until their next streaming chunk arrives. */
export function splitIncompleteSlackLink(text: string): { ready: string; pending: string } {
  for (let start = text.lastIndexOf('['); start >= 0; start = text.lastIndexOf('[', start - 1)) {
    if (start > 0 && text[start - 1] === '\\') continue;
    const tail = text.slice(start);
    if (tail.length > 16000 || tail.includes('\n')) break;
    const close = tail.indexOf(']');
    if (close < 0 || close === tail.length - 1) return { ready: text.slice(0, start), pending: tail };
    if (tail[close + 1] !== '(') break;
    let depth = 0;
    for (let i = close + 1; i < tail.length; i += 1) {
      if (tail[i] === '(') depth += 1;
      if (tail[i] === ')') depth -= 1;
      if (depth === 0) return { ready: text, pending: '' };
    }
    return { ready: text.slice(0, start), pending: tail };
  }
  return { ready: text, pending: '' };
}

export function splitSlackStreamPrefix(text: string, limit: number): number {
  const candidate = text.slice(0, limit);
  const newline = candidate.lastIndexOf('\n');
  let end = newline >= 0 ? newline + 1 : limit;
  const openLink = text.lastIndexOf('<', end - 1);
  if (openLink >= 0 && /^<(?:https?:\/\/|mailto:|tel:|[@#!])/.test(text.slice(openLink))) {
    const closeLink = text.indexOf('>', openLink);
    if (closeLink >= end) end = openLink;
  }
  return end;
}

/** Named links stay in the answer message and are deduplicated across cited chunks. */
export function buildSlackCitationBlocks(citations: SlackCitationLike[] | undefined, frontendBaseUrl: string): Record<string, unknown>[] {
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const records: { name: string; url: string }[] = [];
  for (const citation of citations || []) {
    const meta = citation.citationData.metadata;
    const url = stripFragmentDirective(absolutizeWebUrl(meta.webUrl || '', frontendBaseUrl) || resolveCitationWebUrl(citation, frontendBaseUrl));
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    if (!['http:', 'https:'].includes(parsed.protocol)) continue;
    if ((meta.recordId && seenIds.has(meta.recordId)) || seenUrls.has(url)) continue;
    if (meta.recordId) seenIds.add(meta.recordId);
    seenUrls.add(url);
    const name = (meta.recordName || parsed.hostname || 'Source').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Source';
    records.push({ name, url });
  }
  const blocks: Record<string, unknown>[] = [];
  let elements: Record<string, unknown>[] = [{ type: 'text', text: 'Sources', style: { bold: true } }];
  let size = 7;
  let count = 0;
  for (const record of records) {
    const addedSize = record.name.length + record.url.length + 4;
    if (count && (count === 10 || size + addedSize > 10000)) {
      blocks.push({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements }] });
      elements = [];
      size = 0;
      count = 0;
    }
    elements.push({ type: 'text', text: '\n🔗 ' }, { type: 'link', url: record.url, text: record.name });
    size += addedSize;
    count += 1;
  }
  if (count) blocks.push({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements }] });
  return blocks;
}

/** `[label](refN)` or `[label](https://refN.xyz[/...])` */
const TINY_REF_CITATION_LINK_PATTERN =
  /\[[^\]]*\]\s*\(\s*(?:https?:\/\/)?ref\d+(?:\.xyz)?(?:\/[^)]*)?\s*\)/gi;

/** Any `[N](target)` markdown link; the target may hold balanced parentheses (`/wiki/Python_(language)`). */
const NUMBERED_MARKDOWN_LINK_PATTERN =
  /\[(\d+)\]\(((?:[^()\n]|\([^()\n]*\))+)\)/g;

function parseCitationNumber(rawValue: unknown): number | null {
  if (typeof rawValue === "number" && Number.isInteger(rawValue) && rawValue > 0) {
    return rawValue;
  }
  if (typeof rawValue !== "string") {
    return null;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function normalizeFrontendBaseUrl(frontendBaseUrl: string): string {
  return (frontendBaseUrl || "http://localhost:3000").replace(/\/$/, "");
}

function absolutizeWebUrl(webUrl: string, frontendBaseUrl: string): string {
  const trimmed = webUrl.trim();
  if (!trimmed) {
    return "";
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const base = normalizeFrontendBaseUrl(frontendBaseUrl);
  return trimmed.startsWith("/") ? `${base}${trimmed}` : `${base}/${trimmed}`;
}

function resolveCitationWebUrl(
  citation: SlackCitationLike,
  frontendBaseUrl: string,
): string {
  const meta = citation.citationData.metadata;
  const base = normalizeFrontendBaseUrl(frontendBaseUrl);

  if (meta.recordType === "FILE" && meta.connector !== "WEB" && meta.recordId) {
    return `${base}/record/${meta.recordId}`;
  }

  const fromWebUrl = absolutizeWebUrl(meta.webUrl || "", frontendBaseUrl);
  if (fromWebUrl) {
    return fromWebUrl;
  }

  if (meta.recordId) {
    return `${base}/record/${encodeURIComponent(meta.recordId)}`;
  }

  return "";
}

function isTinyRefTarget(target: string): boolean {
  return /^(?:https?:\/\/)?ref\d+(?:\.xyz)?(?:\/.*)?$/i.test(target.trim());
}

/** Remove `[source](refN)` / `[N](refN)` / tiny-web-ref links. */
export function stripTinyRefCitationLinks(text: string): string {
  if (!text) {
    return "";
  }
  return text.replace(TINY_REF_CITATION_LINK_PATTERN, "");
}

/**
 * Rewrite numbered citation links using citation metadata, then strip any
 * remaining tiny-ref links so markdown→mrkdwn cannot emit `<refN|source>`.
 */
export function rewriteCitationsForSlack(
  answerBody: string,
  citations: SlackCitationLike[] | undefined,
  frontendBaseUrl: string,
): string {
  if (!answerBody) {
    return "";
  }

  const citationNumberToUrl = new Map<number, string>();
  for (const citation of citations || []) {
    const citationNumber = parseCitationNumber(citation.citationData.chunkIndex);
    if (!citationNumber || citationNumberToUrl.has(citationNumber)) {
      continue;
    }
    const citationWebUrl = resolveCitationWebUrl(citation, frontendBaseUrl);
    if (!citationWebUrl) {
      continue;
    }
    citationNumberToUrl.set(citationNumber, citationWebUrl);
  }

  let citationCount = 1;
  const webUrlToDisplayNumber = new Map<string, number>();

  let text = answerBody.replace(
    NUMBERED_MARKDOWN_LINK_PATTERN,
    (match, citationNumberText: string, target: string) => {
      const citationNumber = Number.parseInt(citationNumberText, 10);
      if (!Number.isInteger(citationNumber) || citationNumber <= 0) {
        return match;
      }

      const mappedUrl = citationNumberToUrl.get(citationNumber);
      if (mappedUrl) {
        let displayNumber = webUrlToDisplayNumber.get(mappedUrl);
        if (displayNumber === undefined) {
          displayNumber = citationCount;
          webUrlToDisplayNumber.set(mappedUrl, citationCount);
          citationCount += 1;
        }
        // Encoded so the mrkdwn link conversion, which ends a URL at the first ')', keeps it whole.
        return `[［${displayNumber}］](${mappedUrl.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
      }

      // Unmapped tiny refs become broken Slack links — drop them.
      if (isTinyRefTarget(target)) {
        return "";
      }

      return match;
    },
  );

  return stripTinyRefCitationLinks(text);
}
