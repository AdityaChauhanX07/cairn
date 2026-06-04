export function markdownToHtml(md: string): string {
  if (!md) return '';
  let html = md;

  // Escape HTML entities first (except we want to allow our output through)
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Fenced code blocks (``` ... ```) — pull them out into placeholders BEFORE
  // any line-based processing. The paragraph-wrapper below splits on newlines,
  // so a multi-line <pre> left inline would have its inner lines collapsed into
  // a paragraph. Stashing the rendered block behind a single-line sentinel
  // keeps newlines and indentation intact (e.g. the alert dependency trees).
  const codeBlocks: string[] = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${code.trimEnd()}</code></pre>`);
    // Isolated on its own line so the paragraph-wrapper treats it as a block.
    return `\n\nCAIRNCODEBLOCK${idx}\n\n`;
  });

  // A line is "block-level" (must not be wrapped in <p>) if it's already a
  // block tag or one of our code-block placeholders. Checked against the
  // trimmed line, so the placeholder pattern carries no surrounding spaces.
  const isBlockLine = (t: string): boolean =>
    /^<(h[1-6]|ul|ol|li|pre|hr|blockquote)/.test(t) ||
    /^CAIRNCODEBLOCK\d+$/.test(t);

  // Inline code — rendered as clickable Splunk-object chips. The raw inner text
  // is stashed in data-term (quotes escaped for the attribute) so click handlers
  // in GuideView / ChatView can resolve it to a section or graph node. Fenced
  // blocks were already pulled out above, so this only touches true inline code.
  html = html.replace(/`([^`]+)`/g, (_m, code) => {
    const term = code.replace(/"/g, '&quot;');
    return `<code class="chip-clickable" data-term="${term}">${code}</code>`;
  });

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold + italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr />');

  // Unordered lists — group consecutive list items
  html = html.replace(/((?:^[ \t]*[-*+] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(line =>
      `<li>${line.replace(/^[ \t]*[-*+] /, '').trim()}</li>`
    ).join('\n');
    return `<ul>\n${items}\n</ul>\n`;
  });

  // Ordered lists
  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(line =>
      `<li>${line.replace(/^\d+\. /, '').trim()}</li>`
    ).join('\n');
    return `<ol>\n${items}\n</ol>\n`;
  });

  // Paragraphs — wrap non-tagged lines
  const lines = html.split('\n');
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '') {
      result.push('');
      i++;
    } else if (isBlockLine(trimmed)) {
      result.push(line);
      i++;
    } else {
      // Collect paragraph lines
      const para: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const t = l.trim();
        if (t === '' || isBlockLine(t)) break;
        para.push(l);
        i++;
      }
      result.push(`<p>${para.join(' ')}</p>`);
    }
  }

  html = result.join('\n');

  // Restore code blocks now that line-based processing is done.
  html = html.replace(/CAIRNCODEBLOCK(\d+)/g, (_m, idx) => codeBlocks[Number(idx)] ?? '');

  return html;
}
