import 'reflect-metadata';
import { expect } from 'chai';
import {
  rewriteCitationsForSlack,
  stripFragmentDirective,
  buildSlackCitationBlocks,
  splitIncompleteSlackLink,
  splitSlackStreamPrefix,
  stripTinyRefCitationLinks,
} from '../../../src/integrations/slack-bot/src/utils/citations';
import { markdownToSlackMrkdwn } from '../../../src/integrations/slack-bot/src/utils/md_to_mrkdwn';
import { buildFinalSlackChunks, splitSlackBlocksByLimit } from '../../../src/integrations/slack-bot/src/helpers';

describe('slack-bot citations: stripFragmentDirective', () => {
  it('returns urls without a directive unchanged', () => {
    expect(stripFragmentDirective('https://example.com/page')).to.equal('https://example.com/page');
    expect(stripFragmentDirective('https://example.com/page#section')).to.equal(
      'https://example.com/page#section',
    );
  });

  it('removes a bare directive and the dangling hash', () => {
    expect(stripFragmentDirective('https://example.com/page#:~:text=hello%20world,end')).to.equal(
      'https://example.com/page',
    );
  });

  it('keeps an anchor that precedes the directive', () => {
    expect(stripFragmentDirective('https://example.com/page#section:~:text=hello')).to.equal(
      'https://example.com/page#section',
    );
    expect(
      stripFragmentDirective('https://mail.google.com/mail?authuser=a@b.com#all/m1:~:text=Junior%20Process'),
    ).to.equal('https://mail.google.com/mail?authuser=a@b.com#all/m1');
  });

  it('drops everything after the first delimiter, including extra directives', () => {
    expect(stripFragmentDirective('https://example.com/p#a:~:text=x&text=y')).to.equal(
      'https://example.com/p#a',
    );
  });

  it('leaves the delimiter alone in a path or query', () => {
    expect(stripFragmentDirective('https://example.com/search?q=a:~:b')).to.equal(
      'https://example.com/search?q=a:~:b',
    );
    expect(stripFragmentDirective('https://example.com/search?q=a:~:b#:~:text=hello')).to.equal(
      'https://example.com/search?q=a:~:b',
    );
  });

  it('handles percent-encoded hyphens and commas in the directive', () => {
    expect(stripFragmentDirective('https://example.com/p#:~:text=e%2Dmail,Q3%2C%20done')).to.equal(
      'https://example.com/p',
    );
  });
});

describe('Slack streaming links', () => {
  it('waits for a reference split at every character before rendering it', () => {
    const text = 'A finding [1](https://ref1.xyz) is useful.';
    let pending = '';
    let emitted = '';
    for (const char of text) {
      const result = splitIncompleteSlackLink(pending + char);
      emitted += result.ready;
      pending = result.pending;
    }
    expect(emitted + pending).to.equal(text);
    expect(pending).to.equal('');
    expect(markdownToSlackMrkdwn(stripTinyRefCitationLinks(emitted))).not.to.contain('<https://ref1.xyz|');
  });

  it('keeps long URLs and balanced parentheses intact across flushes', () => {
    const first = splitIncompleteSlackLink('See [report](https://example.com/' + 'a'.repeat(2500));
    expect(first.ready).to.equal('See ');
    const second = splitIncompleteSlackLink(first.pending + '_(2026)) now');
    expect(second.pending).to.equal('');
    expect(markdownToSlackMrkdwn(second.ready)).to.contain('|report>');
  });

  it('does not hold unrelated or excessively long incomplete text indefinitely', () => {
    expect(splitIncompleteSlackLink('literal [x] next').pending).to.equal('');
    expect(splitIncompleteSlackLink('[' + 'a'.repeat(16001)).pending).to.equal('');
  });

  it('rolls over before a link instead of cutting it across Slack messages', () => {
    const chunk = 'Text <https://example.com/long|source> continues';
    expect(splitSlackStreamPrefix(chunk, 18)).to.equal(5);
    expect(splitSlackStreamPrefix(chunk.slice(5), 10)).to.equal(0);
  });

  it('keeps link separators and ampersands safe in Slack mrkdwn', () => {
    expect(markdownToSlackMrkdwn('[A|B](https://example.com/?a=1&b=2|3)')).to.equal(
      '<https://example.com/?a=1&amp;b=2%7C3|A¦B>',
    );
  });
});

describe('Slack named sources', () => {
  it('uses compact named rich links, deduplicates records and includes web-only sources', () => {
    const make = (metadata: { recordId?: string; recordName?: string; webUrl?: string }) => ({ citationData: { metadata } });
    const blocks = buildSlackCitationBlocks([
      make({ recordId: 'r1', recordName: 'Report & plan', webUrl: 'https://example.com/doc#part:~:text=one' }),
      make({ recordId: 'r1', recordName: 'Duplicate', webUrl: 'https://example.com/doc#part:~:text=two' }),
      make({ recordName: 'Web page', webUrl: 'https://example.org/?a=1&b=2' }),
      make({ recordId: 'r3', recordName: '<!channel>', webUrl: '/record/r3' }),
    ], 'https://brain.example');
    const elements = (blocks[0].elements as Array<{ elements: Array<Record<string, unknown>> }>)[0].elements;
    const links = elements.filter((e) => e.type === 'link');
    expect(links).to.deep.equal([
      { type: 'link', url: 'https://example.com/doc#part', text: 'Report & plan' },
      { type: 'link', url: 'https://example.org/?a=1&b=2', text: 'Web page' },
      { type: 'link', url: 'https://brain.example/record/r3', text: '<!channel>' },
    ]);
    expect(buildSlackCitationBlocks([], 'https://brain.example')).to.deep.equal([]);
  });

  it('splits source blocks before the message payload limit for long URLs', () => {
    const citations = Array.from({ length: 6 }, (_, i) => ({ citationData: { metadata: {
      recordId: String(i), recordName: `Source ${i}`, webUrl: `https://example.com/${i}/${'a'.repeat(2400)}`,
    } } }));
    const blocks = buildSlackCitationBlocks(citations, 'https://brain.example');
    expect(blocks.length).to.be.greaterThan(1);
    expect(JSON.stringify(blocks)).to.contain('a'.repeat(2400));
  });

  it('keeps a long reference clickable in final chunks and attaches sources to the answer', async () => {
    const url = `https://example.com/${'a'.repeat(4000)}?x=1&y=2`;
    const citation = { citationData: { chunkIndex: 1, metadata: { recordName: 'Research', webUrl: url } } };
    const answer = rewriteCitationsForSlack('See the report [1](ref1).', [citation], 'https://brain.example');
    const answerBlocks = (await buildFinalSlackChunks(answer)).flat();
    const sources = buildSlackCitationBlocks([citation], 'https://brain.example');
    const final = splitSlackBlocksByLimit([...answerBlocks, ...sources]);
    const rendered = JSON.stringify(final);
    expect(rendered).to.contain(url);
    expect(rendered).to.contain('Research');
    expect(rendered).to.contain('See the report');
  });

  it('does not split a link at the section limit', async () => {
    const url = `https://example.com/${'a'.repeat(1900)}`;
    const chunks = await buildFinalSlackChunks(`${'A'.repeat(2000)} [Read this](${url})`);
    const sections = chunks.flat().filter((block: { type: string }) => block.type === 'section');
    const link = `<${url}|Read this>`;
    expect(sections.some((block: { text: { text: string } }) => block.text.text.includes(link))).to.equal(true);
  });
});

describe('slack-bot citations: rewriteCitationsForSlack', () => {
  const wiki = 'https://en.wikipedia.org/wiki/Python_(programming_language)#:~:text=Python%202.0%20was%20released';
  const webCitation = { citationData: { chunkIndex: 1, metadata: { webUrl: wiki, connector: 'WEB' } } };
  const fileCitation = {
    citationData: { chunkIndex: 2, metadata: { recordId: 'abc-123', recordType: 'FILE', connector: 'CONFLUENCE' } },
  };

  it('replaces a citation whose URL has parentheses without leaving its tail in the text', () => {
    const out = rewriteCitationsForSlack(`Python 3.0 shipped in 2008 [1](${wiki}).`, [webCitation], 'https://app.test');
    expect(out).to.equal(`Python 3.0 shipped in 2008 [1](${wiki.replace(/\(/g, '%28').replace(/\)/g, '%29')}).`);
  });

  it('keeps the whole URL in the Slack link once converted to mrkdwn', () => {
    const md = rewriteCitationsForSlack(`Python 3.0 shipped in 2008 [1](${wiki}).`, [webCitation], 'https://app.test');
    const mrkdwn = markdownToSlackMrkdwn(md);
    const encoded = wiki.replace(/\(/g, '%28').replace(/\)/g, '%29');
    expect(mrkdwn).to.equal(`Python 3.0 shipped in 2008 <${encoded}|1>.`);
  });

  it('still maps a connector record citation to its record page', () => {
    const out = rewriteCitationsForSlack('Q3 grew [2](/record/abc-123/preview#blockIndex=4).', [fileCitation], 'https://app.test');
    expect(out).to.equal('Q3 grew [1](https://app.test/record/abc-123).');
  });
});
