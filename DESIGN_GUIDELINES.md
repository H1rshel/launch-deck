# Launch Deck UI Design Guidelines

## Purpose
This document captures the current design language used across [Dashboard](./src/pages/Dashboard.jsx), [GameDetail](./src/pages/GameDetail.jsx), [Settings](./src/pages/Settings.jsx), and the shared rules in [global.css](./src/styles/global.css). Use it to refine screens without drifting into a different product style.

## Core Tone
- Premium desktop launcher UI with a dark sci-fi surface language.
- Neon cyan is the primary action accent. Purple, amber, green, and red are supporting accents only.
- Interfaces should feel deliberate and elevated, not flat, playful, or overly busy.
- Favor product-page hierarchy over dashboard clutter when showing game metadata.

## Foundations
### Color
- Base backgrounds: `--bg-primary`, `--bg-surface`, `--bg-elevated`.
- Primary accent: `--accent-cyan`.
- Supporting accents:
  - `--accent-purple` for secondary highlight states.
  - `--accent-amber` for ratings and achievement emphasis.
  - `--accent-green` for success and installed states.
  - `--accent-red` for destructive actions.
- Borders stay subtle and translucent. Use `--border` by default and `--border-glow` only for hover/focus emphasis.

### Typography
- Headings use `Geom` via `--font-heading`.
- Body copy uses `Sora` via `--font-body`.
- Section headers often use compact uppercase/small-caps styling with letter spacing.
- Large hero titles should feel sharp and cinematic, but supporting text stays muted and restrained.

### Radius
- Small controls: `--radius-sm` (`8px`).
- Most cards/buttons: `--radius-md` (`12px`).
- Hero and larger surfaces: `--radius-lg` (`16px`).
- Reserve `--radius-xl` for special cases only.

### Motion
- Use short reveal animations already present in the app: `page-enter`, `hero-reveal`, `hero-content-enter`, `card-enter`, `fade-up`.
- Hover motion should be subtle lift/glow, not bounce or exaggerated scaling.

## Shared Layout Patterns
### Page Shell
- `TopBar` is consistent across pages and should remain compact, glassy, and utility-first.
- `page__content` uses generous desktop padding and vertical breathing room.
- Major page sections are stacked with clear separation rather than dense nesting.

### Surfaces
- Standard sections use `var(--bg-surface)` with a thin translucent border.
- Elevated interactive cards may add soft neumorphic or glow shadows, but avoid thick outlines.
- Keep surfaces visually grouped by rhythm and spacing before adding more containers.

## Components
### Buttons
- Primary CTA: cyan fill, dark text, heading font, slight hover lift/glow.
- Secondary button: translucent surface, thin border, muted text that brightens on hover.
- Icon utility buttons: compact, rounded-square, low emphasis until hover.
- Danger actions: red-tinted surface, lighter typography than primary CTA.

### Tags and Badges
- Use compact rounded pills for short metadata only.
- Accent-code by meaning:
  - Rating: amber.
  - Genre/context: cyan.
  - Secondary taxonomy such as themes: purple.
- Do not overload a hero row with too many pills.
- Official age ratings should read as classification marks, not generic metadata pills.

### Sections
- Settings uses a clear pattern: section header first, surface body second.
- For simple textual facts, prefer editorial rows over grid cards.
- Reserve boxed/card layouts for content that benefits from scanability or interaction.

## Page-Specific Guidance
### Dashboard
- The featured hero is cinematic, wide, and CTA-led.
- Supporting content is organized in clean shelves/grids.
- Cards use lift, glow, and crisp border transitions.

### Settings
- Functional, structured, and compact.
- Section title + icon above a single surfaced body.
- Rows inside a section are separated by borders instead of extra nested cards.

### Game Detail
- Treat the page like a product page, not a telemetry dashboard.
- The hero should prioritize:
  1. Title/logo
  2. Subtext/franchise context
  3. Controlled metadata pills
  4. Official age rating badge
- Keep the right rail as a disciplined vertical stack of equally weighted cards.
- Prefer editorial text rows for studio metadata.
- Installation details should remain useful but visually secondary.

## Game Detail Rules
### Hero Metadata
- Show rating first when available.
- Show up to `2-3` genres.
- Themes can sit alongside genres, but total contextual pills should stay controlled.
- Do not mix the age rating square into the pill row.
- Avoid reintroducing store/platform badge clutter as hero pills.

### Franchise Presentation
- Use inline editorial copy under the title.
- Highlight the franchise name with accent color only.
- Avoid heavy badges or boxed franchise treatments.

### Right Rail
- Keep cards in one vertical column with consistent spacing.
- Matching width, visual weight, and rhythm matter more than adding wrappers.

### About Section
- Use the title `About the Game`.
- Developer and publisher should be presented as clean editorial rows.
- Avoid grid/card treatments for only two facts.

## Do
- Preserve the dark premium palette and cyan-first accent hierarchy.
- Use spacing, typography, and contrast to improve hierarchy before adding new UI.
- Keep surfaces and corners consistent with the existing token system.
- Let important content breathe.

## Do Not
- Redesign pages into a different aesthetic.
- Add metadata noise just because data is available.
- Turn every fact into a pill, badge, or card.
- Use heavy containers for simple one-line information.
- Break the existing button hierarchy.
