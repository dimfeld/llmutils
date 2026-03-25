---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "Web UI: Keyboard accessibility improvements"
goal: "Improve keyboard accessibility across the web UI: add proper ARIA labels
  to interactive elements, manage focus in confirmation dialogs and modals,
  ensure status indicators are not color-only, and add keyboard shortcuts for
  common actions."
id: 273
uuid: cb5d783a-daf4-4bf5-a489-6173dfb10f54
status: pending
priority: medium
createdAt: 2026-03-24T19:18:05.222Z
updatedAt: 2026-03-24T19:18:05.222Z
tasks: []
tags:
  - web-ui
---

## Overview

The web UI has basic keyboard navigation (Alt+Arrow for lists) but lacks comprehensive accessibility support. This plan addresses ARIA labels, focus management, color-independent status indicators, and keyboard shortcuts.

## Key Features

- **ARIA labels**: Add `aria-label` and `role` attributes to interactive elements — status badges, action buttons, expand/collapse toggles, filter chips.
- **Focus management**: Trap focus in confirmation dialogs (workspace lock/unlock), return focus to trigger element on close.
- **Status indicators**: Add text labels or patterns alongside color-only status indicators so they're distinguishable without color vision.
- **Keyboard shortcuts**: Add shortcuts for common actions — focus search (Ctrl+/), navigate tabs (Ctrl+1/2/3), dismiss notifications (Escape).
- **Skip navigation**: Add skip-to-content links for screen readers.

## Implementation Notes

- Audit all components for missing ARIA attributes
- Use a focus trap library or implement a simple one for dialog components
- StatusBadge already shows text — ensure contrast ratios meet WCAG AA
- The expand/collapse triangles (▶/▼) should also have `aria-expanded` attributes
- Test with VoiceOver on macOS for basic screen reader compatibility
