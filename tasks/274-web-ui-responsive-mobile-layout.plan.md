---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "Web UI: Responsive mobile layout"
goal: Make the web UI usable on mobile/tablet screens by adding responsive
  breakpoints, collapsible sidebars, and stacked layouts for narrow viewports,
  improving the PWA experience on mobile devices.
id: 274
uuid: 2b200eed-8661-44c9-a3c6-b69d11c62f46
status: pending
priority: medium
createdAt: 2026-03-24T19:18:05.611Z
updatedAt: 2026-03-24T19:18:05.612Z
tasks: []
tags:
  - web-ui
---

## Overview

The web UI uses fixed split-pane layouts designed for desktop widths. Since PWA support is already in place, making the layout responsive would significantly improve the mobile experience for monitoring sessions and checking plan status on the go.

## Key Features

- **Collapsible sidebar**: `ProjectSidebar` should collapse to a hamburger menu on narrow screens.
- **Stacked layouts**: Split-pane views (sessions, active work, plans) should stack vertically on mobile — list view first, detail view as a separate screen with back navigation.
- **Touch-friendly targets**: Ensure tap targets are at least 44px, increase spacing on interactive elements.
- **Responsive tab navigation**: `TabNav` should adapt to narrow screens — possibly as a bottom navigation bar on mobile.
- **Session detail**: Message list and input should use full screen width on mobile.

## Implementation Notes

- Use Tailwind responsive breakpoints (`sm:`, `md:`, `lg:`) for layout changes
- The split-pane pattern can use CSS grid with `grid-template-columns` that collapses at breakpoints
- Mobile list→detail navigation can use SvelteKit's existing routing — the routes already exist, just need the list views to navigate rather than show side-by-side
- Consider a `useMediaQuery` store for conditional rendering of mobile vs desktop layouts
- Test with Chrome DevTools device emulation and on a real phone via the PWA
