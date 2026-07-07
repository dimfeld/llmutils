import { describe, expect, test } from 'vitest';

import {
  buildArtifactCommentBody,
  buildFullReportHtml,
  buildPlanArtifactsCommentMarker,
  type UploadedArtifactForComment,
} from './upload_artifacts_comment.js';

const UPDATED_AT = '2026-06-10T12:34:56.000Z';
const MARKER = buildPlanArtifactsCommentMarker('plan-uuid-384');

function artifact(overrides: Partial<UploadedArtifactForComment>): UploadedArtifactForComment {
  return {
    filename: 'screenshot.png',
    mimeType: 'image/png',
    url: 'https://media.example.test/tim/plans/plan/artifact/screenshot.png?sig=abc',
    size: 1536,
    ...overrides,
  };
}

function buildBody(
  overrides: Partial<Parameters<typeof buildArtifactCommentBody>[0]> = {}
): string {
  return buildArtifactCommentBody({
    marker: MARKER,
    planId: 384,
    planTitle: 'Upload artifacts to PR comment',
    artifacts: [],
    updatedAt: UPDATED_AT,
    ...overrides,
  });
}

describe('buildArtifactCommentBody', () => {
  test('starts with the marker and uses the review-guide updated-at footer convention', () => {
    const body = buildBody();

    expect(body.startsWith(`${MARKER}\n`)).toBe(true);
    expect(body).toContain('# Artifacts for plan 384: Upload artifacts to PR comment');
    expect(body).toContain(`---\n<sub>Updated at ${UPDATED_AT}</sub>`);
  });

  test('uses report markdown as the body and does not list report.md artifacts', () => {
    const body = buildBody({
      reportMarkdown: '# Proof Report\n\nEverything passed.',
      artifacts: [
        artifact({
          filename: 'report.md',
          mimeType: 'text/markdown',
          url: 'https://media.example.test/report.md?sig=abc',
          size: 128,
        }),
      ],
    });

    expect(body).toContain('# Proof Report\n\nEverything passed.');
    expect(body).not.toContain('# Artifacts for plan');
    expect(body).not.toContain('[report.md]');
    expect(body).not.toContain('## Artifacts');
  });

  test('rewrites real relative markdown links by relative path and deduplicates referenced artifacts', () => {
    const body = buildBody({
      reportMarkdown:
        '# Proof\n\n![Screenshot](./screenshots/after.png)\n\n[Transcript](logs/run.log)\n',
      artifacts: [
        artifact({
          filename: 'after.png',
          relativePath: 'screenshots/after.png',
          url: 'https://media.example.test/after.png?sig=abc',
        }),
        artifact({
          filename: 'run.log',
          mimeType: 'text/plain',
          relativePath: 'logs/run.log',
          url: 'https://media.example.test/run.log?sig=abc',
          size: 2048,
        }),
      ],
    });

    expect(body).toContain('![Screenshot](https://media.example.test/after.png?sig=abc)');
    expect(body).toContain('[Transcript](https://media.example.test/run.log?sig=abc)');
    expect(body).not.toContain('![after.png]');
    expect(body).not.toContain('[run.log]');
    expect(body).not.toContain('## Artifacts');
  });

  test('rewrites titled relative markdown links and preserves titles', () => {
    const body = buildBody({
      reportMarkdown:
        '# Proof\n\n![Screenshot](screenshot.png "after")\n\n[log](logs/run.log \'details\')\n',
      artifacts: [
        artifact({
          filename: 'screenshot.png',
          url: 'https://media.example.test/screenshot.png?sig=abc',
        }),
        artifact({
          filename: 'run.log',
          mimeType: 'text/plain',
          relativePath: 'logs/run.log',
          url: 'https://media.example.test/logs/run.log?sig=abc',
          size: 2048,
        }),
      ],
    });

    expect(body).toContain(
      '![Screenshot](https://media.example.test/screenshot.png?sig=abc "after")'
    );
    expect(body).toContain("[log](https://media.example.test/logs/run.log?sig=abc 'details')");
    expect(body).not.toContain('![screenshot.png]');
    expect(body).not.toContain('[run.log]');
    expect(body).not.toContain('## Artifacts');
  });

  test('rewrites angle-bracket image destinations containing spaces and parentheses', () => {
    const body = buildBody({
      reportMarkdown: '# Proof\n\n![Screenshot](<Screenshot (1).png>)\n',
      artifacts: [
        artifact({
          filename: 'Screenshot (1).png',
          url: 'https://media.example.test/Screenshot%20(1).png?sig=abc',
        }),
      ],
    });

    expect(body).toContain(
      '![Screenshot](<https://media.example.test/Screenshot%20%281%29.png?sig=abc>)'
    );
    expect(body).not.toContain('![Screenshot](<Screenshot (1).png>)');
    expect(body).not.toContain('## Artifacts');
  });

  test('rewrites image destinations containing adjacent parentheses', () => {
    const body = buildBody({
      reportMarkdown: '# Proof\n\n![Screenshot](Screenshot(1).png)\n',
      artifacts: [
        artifact({
          filename: 'Screenshot(1).png',
          url: 'https://media.example.test/Screenshot(1).png?sig=abc',
        }),
      ],
    });

    expect(body).toContain(
      '![Screenshot](https://media.example.test/Screenshot%281%29.png?sig=abc)'
    );
    expect(body).not.toContain('![Screenshot](Screenshot(1).png)');
    expect(body).not.toContain('## Artifacts');
  });

  test('rewrites link destinations containing balanced parentheses', () => {
    const body = buildBody({
      reportMarkdown: '# Proof\n\n[log](logs/run(final).txt)\n',
      artifacts: [
        artifact({
          filename: 'run(final).txt',
          mimeType: 'text/plain',
          relativePath: 'logs/run(final).txt',
          url: 'https://media.example.test/logs/run(final).txt?sig=abc',
        }),
      ],
    });

    expect(body).toContain('[log](https://media.example.test/logs/run%28final%29.txt?sig=abc)');
    expect(body).not.toContain('[log](logs/run(final).txt)');
    expect(body).not.toContain('## Artifacts');
  });

  test('leaves malformed bare destinations with spaces unchanged and lists the artifact', () => {
    const body = buildBody({
      reportMarkdown: '# Proof\n\n![Screenshot](Screenshot (1).png)\n',
      artifacts: [
        artifact({
          filename: 'Screenshot (1).png',
          url: 'https://media.example.test/Screenshot%20(1).png?sig=abc',
        }),
      ],
    });

    expect(body).toContain('![Screenshot](Screenshot (1).png)');
    expect(body).toContain('## Artifacts');
    expect(body).toContain('**Screenshot (1).png**');
    expect(body).toContain(
      '![Screenshot (1).png](https://media.example.test/Screenshot%20%281%29.png?sig=abc)'
    );
  });

  test('matches report links by basename after relative path matching', () => {
    const body = buildBody({
      reportMarkdown: 'See ![Screenshot](nested/screenshot.png).',
      artifacts: [
        artifact({
          filename: 'screenshot.png',
          url: 'https://media.example.test/screenshot.png?sig=abc',
        }),
      ],
    });

    expect(body).toContain('![Screenshot](https://media.example.test/screenshot.png?sig=abc)');
    expect(body).not.toContain('## Artifacts');
  });

  test('leaves absolute URLs and code-span mentions untouched and lists unreferenced artifacts', () => {
    const body = buildBody({
      reportMarkdown:
        'Existing ![remote](https://example.com/remote.png) and `screenshot.png` mention.',
      artifacts: [
        artifact({
          filename: 'screenshot.png',
          url: 'https://media.example.test/screenshot.png?sig=abc',
        }),
      ],
    });

    expect(body).toContain('![remote](https://example.com/remote.png)');
    expect(body).toContain('`screenshot.png`');
    expect(body).toContain('## Artifacts');
    expect(body).toContain('**screenshot.png**');
    expect(body).toContain('![screenshot.png](https://media.example.test/screenshot.png?sig=abc)');
  });

  test('renders trailing images as embeds and other artifacts as links', () => {
    const body = buildBody({
      artifacts: [
        artifact({
          filename: 'screenshot.png',
          mimeType: 'image/png',
          url: 'https://media.example.test/screenshot.png?sig=abc',
          size: 1536,
        }),
        artifact({
          filename: 'demo.mp4',
          mimeType: 'video/mp4',
          url: 'https://media.example.test/demo.mp4?sig=abc',
          size: 2_097_152,
        }),
        artifact({
          filename: 'capture.mov',
          mimeType: 'video/quicktime',
          url: 'https://media.example.test/capture.mov?sig=abc',
          size: 4096,
        }),
        artifact({
          filename: 'notes.pdf',
          mimeType: 'application/pdf',
          url: 'https://media.example.test/notes.pdf?sig=abc',
          size: 512,
        }),
      ],
    });

    expect(body).toContain('**screenshot.png**');
    expect(body).toContain('![screenshot.png](https://media.example.test/screenshot.png?sig=abc)');
    expect(body).toContain('- [demo.mp4](https://media.example.test/demo.mp4?sig=abc) (2.0 MB)');
    expect(body).not.toContain('<video src="https://media.example.test/capture.mov?sig=abc"');
    expect(body).toContain(
      '- [capture.mov](https://media.example.test/capture.mov?sig=abc) (4.0 KB)'
    );
    expect(body).toContain('- [notes.pdf](https://media.example.test/notes.pdf?sig=abc) (512 B)');
  });

  test('falls back to a links-only body when the assembled comment exceeds GitHub limits', () => {
    const body = buildBody({
      reportMarkdown: `# Report\n\n${'long report line\n'.repeat(5000)}`,
      artifacts: [
        artifact({
          filename: 'screenshot.png',
          mimeType: 'image/png',
          url: 'https://media.example.test/screenshot.png?sig=abc',
          size: 1536,
        }),
      ],
    });

    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain('Some artifact comment content was omitted');
    expect(body).not.toContain('long report line');
    expect(body).toContain('- [screenshot.png](https://media.example.test/screenshot.png?sig=abc)');
    expect(body).toContain(`---\n<sub>Updated at ${UPDATED_AT}</sub>`);
  });

  test('truncates artifact list with a notice when even the links-only body exceeds 65 KB', () => {
    // Create enough artifacts with long URLs to blow past 65 KB even in links-only mode.
    const longUrl = `https://media.example.test/${'a'.repeat(500)}.png?sig=abc`;
    const artifacts = Array.from({ length: 200 }, (_, i) =>
      artifact({
        filename: `screenshot-${i}.png`,
        mimeType: 'image/png',
        url: longUrl,
        size: 1536,
      })
    );

    const body = buildBody({ artifacts });

    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain('Some artifact comment content was omitted');
    expect(body).toContain('Additional artifacts omitted.');
    expect(body.startsWith(`${MARKER}\n`)).toBe(true);
    expect(body).toContain(`---\n<sub>Updated at ${UPDATED_AT}</sub>`);
  });

  test('clamps the body under the limit even when the header (planTitle) alone exceeds it', () => {
    const body = buildBody({
      planTitle: 'x'.repeat(70_000),
      artifacts: [artifact({ filename: 'a.png', mimeType: 'image/png' })],
    });

    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body.startsWith(MARKER)).toBe(true);
  });

  test('produces no Artifacts section when there are no artifacts and no report', () => {
    const body = buildBody({ artifacts: [] });

    expect(body).toContain('# Artifacts for plan 384: Upload artifacts to PR comment');
    expect(body).not.toContain('## Artifacts');
    expect(body).toContain(`---\n<sub>Updated at ${UPDATED_AT}</sub>`);
  });

  test('excludes report.md artifact from the trailing list even without reportMarkdown', () => {
    const body = buildBody({
      artifacts: [
        artifact({
          filename: 'report.md',
          mimeType: 'text/markdown',
          url: 'https://media.example.test/report.md?sig=abc',
          size: 128,
        }),
        artifact({
          filename: 'extra.png',
          mimeType: 'image/png',
          url: 'https://media.example.test/extra.png?sig=abc',
          size: 256,
        }),
      ],
    });

    expect(body).not.toContain('[report.md]');
    expect(body).toContain('## Artifacts');
    expect(body).toContain('**extra.png**');
    expect(body).toContain('![extra.png](https://media.example.test/extra.png?sig=abc)');
  });

  test('leaves protocol-relative, root-relative, anchor, and mailto links untouched', () => {
    const body = buildBody({
      reportMarkdown: [
        '![a](//cdn.example.com/img.png)',
        '![b](/static/img.png)',
        '[email](mailto:user@example.com)',
        '[section](#heading)',
      ].join('\n'),
      artifacts: [artifact()],
    });

    expect(body).toContain('![a](//cdn.example.com/img.png)');
    expect(body).toContain('![b](/static/img.png)');
    expect(body).toContain('[email](mailto:user@example.com)');
    expect(body).toContain('[section](#heading)');
  });

  test('renders video/webm as a trailing artifact link', () => {
    const body = buildBody({
      artifacts: [
        artifact({
          filename: 'demo.webm',
          mimeType: 'video/webm',
          url: 'https://media.example.test/demo.webm?sig=abc',
          size: 1_048_576,
        }),
      ],
    });

    expect(body).toContain('- [demo.webm](https://media.example.test/demo.webm?sig=abc) (1.0 MB)');
  });

  // ── Markdown URL escaping regression tests ────────────────────────────────

  test('escapes literal parentheses in trailing artifact link URLs', () => {
    // URL contains literal `(` and `)` which would break Markdown `[..](..)` syntax
    const url = 'https://media.example.test/Screenshot(1).png?sig=abc';
    const body = buildBody({
      artifacts: [
        artifact({
          filename: 'Screenshot(1).png',
          mimeType: 'image/png',
          url,
        }),
      ],
    });

    // The destination must not contain literal parens
    const linkMatch = body.match(/\[Screenshot\(1\)\.png\]\(([^)]*%2[89][^)]*)\)/);
    expect(linkMatch).toBeTruthy();
    expect(body).not.toMatch(/\[Screenshot\(1\)\.png\]\([^)]*\([^)]*\)/);
    expect(body).toContain('%28');
    expect(body).toContain('%29');
  });

  test('adds full report links above and below the report body', () => {
    const body = buildBody({
      reportMarkdown: '# Proof Report\n\nEverything passed.',
      fullReportUrl: 'https://media.example.test/report/index.html/sig=abc',
    });

    expect(body).toContain(`${MARKER}\n\n[View on Web]`);
    expect(body.match(/\[View on Web\]/g)).toHaveLength(2);
    expect(body.indexOf('[View on Web]')).toBeLessThan(body.indexOf('# Proof Report'));
    expect(body.lastIndexOf('[View on Web]')).toBeGreaterThan(body.indexOf('# Proof Report'));
    expect(body).not.toContain('View full report');
  });

  test('can place trailing artifacts below the lower full report link', () => {
    const body = buildBody({
      reportMarkdown: '# Proof Report\n\nEverything passed.',
      fullReportUrl: 'https://media.example.test/report/index.html/sig=abc',
      artifactListPlacement: 'before-footer',
      artifacts: [
        artifact({
          filename: 'extra.png',
          url: 'https://media.example.test/extra.png?sig=abc',
        }),
      ],
    });

    expect(body.lastIndexOf('[View on Web]')).toBeLessThan(body.indexOf('## Artifacts'));
    expect(body.indexOf('## Artifacts')).toBeLessThan(body.indexOf('---\n<sub>Updated at'));
  });

  test('builds a standalone rendered full report html document', () => {
    const html = buildFullReportHtml({
      planId: 384,
      planTitle: 'Upload artifacts to PR comment',
      reportMarkdown: '# Proof\n\n![Screenshot](screenshot.png)',
      artifacts: [
        artifact({
          filename: 'screenshot.png',
          url: 'https://media.example.test/screenshot.png/sig=abc',
        }),
        artifact({
          filename: 'extra.png',
          url: 'https://media.example.test/extra.png/sig=abc',
          size: 256,
        }),
        artifact({
          filename: 'run.log',
          mimeType: 'text/plain',
          url: 'https://media.example.test/run.log/sig=abc',
          size: 2048,
        }),
      ],
      updatedAt: UPDATED_AT,
    });

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('color-scheme:light dark');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain('--page-bg:#0d1117');
    expect(html).toContain('<h1>Proof</h1>');
    expect(html).toContain(
      '<a href="https://media.example.test/screenshot.png/sig=abc" target="_blank" rel="noopener noreferrer"><img src="https://media.example.test/screenshot.png/sig=abc" alt="Screenshot"></a>'
    );
    expect(html).toContain('<h2>Artifacts</h2>');
    expect(html).toContain(
      '<div class="artifact-name">extra.png <span class="artifact-meta">(256 B)</span></div>'
    );
    expect(html).toContain(
      '<a href="https://media.example.test/extra.png/sig=abc" target="_blank" rel="noopener noreferrer"><img src="https://media.example.test/extra.png/sig=abc" alt="extra.png"></a>'
    );
    expect(html).not.toContain('<li><a href="https://media.example.test/extra.png/sig=abc"');
    expect(html).toContain(
      '<div class="artifact-name"><a href="https://media.example.test/run.log/sig=abc">run.log</a> <span class="artifact-meta">(2.0 KB)</span></div>'
    );
    expect(html).not.toContain('<a href="https://media.example.test/run.log/sig=abc" target=');
    expect(html.match(/target="_blank" rel="noopener noreferrer"><img/g)).toHaveLength(2);
    expect(html).not.toContain('![screenshot.png]');
    expect(html).not.toContain('[screenshot.png]');
    expect(html).toContain('href="https://media.example.test/run.log/sig=abc"');
    expect(html).toContain(`Updated at ${UPDATED_AT}`);
  });

  test('escapes literal parentheses in download link URLs', () => {
    const url = 'https://media.example.test/report(final).pdf?sig=abc';
    const body = buildBody({
      artifacts: [
        artifact({
          filename: 'report(final).pdf',
          mimeType: 'application/pdf',
          url,
          size: 1024,
        }),
      ],
    });

    // The Markdown link destination must have %28/%29 instead of literal parens
    expect(body).toContain('%28');
    expect(body).toContain('%29');
    expect(body).not.toMatch(/\[report\(final\)\.pdf\]\([^)]*\([^)]*\)/);
  });

  test('escapes literal parentheses in rewritten report.md link destinations', () => {
    // The signed URL for a plain artifact contains literal parens (e.g. the media host didn't
    // encode them). The rewritten report link destination must escape them.
    const url = 'https://media.example.test/screenshot.png?sig=abc(x)';
    const body = buildBody({
      reportMarkdown: '![Screenshot](screenshot.png)',
      artifacts: [
        artifact({
          filename: 'screenshot.png',
          mimeType: 'image/png',
          url,
        }),
      ],
    });

    // The relative reference must have been rewritten to the signed URL
    expect(body).not.toContain('![Screenshot](screenshot.png)');
    // And the signed URL destination must not contain bare parens
    const destMatch = body.match(/!\[Screenshot\]\(([^)]+%2[89][^)]*)\)/);
    expect(destMatch).toBeTruthy();
    expect(body).toContain('%28');
    expect(body).toContain('%29');
  });
});
