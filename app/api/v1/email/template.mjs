// =============================================================================
// email/template.mjs — Report.Farm cinematic email skeleton.
// -----------------------------------------------------------------------------
// Single reusable HTML email shell that every transactional / notification
// template feeds into. Inline-CSS only, no external assets, no JS — works in
// Gmail, Apple Mail, Outlook (desktop + 365 web), Yahoo, ProtonMail.
//
// Brand: deep-space dark background, signal-cyan accents, JetBrains-Mono
// micro-typography (rendered as system fallback fonts in email clients),
// satellite field-signal gradient hero motif.
//
// Renders an HTML body and a plain-text version (RFC-compliant fallback).
// =============================================================================

/**
 * @typedef {Object} EmailButton
 * @property {string} label
 * @property {string} href
 *
 * @typedef {Object} EmailBlock
 * @property {'paragraph'|'heading'|'list'|'panel'|'divider'|'kpi'} kind
 * @property {string} [text]
 * @property {string[]} [items]
 * @property {Array<{ label: string; value: string }>} [rows]
 *
 * @typedef {Object} EmailTemplate
 * @property {string} subject
 * @property {string} preheader      Hidden preview text in inbox preview
 * @property {string} title          Hero title
 * @property {string} [eyebrow]      Tiny uppercase label above the hero title
 * @property {EmailBlock[]} blocks
 * @property {EmailButton} [cta]
 * @property {string} [accent]       Hex accent override
 * @property {string} [footerNote]
 */

const BASE_URL = process.env.PUBLIC_BASE_URL ?? 'https://report.farm';

const BRAND = {
  bg:          '#04060e',
  bg2:         '#080d18',
  panel:       'rgba(8,16,32,0.85)',
  border:      'rgba(60,120,200,0.18)',
  borderH:     'rgba(60,140,255,0.32)',
  t1:          '#e4eaf4',
  t2:          '#8094b4',
  t3:          '#4a6080',
  cyan:        '#00d4ff',
  blue:        '#4d9fff',
  green:       '#00e68a',
  amber:       '#ffb020',
  red:         '#ff4060',
  display:     "'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  sans:        "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  mono:        "'JetBrains Mono', 'SF Mono', 'Consolas', monospace",
};

/**
 * Render a block to inline HTML.
 */
function renderBlock(block, accent) {
  switch (block.kind) {
    case 'heading':
      return `<h2 style="margin:28px 0 10px;font-family:${BRAND.display};font-weight:600;font-size:18px;line-height:1.3;color:${BRAND.t1};">${escape(block.text ?? '')}</h2>`;
    case 'paragraph':
      return `<p style="margin:0 0 16px;font-family:${BRAND.sans};font-size:15px;line-height:1.65;color:${BRAND.t1};">${escape(block.text ?? '')}</p>`;
    case 'list':
      return `<ul style="margin:0 0 18px;padding-left:20px;font-family:${BRAND.sans};font-size:15px;line-height:1.7;color:${BRAND.t1};">${(block.items ?? []).map((i) => `<li style="margin-bottom:6px;">${escape(i)}</li>`).join('')}</ul>`;
    case 'panel':
      return `<div style="margin:18px 0;padding:16px 18px;background:${BRAND.panel};border:1px solid ${BRAND.border};border-left:2px solid ${accent};border-radius:8px;font-family:${BRAND.sans};font-size:14px;line-height:1.6;color:${BRAND.t1};">${escape(block.text ?? '')}</div>`;
    case 'divider':
      return `<div style="height:1px;background:linear-gradient(90deg,transparent,${BRAND.border},transparent);margin:24px 0;"></div>`;
    case 'kpi': {
      const rows = block.rows ?? [];
      return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:16px 0;border-collapse:collapse;font-family:${BRAND.mono};font-size:13px;">${rows.map((r) => `<tr><td style="padding:8px 12px;border-bottom:1px solid ${BRAND.border};color:${BRAND.t3};text-transform:uppercase;letter-spacing:0.08em;font-size:11px;font-weight:600;width:40%;">${escape(r.label)}</td><td style="padding:8px 12px;border-bottom:1px solid ${BRAND.border};color:${BRAND.t1};">${escape(r.value)}</td></tr>`).join('')}</table>`;
    }
    default:
      return '';
  }
}

function escape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Compose the full HTML email.
 * @param {EmailTemplate} t
 * @returns {{ html: string; text: string }}
 */
export function renderEmail(t) {
  const accent = t.accent ?? BRAND.cyan;
  const blocksHtml = (t.blocks ?? []).map((b) => renderBlock(b, accent)).join('');

  const ctaHtml = t.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:28px 0;">
         <tr><td align="center">
           <a href="${escape(t.cta.href)}" style="display:inline-block;padding:14px 28px;background:linear-gradient(120deg,${BRAND.blue},${accent});color:#04060e;text-decoration:none;font-family:${BRAND.sans};font-weight:700;font-size:14px;letter-spacing:0.06em;text-transform:uppercase;border-radius:10px;box-shadow:0 6px 24px rgba(0,212,255,0.25);">${escape(t.cta.label)}</a>
         </td></tr>
       </table>`
    : '';

  const html = `<!doctype html>
<html lang="en" style="margin:0;padding:0;background:${BRAND.bg};">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>${escape(t.subject)}</title>
<style>
  /* Mobile responsive — Gmail strips most <style>, but Apple/Outlook respect this */
  @media only screen and (max-width: 600px) {
    .container { width:100% !important; max-width:100% !important; }
    .px { padding-left:20px !important; padding-right:20px !important; }
    .hero-title { font-size:26px !important; }
  }
  /* Dark-mode friendly: most clients ignore @media (prefers-color-scheme) but apply on background */
  body, table, td, div, p, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};color:${BRAND.t1};font-family:${BRAND.sans};">
  <!-- preheader (hidden inbox preview) -->
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escape(t.preheader)}</div>

  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${BRAND.bg};">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" class="container" style="max-width:600px;width:100%;background:${BRAND.bg2};border:1px solid ${BRAND.border};border-radius:16px;overflow:hidden;">

          <!-- Hero band -->
          <tr>
            <td style="padding:32px 36px 24px;border-bottom:1px solid ${BRAND.border};background:linear-gradient(135deg,rgba(0,212,255,0.08),rgba(77,159,255,0.04),transparent 70%),${BRAND.bg2};">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td>
                    <!-- brand row -->
                    <table role="presentation" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding-right:10px;">
                          <div style="width:28px;height:28px;border-radius:6px;background:linear-gradient(135deg,${BRAND.blue},${BRAND.cyan});display:inline-block;line-height:28px;text-align:center;color:#04060e;font-weight:900;font-size:13px;font-family:${BRAND.sans};">R</div>
                        </td>
                        <td style="vertical-align:middle;">
                          <span style="font-family:${BRAND.mono};font-size:12px;letter-spacing:0.18em;color:${BRAND.t1};text-transform:uppercase;font-weight:700;">REPORT.FARM</span>
                        </td>
                      </tr>
                    </table>
                    ${t.eyebrow ? `<div style="margin-top:22px;font-family:${BRAND.mono};font-size:11px;letter-spacing:0.18em;color:${accent};text-transform:uppercase;font-weight:700;">${escape(t.eyebrow)}</div>` : ''}
                    <h1 class="hero-title" style="margin:8px 0 0;font-family:${BRAND.display};font-weight:600;font-size:30px;line-height:1.15;color:#ffffff;letter-spacing:-0.01em;">${escape(t.title)}</h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td class="px" style="padding:28px 36px;">
              ${blocksHtml}
              ${ctaHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 36px;border-top:1px solid ${BRAND.border};background:${BRAND.bg};">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td style="font-family:${BRAND.mono};font-size:10px;letter-spacing:0.12em;color:${BRAND.t3};text-transform:uppercase;line-height:1.6;">
                    ${t.footerNote ? `<div style="margin-bottom:12px;color:${BRAND.t2};">${escape(t.footerNote)}</div>` : ''}
                    <div>REPORT.FARM · FARM & SUPPLY-CHAIN INTELLIGENCE</div>
                    <div style="margin-top:6px;">
                      <a href="${BASE_URL}/" style="color:${BRAND.t3};text-decoration:none;margin-right:14px;">Home</a>
                      <a href="${BASE_URL}/contact.html" style="color:${BRAND.t3};text-decoration:none;margin-right:14px;">Contact</a>
                      <a href="${BASE_URL}/company.html#privacy" style="color:${BRAND.t3};text-decoration:none;">Privacy</a>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>

        <!-- Below-card micro footer -->
        <div style="margin-top:16px;font-family:${BRAND.mono};font-size:10px;letter-spacing:0.12em;color:${BRAND.t3};text-align:center;text-transform:uppercase;">
          You received this because you contacted Report.Farm or hold an account.
        </div>

      </td>
    </tr>
  </table>
</body>
</html>`;

  // Plain-text fallback (some clients prefer text/plain, all should)
  const text = [
    `[${(t.eyebrow ?? '').toUpperCase()}] ${t.title}`,
    '',
    ...(t.blocks ?? []).map((b) => {
      if (b.kind === 'heading')   return `\n## ${b.text}\n`;
      if (b.kind === 'paragraph') return b.text;
      if (b.kind === 'list')      return (b.items ?? []).map((i) => `  - ${i}`).join('\n');
      if (b.kind === 'panel')     return `> ${b.text}`;
      if (b.kind === 'divider')   return '---';
      if (b.kind === 'kpi')       return (b.rows ?? []).map((r) => `  ${r.label}: ${r.value}`).join('\n');
      return '';
    }),
    '',
    t.cta ? `→ ${t.cta.label}: ${t.cta.href}` : '',
    '',
    '— Report.Farm · Farm & Supply-Chain Intelligence',
    `${BASE_URL}`,
  ].filter(Boolean).join('\n');

  return { html, text };
}

export { BRAND };
