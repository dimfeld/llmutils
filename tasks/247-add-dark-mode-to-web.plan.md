---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: add dark mode to web
goal: Add dark mode support to the web interface with a toggle button, system
  preference detection, and localStorage persistence. Leverages existing CSS
  variable infrastructure and mode-watcher package.
id: 247
uuid: 6431a1c1-b3d0-457c-80cb-c5acf787763e
generatedBy: agent
status: in_progress
priority: medium
planGeneratedAt: 2026-03-21T01:55:45.001Z
promptsGeneratedAt: 2026-03-21T01:55:45.001Z
createdAt: 2026-03-21T01:40:10.359Z
updatedAt: 2026-03-21T02:18:14.421Z
tasks:
  - title: Integrate ModeWatcher and add dark mode toggle to header
    done: false
    description: Add the ModeWatcher component from mode-watcher to
      src/routes/+layout.svelte. This activates .dark class management on
      <html>, localStorage persistence, system preference detection, and FOUC
      prevention via auto-injected head script. Configure with
      defaultMode='system' and themeColors for dynamic meta theme-color. Then
      add a cycling icon button to the header (right of TabNav) that cycles
      light→dark→system using Sun/Moon/Monitor icons from @lucide/svelte and
      setMode/userPrefersMode from mode-watcher. Also add <meta
      name='color-scheme' content='light dark' /> to src/app.html. Update the
      outer div from bg-gray-50 to bg-background, and the header from
      bg-gray-800 to bg-gray-800 dark:bg-gray-900.
  - title: Convert sidebar and navigation components to support dark mode
    done: false
    description: "Update ProjectSidebar.svelte: bg-gray-50→bg-background,
      border-gray-200→border-border, text-gray-500→text-muted-foreground,
      text-gray-700→text-foreground, selected state bg-blue-100
      text-blue-900→add dark:bg-blue-900/30 dark:text-blue-200,
      hover:bg-gray-100→add dark:hover:bg-gray-800. Update TabNav.svelte if
      needed (already uses white/transparency which should work)."
  - title: Convert plan list and row components to support dark mode
    done: false
    description: Update PlansList.svelte, PlanRow.svelte, and ActivePlanRow.svelte.
      Convert borders to border-border, text-gray-900→text-foreground,
      text-gray-500/400→text-muted-foreground, hover:bg-gray-50→add
      dark:hover:bg-gray-800, selected bg-blue-50 ring-blue-200→add
      dark:bg-blue-900/30 dark:ring-blue-700, search input
      border-gray-300→border-border, bg-gray-100 group dividers→add
      dark:bg-gray-800. Also update text-indigo-600 (epic label)→add
      dark:text-indigo-400.
  - title: Convert PlanDetail component to support dark mode
    done: false
    description: "Update PlanDetail.svelte: text-gray-900→text-foreground for
      title/task text, text-gray-500/400→text-muted-foreground for metadata,
      text-gray-700→text-foreground for goal text, bg-gray-100→add
      dark:bg-gray-800 for tag pills, bg-indigo-100 text-indigo-700→add
      dark:bg-indigo-900/40 dark:text-indigo-300 for epic badge,
      text-green-600→add dark:text-green-400 for checkmarks, text-amber-700→add
      dark:text-amber-400 for unresolved deps, hover:bg-gray-100→add
      dark:hover:bg-gray-800 for links."
  - title: Convert badge components (Status, Priority, Workspace) to support dark mode
    done: false
    description: "Update StatusBadge.svelte, PriorityBadge.svelte, and
      WorkspaceBadge.svelte. All use bg-{color}-100 text-{color}-800 pattern.
      Add dark variants: dark:bg-{color}-900/30 dark:text-{color}-300 for each
      status/priority/workspace type. Update FilterChips.svelte: inactive
      bg-white text-gray-500→bg-background text-muted-foreground,
      border-gray-200→border-border, reset button border-gray-300
      text-gray-600→border-border text-muted-foreground, hover:bg-gray-50→add
      dark:hover:bg-gray-800."
  - title: Convert session list, row, and detail components to support dark mode
    done: false
    description: "Update SessionList.svelte:
      text-gray-400/500→text-muted-foreground, hover:bg-gray-100→add
      dark:hover:bg-gray-800. Update SessionRow.svelte: same text/hover
      conversions, selected bg-blue-50 ring-blue-200→add dark:bg-blue-900/30
      dark:ring-blue-700, status dots stay as-is (green/blue/gray-400 work on
      both), hover:bg-gray-200→add dark:hover:bg-gray-700. Update
      SessionDetail.svelte: border-gray-200→border-border,
      text-gray-900→text-foreground, text-gray-500/400→text-muted-foreground,
      hover:bg-gray-100→add dark:hover:bg-gray-800. The message area bg-gray-900
      stays as-is."
  - title: Convert workspace components to support dark mode
    done: false
    description: "Update WorkspaceRow.svelte: border-gray-200→border-border,
      hover:bg-gray-50→add dark:hover:bg-gray-800,
      text-gray-900→text-foreground,
      text-gray-400/500/600→text-muted-foreground, branch badge bg-gray-100
      text-gray-600→add dark:bg-gray-800 dark:text-gray-300, link text-blue-600
      hover:text-blue-800→add dark:text-blue-400 dark:hover:text-blue-300."
  - title: Verify session message area and prompt components in dark mode
    done: false
    description: The session message area (SessionMessage.svelte,
      PromptRenderer.svelte, MessageInput.svelte) is already dark-themed with
      bg-gray-800/900 backgrounds. Verify they look acceptable in dark mode —
      they should need no changes since their parent is always dark. Check that
      the SessionMessage timestamp text-gray-600 has enough contrast in context.
      Check session_colors.ts category colors render well. If any minor
      adjustments are needed, make them.
tags: []
---

## Research

### Overview

The web interface needs dark mode support. The good news is that the CSS infrastructure is almost entirely in place — the remaining work is activating it, adding a toggle, and converting hardcoded color classes in custom components.

### Key Findings

#### 1. Dark Mode CSS Variables Already Exist

`src/routes/layout.css` already defines a complete `.dark` class (lines 42-74) with OKLCH color variables for all semantic tokens (background, foreground, card, primary, secondary, muted, accent, destructive, border, input, ring, chart-1..5, sidebar-*). The Tailwind `@custom-variant dark (&:is(.dark *))` directive is also configured (line 5), so `dark:` utility classes work.

The `@layer base` rule (lines 114-121) already applies `bg-background text-foreground` to the body, so once `.dark` is toggled on `<html>`, those base colors will flip automatically.

#### 2. `mode-watcher` Is Installed But Not Globally Integrated

The `mode-watcher` package (v1.1.0) is in `package.json` but only used by `src/lib/components/ui/sonner/sonner.svelte` to pass theme to the toast library. The `ModeWatcher` component is **not** rendered anywhere, so mode detection and `.dark` class toggling are not active.

**`mode-watcher` API summary:**
- `ModeWatcher` component: Renders in layout, manages `.dark` class on `<html>`, persists preference to localStorage, handles system preference detection. Key props: `defaultMode` (default `"system"`), `darkClassNames` (default `["dark"]`), `disableTransitions` (default `true`).
- `mode` (from `mode-watcher`): Reactive derived state with `.current` property returning `"dark"| "light" | undefined`.
- `toggleMode()`: Switches between light/dark.
- `setMode(mode)`: Sets to `"light"`, `"dark"`, or `"system"`.
- `resetMode()`: Returns to OS preference.
- `userPrefersMode`: Readable/writable state for the user's preference (`"light"`, `"dark"`, `"system"`).
- `createInitialModeExpression(config)`: Returns a JS string to inject in `<head>` to prevent FOUC.

#### 3. FOUC Prevention Is Critical

Without an inline `<script>` in `<head>` that reads localStorage and applies `.dark` before first paint, users will see a white flash on every page load when in dark mode. `mode-watcher` provides `createInitialModeExpression()` for this, and the `ModeWatcher` component can inject this automatically (via `disableHeadScriptInjection: false`, which is the default).

#### 4. shadcn/ui Components Already Support Dark Mode

The following components in `src/lib/components/ui/` already have `dark:` prefixed classes and use semantic color tokens (`bg-primary`, `text-foreground`, etc.):
- `button/button.svelte` — 5 dark variants
- `input/input.svelte` — `dark:bg-input/30`, `dark:aria-invalid:*`
- `badge/badge.svelte` — `dark:bg-destructive/70`, `dark:focus-visible:*`
- `switch/switch.svelte` — `dark:data-[state=*]`
- `textarea/textarea.svelte` — `dark:bg-input/30`
- `checkbox/checkbox.svelte` — dark variants
- `select/select-trigger.svelte` — dark variants
- `dropdown-menu/dropdown-menu-item.svelte` — dark variants
- `input-group/*.svelte` — dark variants
- `radio-group/radio-group-item.svelte` — dark variants
- `field/field-label.svelte` — dark variants
- `toggle/toggle.svelte` — dark variants

These components are ready and need no changes.

#### 5. Custom Components Need Dark Mode Adaptation

The following custom components use hardcoded Tailwind gray/color classes that won't automatically switch in dark mode:

**Layout & Navigation:**
- `src/routes/+layout.svelte`: `bg-gray-50` (main background), `bg-gray-800` (header), `text-white`, `text-gray-300`
- `src/lib/components/TabNav.svelte`: `bg-white/20`, `text-gray-300`, `hover:bg-white/10`

**Sidebar:**
- `src/lib/components/ProjectSidebar.svelte`: `bg-gray-50`, `border-gray-200`, `text-gray-500`, `text-gray-700`, `bg-blue-100 text-blue-900` (selected), `hover:bg-gray-100`

**Plans:**
- `src/lib/components/PlansList.svelte`: `border-gray-200`, `border-gray-300`, `text-gray-500`, `text-gray-400`, `hover:bg-gray-50`, `border-gray-100`
- `src/lib/components/PlanRow.svelte`: `bg-blue-50 ring-blue-200` (selected), `hover:bg-gray-50`, `text-gray-400`, `text-gray-900`, `text-gray-500`
- `src/lib/components/ActivePlanRow.svelte`: Similar to PlanRow
- `src/lib/components/PlanDetail.svelte`: `text-gray-900`, `text-gray-500`, `text-gray-400`, `text-gray-700`, `text-gray-300`, `text-gray-600`, `bg-gray-100`, `bg-indigo-100`, `hover:bg-gray-100`, `text-green-600`, `text-amber-700`

**Status/Priority Badges:**
- `src/lib/components/StatusBadge.svelte`: Uses paired `bg-{color}-100 text-{color}-800` classes
- `src/lib/components/PriorityBadge.svelte`: Same pattern
- `src/lib/components/WorkspaceBadge.svelte`: Same pattern
- `src/lib/components/FilterChips.svelte`: `border-gray-200 bg-white text-gray-500`, `hover:bg-gray-50`, `border-gray-300 text-gray-600 hover:bg-gray-100`

**Workspaces:**
- `src/lib/components/WorkspaceRow.svelte`: `border-gray-200`, `hover:bg-gray-50`, `text-gray-900`, `text-gray-400`, `bg-gray-100`, `text-gray-600`, `text-blue-600`

**Sessions:**
- `src/lib/components/SessionList.svelte`: `text-gray-400`, `text-gray-500`, `hover:bg-gray-100`
- `src/lib/components/SessionRow.svelte`: `bg-green-400`, `bg-blue-400`, `bg-gray-400` (dots), `bg-blue-50 ring-blue-200` (selected), `hover:bg-gray-50`, `text-gray-900`, `text-gray-500`, `text-gray-400`, `hover:bg-gray-200`
- `src/lib/components/SessionDetail.svelte`: `border-gray-200`, `text-gray-900`, `text-gray-500`, `text-gray-400`, `hover:bg-gray-100`, `bg-gray-900` (message area)
- `src/lib/components/SessionMessage.svelte`: `text-gray-600` (timestamp), colored category text, `text-gray-500`, `text-gray-400`, `text-gray-300` (various)

**Prompt/Input (already dark-themed):**
- `src/lib/components/PromptRenderer.svelte`: `bg-gray-800`, `bg-gray-900`, `text-gray-200..500`, `border-gray-600..700` — these are already dark-styled since they appear in the dark session pane
- `src/lib/components/MessageInput.svelte`: Same — already dark

#### 6. Session Message Area Is Already Dark

The session detail message area (`bg-gray-900`) and its child components (PromptRenderer, MessageInput, SessionMessage) are already styled with a dark palette. In dark mode these should stay the same or only need minor adjustments. This reduces the scope significantly.

#### 7. PWA Manifest and Meta Tags

- `static/manifest.webmanifest`: `theme_color: "#1f2937"` (gray-800), `background_color: "#ffffff"` (white)
- `src/app.html`: `<meta name="theme-color" content="#1f2937" />`

The theme-color meta tag should ideally be dynamic to match the current mode. The manifest is static and can't easily change, but the meta tag can be updated via `mode-watcher`'s `themeColors` prop.

#### 8. Color Mapping for Session Categories

`src/lib/utils/session_colors.ts` defines text colors for message categories. These use Tailwind 400-level colors (`text-green-400`, `text-cyan-400`, etc.) which are designed for dark backgrounds. Since the message area stays dark, these should work as-is.

### Architecture Decision: Approach to Converting Hardcoded Colors

There are two approaches for adapting the custom components:

**Option A: Add `dark:` variant classes alongside existing ones**
- Example: `bg-gray-50 dark:bg-gray-900` on the main layout
- Pros: Minimal changes to existing class strings, easy to review
- Cons: More verbose class strings, duplicated logic

**Option B: Replace hardcoded colors with semantic tokens**
- Example: Replace `bg-gray-50` with `bg-background`, `text-gray-900` with `text-foreground`
- Pros: Cleaner, leverages the existing CSS variable system, fewer classes
- Cons: May need additional semantic tokens (e.g., muted variants), bigger diff

**Recommended: Hybrid approach** — Use semantic tokens where they exist (`bg-background`, `text-foreground`, `bg-card`, `text-muted-foreground`, `border-border`) and add `dark:` variants only where no semantic token maps well (badges, status dots, selected states).

### Dependencies & Constraints

- **Dependencies**: `mode-watcher` (already installed), Tailwind CSS 4.2 with `@custom-variant dark`
- **Technical Constraints**: Must prevent FOUC on page load. The session message area is already dark-themed and should remain so. PWA theme-color should adapt to mode.
- **No breaking changes**: The default appearance should remain unchanged (light mode) unless user preference is dark or system is dark.

## Implementation Guide

### Expected Behavior

- The app defaults to "system" mode preference (follows OS dark/light setting)
- A toggle in the header lets users switch between light, dark, and system modes
- The preference persists in localStorage across page loads
- No white flash (FOUC) when loading in dark mode
- The session message area remains dark-themed in both modes
- All UI components are readable and usable in both modes
- Status/priority badges remain visually distinct in both modes

### Acceptance Criteria

- [ ] App respects system dark mode preference by default
- [ ] User can toggle between light/dark/system modes via header control
- [ ] Preference persists across page loads (localStorage)
- [ ] No FOUC on page load in dark mode
- [ ] All text is legible in both modes (sufficient contrast)
- [ ] Status badges, priority badges, and workspace badges are readable in dark mode
- [ ] Selected states (plan rows, session rows) are visible in dark mode
- [ ] Session message area appears consistent in both modes
- [ ] PWA theme-color meta tag updates to match current mode

### Step-by-Step Implementation

#### Step 1: Integrate ModeWatcher Component in Root Layout

Add the `ModeWatcher` component to `src/routes/+layout.svelte`. This activates dark mode detection, localStorage persistence, and `.dark` class management on `<html>`.

```
import { ModeWatcher } from 'mode-watcher';
```

Render `<ModeWatcher />` inside the layout (it renders no visible DOM). Configure with `defaultMode="system"` and `themeColors` to dynamically set the meta theme-color tag:

```
themeColors={{ dark: '#0c0a09', light: '#1f2937' }}
```

The ModeWatcher component auto-injects a `<script>` in `<head>` to prevent FOUC — this is the default behavior.

#### Step 2: Add Dark Mode Toggle to Header

Create a toggle button or dropdown in the header bar (`src/routes/+layout.svelte`). Use an icon from `@lucide/svelte` (Sun, Moon, Monitor icons) that reflects the current mode. Import `toggleMode` or `setMode` and `userPrefersMode` from `mode-watcher`.

Use a simple cycling icon button that cycles through light → dark → system on click. Show Sun icon for light, Moon icon for dark, Monitor icon for system. Place the toggle in the header, to the right of the TabNav.

#### Step 3: Convert Root Layout Colors

In `src/routes/+layout.svelte`:
- Replace `bg-gray-50` on the outer div with `bg-background` (already mapped to CSS variable)
- The header `bg-gray-800` should become `bg-gray-800 dark:bg-gray-900` for subtle differentiation from the content area in dark mode

#### Step 4: Convert Sidebar Colors

In `src/lib/components/ProjectSidebar.svelte`:
- `bg-gray-50` → `bg-background` or add `dark:bg-gray-900`
- `border-gray-200` → `border-border`
- `text-gray-500` → `text-muted-foreground`
- `text-gray-700` → `text-foreground`
- Selected: `bg-blue-100 text-blue-900` → add `dark:bg-blue-900/30 dark:text-blue-200`
- Hover: `hover:bg-gray-100` → add `dark:hover:bg-gray-800`

#### Step 5: Convert List and Row Components

For `PlansList.svelte`, `PlanRow.svelte`, `ActivePlanRow.svelte`, `SessionList.svelte`, `SessionRow.svelte`:
- Borders: `border-gray-200` / `border-gray-100` → `border-border`
- Background: `bg-gray-50` → `bg-background`
- Text: `text-gray-900` → `text-foreground`, `text-gray-500` → `text-muted-foreground`, `text-gray-400` → `text-muted-foreground` or `text-muted-foreground/70`
- Selected: `bg-blue-50 ring-blue-200` → add `dark:bg-blue-900/30 dark:ring-blue-700`
- Hover: `hover:bg-gray-50` → add `dark:hover:bg-gray-800`
- Search input borders: `border-gray-300` → `border-border`

#### Step 6: Convert Detail Components

For `PlanDetail.svelte` and `SessionDetail.svelte`:
- Follow same patterns as Step 5 for text, borders, and hover states
- `bg-gray-100` (tag pills) → add `dark:bg-gray-800`
- `bg-indigo-100 text-indigo-700` (epic badge) → add `dark:bg-indigo-900/40 dark:text-indigo-300`
- Dependency link colors: `text-amber-700` → add `dark:text-amber-400`
- `text-green-600` (checkmark) → keep or `dark:text-green-400`
- Session detail header `border-gray-200` → `border-border`
- Session message area `bg-gray-900` → stays same (already dark)

#### Step 7: Convert Badge Components

For `StatusBadge.svelte`, `PriorityBadge.svelte`, `WorkspaceBadge.svelte`:
- These use `bg-{color}-100 text-{color}-800` patterns
- Add dark variants: `dark:bg-{color}-900/30 dark:text-{color}-300` (or similar)
- This ensures badges remain readable on dark backgrounds

For `FilterChips.svelte`:
- Inactive: `bg-white text-gray-500` → `bg-background text-muted-foreground`
- `border-gray-200` → `border-border`
- Reset button: `border-gray-300 text-gray-600` → `border-border text-muted-foreground`

#### Step 8: Convert Workspace Components

For `WorkspaceRow.svelte`:
- Follow same patterns: `border-border`, `text-foreground`, `text-muted-foreground`
- Branch badge `bg-gray-100 text-gray-600` → add `dark:bg-gray-800 dark:text-gray-300`
- Link colors `text-blue-600 hover:text-blue-800` → add `dark:text-blue-400 dark:hover:text-blue-300`

#### Step 9: Handle Session Components (Already-Dark Area)

The session message area and its components (`SessionMessage.svelte`, `PromptRenderer.svelte`, `MessageInput.svelte`) are already dark-themed. Verify they look acceptable in dark mode:
- `bg-gray-900` message area should stay
- `bg-gray-800` prompt/input containers should stay
- These don't need `dark:` variants since their parent is always dark-themed
- The `border-gray-200` on SessionDetail header needs a dark variant since it's outside the dark message area

#### Step 10: Update PWA Manifest (Optional)

The `static/manifest.webmanifest` `background_color` could be updated, but since the manifest is static, it can only have one value. Keep `#ffffff` as the default. The `ModeWatcher` `themeColors` prop handles the dynamic `<meta name="theme-color">` tag.

Consider adding `<meta name="color-scheme" content="light dark" />` to `src/app.html` to inform the browser the app supports both schemes. This helps with native form controls and scrollbar styling.

#### Step 11: Testing

- Test in both modes by toggling the switch
- Test with system preference set to dark
- Verify FOUC prevention by hard-refreshing in dark mode
- Check all badge types for readability
- Check selected states in plan/session lists
- Verify the session message area looks consistent
- Test the PWA in standalone mode

### Potential Gotchas

1. **FOUC**: If ModeWatcher's head script injection is disabled or fails, users will see a white flash. The default ModeWatcher behavior handles this, but verify it works with SvelteKit's SSR.
2. **Session area border**: The `border-gray-200` on SessionDetail's header is outside the dark message area, so it needs a dark variant even though the message area below it is always dark.
3. **Badge contrast**: The `bg-{color}-100 text-{color}-800` pattern may need tuning in dark mode. Using `bg-{color}-900/30 text-{color}-300` is a good starting point but should be visually verified.
4. **Focus rings**: Some components use `focus:ring-blue-500` or `focus:border-blue-500` — these should work in dark mode but may need contrast adjustments.
5. **Scrollbar styling**: Adding `color-scheme: light dark` in CSS will make native scrollbars adapt to the mode.
