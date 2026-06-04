export function markdownToHtml(md: string): string {
  if (!md) return '';
  let html = md;

  // Escape HTML entities first (except we want to allow our output through)
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Fenced code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre><code>${code.trimEnd()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

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
    } else if (/^<(h[1-6]|ul|ol|li|pre|hr|blockquote)/.test(trimmed)) {
      result.push(line);
      i++;
    } else {
      // Collect paragraph lines
      const para: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const t = l.trim();
        if (t === '' || /^<(h[1-6]|ul|ol|li|pre|hr|blockquote)/.test(t)) break;
        para.push(l);
        i++;
      }
      result.push(`<p>${para.join(' ')}</p>`);
    }
  }

  return result.join('\n');
}
