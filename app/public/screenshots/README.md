# Marketing screenshots

This directory holds the WebP product screenshots that get swapped into the
`[data-screenshot="<slug>"]` placeholders across the six marketing pages.

## Slugs in use

| Slug                          | Used by                                   |
| ----------------------------- | ----------------------------------------- |
| `hero-dashboard`              | `mvp/index.html` — hero                   |
| `mission-leak`                | `mvp/index.html` — Mission · Leak         |
| `mission-recovery`            | `mvp/index.html` — Mission · Recovery     |
| `mission-risk`                | `mvp/index.html` — Mission · Risk         |
| `solutions-overview`          | `mvp/solutions.html` — hero               |
| `solutions-leak-detection`    | `mvp/solutions.html` — deep-dive 01       |
| `solutions-asset-recovery`    | `mvp/solutions.html` — deep-dive 02       |
| `solutions-infra-risk`        | `mvp/solutions.html` — deep-dive 03       |
| `solutions-physical-ai`       | `mvp/solutions.html` — deep-dive 04       |
| `solutions-integration`       | `mvp/solutions.html` — deep-dive 05       |
| `solutions-operations`        | `mvp/solutions.html` — deep-dive 06       |
| `industries-overview`         | `mvp/industries.html` — hero              |
| `industries-water`            | `mvp/industries.html` — Water Utilities   |
| `industries-oil-gas`          | `mvp/industries.html` — Oil & Gas         |
| `industries-power`            | `mvp/industries.html` — Power             |
| `industries-defense`          | `mvp/industries.html` — Defense           |
| `industries-insurance`        | `mvp/industries.html` — Insurance         |
| `industries-asset-finance`    | `mvp/industries.html` — Asset Finance     |
| `platform-command-center`     | `mvp/platform.html` — #command-center     |

## Regenerate

```bash
# 1. one-time install (Playwright is intentionally NOT in package.json)
npm i -D playwright @playwright/test
npx playwright install chromium

# 2. start the dev server in another terminal
npm run dev

# 3. capture all targets
node scripts/capture-screenshots.mjs

# alternate base URL
BASE_URL=http://localhost:5275 node scripts/capture-screenshots.mjs
```

Output lands at `mvp/public/screenshots/<slug>.webp` (quality 88).

## Authenticated captures

The capture script does NOT currently inject a session cookie. Any target
pointing at `/dashboard.html` will hit the gate. To capture authenticated
states, edit `scripts/capture-screenshots.mjs` and add a cookie via
`context.addCookies([...])` before `page.goto()`.

## Wiring screenshots into the HTML

Once a slug is captured, swap the placeholder div for an `<img>`:

```html
<img
  src="./public/screenshots/<slug>.webp"
  alt="<descriptive alt>"
  loading="lazy"
  width="1600" height="900"
  data-screenshot="<slug>"
/>
```

The `data-screenshot` attribute stays for traceability.
