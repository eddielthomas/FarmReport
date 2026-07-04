# RWR CRM Design Tokens — S7A

This folder owns the **single source of truth** for the new design kit. Every
primitive in `mvp/src/crm/components/ui/*` must consume tokens declared here.
Pages may use Tailwind utilities or `var(--…)` references; they must not
hard-code hex values.

## Files

| File                | Role                                                           |
| ------------------- | -------------------------------------------------------------- |
| `tokens.css`        | CSS custom properties. Scoped to `.crm` wrapper.               |
| `tokens.types.ts`   | TS string-literal unions + `tokenVar()` helper.                |
| `README.md`         | This document.                                                 |

Surface mode (`light` | `dark`) is selected by `data-surface` on the document
element via the `useSurfaceMode()` hook in `src/crm/lib/surface-store.ts`.
`tokens.css` swaps every COLOR token between the two modes; typography,
spacing, radii, motion, and z-index are mode-independent.

---

## COLOR

### Canvas / surface

| Token                  | Light       | Dark        | Use                                  |
| ---------------------- | ----------- | ----------- | ------------------------------------ |
| `--bg`                 | `#F0F1F3`   | `#000000`   | Page canvas / `<body>`-equivalent    |
| `--bg-elevated`        | `#FFFFFF`   | `#0F0F11`   | Lifted band (e.g. top nav strip)     |
| `--surface`            | `#FFFFFF`   | `#16171A`   | Default card / popover background    |
| `--surface-elevated`   | `#FFFFFF`   | `#1F2024`   | Dialogs / overlays sitting on a card |
| `--surface-sunken`     | `#E9EBEE`   | `#0A0B0D`   | Code blocks, inset wells             |
| `--surface-inverted`   | `#0A0A0A`   | `#FFFFFF`   | Dark island (e.g. active pill tab)   |

### Text

| Token                | Light     | Dark      | Use                              |
| -------------------- | --------- | --------- | -------------------------------- |
| `--fg`               | `#0A0A0A` | `#FFFFFF` | Default body / heading text      |
| `--fg-muted`         | `#4A4D55` | `#B5B7BD` | Secondary copy, sub-stats        |
| `--fg-subtle`        | `#8B8F98` | `#7B7E86` | Placeholders, tertiary copy      |
| `--fg-inverted`      | `#FFFFFF` | `#0A0A0A` | Text on `--surface-inverted`     |
| `--fg-on-accent`     | `#0A0A0A` | `#0A0A0A` | Text on `--accent` (always black) |

### Accents

| Token                | Both modes | Use                                       |
| -------------------- | ---------- | ----------------------------------------- |
| `--accent`           | `#B9FF66`  | Signature lime. Primary CTAs, KPI fills.  |
| `--accent-strong`    | shift      | Hover / active state for accent surfaces  |
| `--accent-soft`      | mix        | Background tint for accent badges         |
| `--accent-glow`      | mix-alpha  | Outer glow / `--shadow-accent`            |
| `--cyan`             | `#66FFED`  | Secondary brand accent                    |
| `--cyan-soft`        | mix        | Cyan tint background                      |

### Status

| Token        | Both modes | Use                       |
| ------------ | ---------- | ------------------------- |
| `--red`      | `#F04949`  | Destructive / overdue     |
| `--red-soft` | mix        | Soft red background       |
| `--orange`   | `#FF9F45`  | Warm / warning escalation |
| `--yellow`   | `#F6D34A`  | Warning / medium priority |
| `--green`    | `#2FCB73`  | Success / won deals       |
| `--blue`     | `#4DA3FF`  | Info / passive status     |

### Structural

| Token              | Light                    | Dark                       | Use                  |
| ------------------ | ------------------------ | -------------------------- | -------------------- |
| `--border`         | `rgba(10,10,10,0.10)`    | `rgba(255,255,255,0.10)`   | Default 1px line     |
| `--border-strong`  | `rgba(10,10,10,0.20)`    | `rgba(255,255,255,0.20)`   | Emphasised line      |
| `--border-inverted`| `rgba(255,255,255,0.14)` | `rgba(10,10,10,0.16)`      | Line on inverted bg  |
| `--ring`           | `#0A0A0A`                | `#FFFFFF`                  | Focus outline        |
| `--ring-accent`    | lime mix                 | lime mix                   | Accent focus outline |
| `--overlay`        | `rgba(10,10,10,0.32)`    | `rgba(0,0,0,0.62)`         | Modal scrim          |

### Shadow

| Token              | Use                            |
| ------------------ | ------------------------------ |
| `--shadow-soft`    | Hairline elevation (inputs)    |
| `--shadow-card`    | Standard card / KPI block      |
| `--shadow-popover` | Dropdown, popover, menu        |
| `--shadow-overlay` | Dialog, drawer, command-K      |
| `--shadow-accent`  | Lime-glow under hero accent CTA |

---

## TYPOGRAPHY

| Token                | Value                                      |
| -------------------- | ------------------------------------------ |
| `--font-sans`        | `'Urbanist', 'Inter', system-ui, …`        |
| `--font-mono`        | `'JetBrains Mono', ui-monospace, …`        |
| `--font-display`     | Same as `font-sans` (semantic alias)       |
| `--font-weight-300…800` | 300, 400, 500, 600, 700, 800            |
| `--font-size-2xs…9xl`| 10 / 11 / 12 / 14 / 15 / 17 / 20 / 24 / 28 / 34 / 44 / 56 / 72 / 90 / 112 px |
| `--line-height-tight…relaxed` | 1.05, 1.2, 1.45, 1.6              |
| `--tracking-tight…widest`     | -0.02, 0, 0.04, 0.08, 0.16 em      |

Hero KPI numbers in the Sales concept use `--font-size-6xl` to `--font-size-7xl`
with `--font-weight-600` and `--tracking-tight`.

---

## SPACING

`--space-0` (0) through `--space-24` (96 px) on a 4-px base. Use:

| Token         | px  |  |  Token        | px  |
| ------------- | --- | -- | -------------| --- |
| `--space-1`   | 4   |  |  `--space-8` | 32  |
| `--space-2`   | 8   |  |  `--space-9` | 36  |
| `--space-3`   | 12  |  |  `--space-10`| 40  |
| `--space-4`   | 16  |  |  `--space-12`| 48  |
| `--space-5`   | 20  |  |  `--space-14`| 56  |
| `--space-6`   | 24  |  |  `--space-16`| 64  |
| `--space-7`   | 28  |  |  `--space-20`| 80  |

---

## RADII

| Token            | px / Value | Use                                  |
| ---------------- | ---------- | ------------------------------------ |
| `--radius-none`  | 0          | Sharp corners                        |
| `--radius-sm`    | 6          | Inline chips, small inputs           |
| `--radius-md`    | 10         | Buttons, badges                      |
| `--radius-lg`    | 14         | Default card edge                    |
| `--radius-xl`    | 20         | KPI / dashboard tile                 |
| `--radius-2xl`   | 28         | Hero glass panels                    |
| `--radius-3xl`   | 40         | Pill containers, schedule rail       |
| `--radius-full`  | 9999       | Round pills, avatars, indicator dots |

Shadcn's `--radius` alias is mapped to `--radius-lg`.

---

## MOTION

| Duration token         | Value  | Use                          |
| ---------------------- | ------ | ---------------------------- |
| `--duration-instant`   | 80 ms  | Hover tints                  |
| `--duration-fast`      | 160 ms | Button presses, ripples      |
| `--duration-normal`    | 240 ms | Card hover, layout shifts    |
| `--duration-slow`      | 420 ms | Drawer / dialog open         |
| `--duration-slower`    | 640 ms | Stagger sequences            |

| Easing token           | Curve                                  |
| ---------------------- | -------------------------------------- |
| `--easing-standard`    | `cubic-bezier(0.2, 0, 0, 1)`           |
| `--easing-emphasis`    | `cubic-bezier(0.2, 0, 0, 1.2)`         |
| `--easing-enter`       | `cubic-bezier(0, 0, 0.2, 1)`           |
| `--easing-exit`        | `cubic-bezier(0.4, 0, 1, 1)`           |
| `--easing-linear`      | `linear`                               |

`@media (prefers-reduced-motion: reduce)` collapses every duration to 0 ms.

---

## Z-INDEX

| Token            | Value | Use                       |
| ---------------- | ----- | ------------------------- |
| `--z-base`       | 0     | Inline content            |
| `--z-raised`     | 1     | Cards on canvas           |
| `--z-sticky`     | 100   | Sticky headers            |
| `--z-dropdown`   | 1000  | Select / combobox panels  |
| `--z-overlay`    | 1100  | Scrims, sheet backdrops   |
| `--z-modal`      | 1200  | Dialog / drawer surface   |
| `--z-toast`      | 1300  | Toast stack               |
| `--z-tooltip`    | 1400  | Tooltips always on top    |

---

## How to add a new color

1. Add the variable to **both** `:root[data-surface='light']` and
   `:root[data-surface='dark']` blocks in `tokens.css`. Keep names without the
   `--` prefix kebab-cased (e.g. `--purple`, `--purple-soft`).
2. Append the token name to the appropriate union in `tokens.types.ts`
   (`ColorToken` for surface/text/status; `TintToken` if it's a tint option for
   `KpiCard` / `BrandMark`).
3. Document it in this README under the right table.
4. If Tailwind utilities should pick it up, add a `--color-<name>:` mapping
   inside the `@theme {}` block of `src/crm/styles/tailwind.css`.
5. Sweep `git grep -nE '#[0-9A-Fa-f]{6}'` inside `components/ui/` to confirm no
   primitive is now hard-coded.

---

## How to add a new size / radius / shadow

Same pattern — add to `tokens.css` (single block since it's mode-independent),
extend the matching union in `tokens.types.ts`, document here, optionally expose
through Tailwind via `@theme`.
