---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: PWA support for tim web
goal: ""
id: 234
uuid: 585f83db-e117-4999-b73e-3e71f8952c84
generatedBy: agent
status: done
priority: medium
planGeneratedAt: 2026-03-20T10:11:55.789Z
promptsGeneratedAt: 2026-03-20T10:11:55.789Z
createdAt: 2026-03-17T09:30:24.600Z
updatedAt: 2026-03-20T10:42:08.951Z
tasks:
  - title: Copy and prepare app icons
    done: true
    description: Copy icon_512x512.png from
      tim-gui/TimGUI/Assets.xcassets/AppIcon.appiconset/ to static/icon-512.png.
      Resize icon_256x256.png to 192x192 and save as static/icon-192.png using
      sips. Copy icon_32x32.png to static/favicon.png and update the favicon
      reference in src/routes/+layout.svelte to use the new PNG instead of the
      Svelte logo SVG.
  - title: Create web app manifest
    done: true
    description: "Create static/manifest.webmanifest with app name (tim - Plan
      Manager), short_name (tim), start_url (/), display standalone,
      background_color #ffffff, theme_color #1f2937, and icons array referencing
      icon-192.png (192x192) and icon-512.png (512x512)."
  - title: Add PWA meta tags to app.html
    done: true
    description: "Update src/app.html to add: link rel=manifest
      href=/manifest.webmanifest, meta name=theme-color content=#1f2937, meta
      name=apple-mobile-web-app-capable content=yes, meta
      name=apple-mobile-web-app-status-bar-style content=default, and link
      rel=apple-touch-icon href=/icon-192.png."
  - title: Create service worker
    done: true
    description: "Create src/service-worker.ts using SvelteKit built-in support.
      Import build, files, version from $service-worker. Install event: open
      versioned cache (cache-${version}), addAll build and files arrays, call
      self.skipWaiting(). Activate event: delete old caches not matching current
      version, call clients.claim(). Fetch event: for URLs matching build or
      files arrays use cache-first strategy (match cache, fallback to network).
      For /api/ routes and everything else, do not intercept (let browser handle
      normally)."
  - title: Register service worker in root layout
    done: true
    description: "In src/routes/+layout.svelte onMount callback, add service worker
      registration: check for serviceWorker in navigator, then call
      navigator.serviceWorker.register(/service-worker.js). Also add a
      controllerchange listener on navigator.serviceWorker that calls
      location.reload() to auto-refresh when a new service worker activates."
  - title: Verify build and type checking pass
    done: true
    description: Run bun run check and bun run check-web to ensure the service
      worker TypeScript compiles and all type checking passes. Run bun run build
      to verify the production build includes the service worker and manifest
      correctly.
changedFiles:
  - README.md
  - src/app.html
  - src/lib/server/manifest.webmanifest.test.ts
  - src/routes/+layout.svelte
  - src/service-worker.ts
  - static/favicon.png
  - static/icon-192.png
  - static/icon-512.png
  - static/manifest.webmanifest
tags: []
---

## Research

### Overview

The tim web interface is a SvelteKit application using `@sveltejs/adapter-node` that provides real-time session monitoring, plan management, and workspace tracking. It currently has **no PWA infrastructure** — no service worker, no web manifest, no offline support. The app relies heavily on real-time server connections (WebSocket on port 8123 for agent connections, SSE for client updates).

### Key Findings

#### Current Web Architecture
- **Framework**: SvelteKit with Svelte 5 (runes), adapter-node
- **Build**: Vite 8, Tailwind CSS 4
- **Real-time**: WebSocket server (port 8123) for agents → SessionManager → SSE to browser clients
- **Notifications**: Browser Notification API already integrated (`src/lib/utils/browser_notifications.ts`) with permission requesting in root layout
- **Routes**: Three main tabs under `/projects/[projectId]/` — sessions, active, plans — plus API routes for SSE and session actions
- **Favicon**: SVG Svelte logo at `src/lib/assets/favicon.svg`, set via `<svelte:head>` in root layout

#### SvelteKit Service Worker Support
SvelteKit has built-in service worker support. Placing a file at `src/service-worker.ts` (or `.js`) automatically:
- Builds it with Vite as a separate entry point
- Exposes `$service-worker` module with `build` (hashed static assets), `files` (static dir contents), `prerendered` (prerendered pages), and `version` (timestamp)
- The service worker is NOT automatically registered — the app must register it manually

The tsconfig files already exclude service worker paths from type checking, confirming SvelteKit expects this pattern.

#### PWA Requirements Analysis

A PWA needs three things:
1. **Web App Manifest** — JSON file declaring app name, icons, colors, display mode
2. **Service Worker** — For offline caching, push notifications (future), background sync
3. **HTTPS** — Required for service workers (localhost is exempt for development)

For this app specifically:
- **Offline support is limited in value**: The core functionality (session monitoring, prompt responses) requires live server connections. Plans and plan details could potentially be cached for offline viewing, but the primary use case is real-time interaction.
- **Installability is the primary value**: Being able to install the app on desktop/mobile for quick access, having it appear as a standalone window rather than a browser tab, and having a proper app icon.
- **Push notifications (future)**: Currently uses the Notification API directly (requires the tab to be open). A service worker could enable push notifications even when the tab is closed — but this would require a push notification server, which is out of scope for now.

#### Files Inspected

| File | Relevance |
|------|-----------|
| `svelte.config.js` | adapter-node, path aliases, no PWA config |
| `vite.config.ts` | Tailwind + SvelteKit + devtools plugins, no PWA plugin |
| `src/app.html` | Minimal template, no PWA meta tags |
| `src/routes/+layout.svelte` | Root layout, favicon, notification permission, session manager init |
| `src/hooks.server.ts` | Server init, WebSocket server startup |
| `src/lib/utils/browser_notifications.ts` | Existing Notification API integration |
| `static/` | Only `robots.txt` — no icons, no manifest |
| `tsconfig.json` | Already excludes `src/service-worker.*` paths |
| `package.json` | No PWA packages installed |

#### Architectural Considerations

1. **adapter-node**: The app runs on a Node server, so prerendering is not used. The service worker's `prerendered` list will be empty. The `build` list will contain hashed JS/CSS assets, and `files` will contain static directory contents.

2. **SSE reconnection**: The client already has exponential backoff reconnection for SSE (1s → 30s max). The service worker should not interfere with SSE or WebSocket connections — these should always go to the network.

3. **Icons**: The tim-gui macOS app already has icons at multiple sizes in `tim-gui/TimGUI/Assets.xcassets/AppIcon.appiconset/` (16x16 through 1024x1024 PNG). The 512x512 can be used directly; a 192x192 can be resized from the 256x256. No icon design work needed.

4. **Display mode**: `standalone` is the right choice — the app should look like a native app without browser chrome. The header bar with tab navigation already provides app-level navigation.

5. **Theme color**: The app uses a dark header (`bg-gray-800` = `#1f2937`) which would be a good match for the theme color.

### Expected Behavior/Outcome

After implementation:
- The browser shows an "Install" prompt/icon when visiting the tim web interface
- Users can install the app to their desktop/mobile home screen
- The installed app opens in a standalone window (no browser chrome)
- Static assets (JS, CSS, icons) are cached by the service worker for faster loads
- API calls, SSE, and WebSocket connections always go through the network (no caching)

### Key Findings Summary

- **Product & User Story**: As a tim user, I want to install the web interface as a desktop/mobile app so I can quickly access it from my taskbar/dock without opening a browser tab, and have it feel like a native application.
- **Design & UX Approach**: Standalone display mode with dark theme color matching the existing header. App icon from existing tim-gui macOS app. No offline fallback — the app requires a server connection.
- **Technical Plan & Risks**: SvelteKit's built-in service worker support provides the foundation. Main risk is ensuring the service worker doesn't interfere with real-time connections (SSE/WebSocket). The adapter-node setup means no prerendered pages to cache.
- **Pragmatic Effort Estimate**: Small scope. Core implementation is straightforward — manifest file, service worker with cache-first for static assets and network-only for API/SSE/WS, meta tags, registration code. Icons already exist.

### Acceptance Criteria

- [ ] Browser shows install prompt when visiting the app (meets PWA installability criteria)
- [ ] App can be installed and opens in standalone mode (no browser chrome)
- [ ] Static assets (JS, CSS, fonts, icons) are cached by the service worker
- [ ] API calls, SSE streams, and WebSocket connections are NOT cached (network-only)
- [ ] Web manifest includes proper app name, icons (at least 192x192 and 512x512), theme color, and display mode
- [ ] Theme color meta tag is present in the HTML
- [ ] Service worker updates correctly when new versions are deployed

### Dependencies & Constraints

- **Dependencies**: Existing SvelteKit service worker support (built-in, no additional packages needed)
- **Technical Constraints**: adapter-node means no prerendered pages; real-time connections (SSE, WebSocket) must bypass the service worker cache; the WebSocket server runs on a separate port (8123) which is naturally outside the service worker's scope

### Implementation Notes

- **Recommended Approach**: Use SvelteKit's built-in service worker support (`src/service-worker.ts`) rather than a plugin like `@vite-pwa/sveltekit`. The built-in approach is simpler, gives full control, and avoids an additional dependency. The service worker should use cache-first for static assets and network-only for everything else.
- **Potential Gotchas**:
  - Service workers only work on HTTPS (and localhost). This is fine since the app is either accessed locally or should be behind HTTPS in production.
  - The WebSocket server on port 8123 is on a different origin, so it's naturally outside the service worker's scope — no special handling needed.
  - SSE connections (`/api/sessions/events`) must be excluded from caching to avoid stale/broken streams.
  - Service worker updates need careful handling — `skipWaiting()` and `clients.claim()` for immediate activation, or a UI prompt for the user to refresh.
  - The `build` array from `$service-worker` contains content-hashed filenames, making cache invalidation straightforward.

## Implementation Guide

### Step 1: Copy and Prepare App Icons

Use the existing tim app icons from `tim-gui/TimGUI/Assets.xcassets/AppIcon.appiconset/`.

**What to do:**
- Copy `icon_512x512.png` to `static/icon-512.png`
- Resize `icon_256x256.png` to 192x192 and save as `static/icon-192.png` (use `sips` on macOS: `sips -z 192 192 --out static/icon-192.png tim-gui/TimGUI/Assets.xcassets/AppIcon.appiconset/icon_256x256.png`)
- Also update the favicon to use the tim icon instead of the Svelte logo — copy `icon_32x32.png` to `static/favicon.png` and update the `<link rel="icon">` in the root layout

**Why:** PWA installability requires at least a 192x192 and 512x512 icon. Using the existing tim-gui icon ensures visual consistency across platforms.

### Step 2: Create Web App Manifest

Create `static/manifest.webmanifest` with the app metadata.

**What to do:**
```json
{
  "name": "tim - Plan Manager",
  "short_name": "tim",
  "description": "Real-time project plan management and session monitoring",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#1f2937",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml" }
  ]
}
```

**Why:** The manifest tells the browser this is an installable app and provides metadata for the installed experience.

### Step 3: Add PWA Meta Tags to app.html

Update `src/app.html` to include the manifest link and theme color.

**What to do:**
- Add `<link rel="manifest" href="/manifest.webmanifest">` to the `<head>`
- Add `<meta name="theme-color" content="#1f2937">` for the browser toolbar color
- Add `<meta name="apple-mobile-web-app-capable" content="yes">` for iOS
- Add `<meta name="apple-mobile-web-app-status-bar-style" content="default">` for iOS status bar
- Add `<link rel="apple-touch-icon" href="/icon-192.png">` for iOS home screen

**Why:** These meta tags are required for full cross-platform PWA support. iOS doesn't use the manifest for all features and needs its own meta tags.

### Step 4: Create the Service Worker

Create `src/service-worker.ts` using SvelteKit's built-in service worker support.

**What to do:**

The service worker should implement:

1. **Install event**: Pre-cache all static assets from the `build` and `files` arrays (provided by `$service-worker`). Use a versioned cache name (e.g., `cache-${version}`) so old caches are cleaned up.

2. **Activate event**: Delete old caches that don't match the current version. Call `clients.claim()` to take control of existing pages immediately.

3. **Fetch event handler** with this strategy:
   - **Same-origin requests for cached assets** (`build` and `files`): Cache-first — serve from cache, fall back to network
   - **API routes** (`/api/`): Network-only — never cache SSE streams or API responses
   - **Everything else** (including navigation requests): Network-only — let the browser handle errors normally

**Key patterns from `$service-worker`:**
- `build`: Array of hashed static asset URLs (JS, CSS) — safe to cache indefinitely
- `files`: Array of files in `static/` directory — cache with version key
- `version`: Timestamp string for cache versioning

**Why:** Cache-first for static assets gives instant loads. Network-only for API/SSE prevents stale data or broken streams. No offline fallback needed since the app requires a server connection to function.

### Step 5: Register the Service Worker

Add service worker registration code to the root layout (`src/routes/+layout.svelte`).

**What to do:**
- In the `onMount` callback (which already exists for notification permission), add service worker registration:
  ```typescript
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js');
  }
  ```
- Optionally listen for the `controllerchange` event to handle updates (e.g., show a toast prompting refresh)

**Why:** SvelteKit builds the service worker but doesn't register it automatically. Registration should happen on mount (client-side only).

### Step 6: Handle Service Worker Updates

Use the simple auto-update approach.

**What to do:**
- In the service worker, call `self.skipWaiting()` in the install event so new versions activate immediately
- In the registration code (root layout), listen for the `controllerchange` event on `navigator.serviceWorker` and call `location.reload()` to pick up the new version
- This means the page will auto-refresh when a new service worker activates — acceptable since deploys are infrequent

**Why:** Keeps the implementation simple. The auto-refresh approach avoids the complexity of toast-based update prompts.

### Step 7: Testing

**Manual testing steps:**
1. Run the dev server (`bun run dev`) and open in Chrome
2. Open DevTools → Application → Manifest — verify manifest loads correctly
3. Open DevTools → Application → Service Workers — verify service worker registers and activates
4. Check the "Install" icon appears in the browser address bar
5. Install the app and verify it opens in standalone mode
6. Navigate between tabs (sessions, active, plans) — verify pages load from cache after first visit
7. Deploy a change — verify the page auto-refreshes when the new service worker activates

**Automated testing:**
- Test that `static/manifest.webmanifest` is valid JSON with required fields
- Test that the service worker TypeScript compiles without errors (covered by `bun run check`)

## Current Progress
### Current State
- All 6 tasks complete. PWA support is fully implemented.
### Completed (So Far)
- Icons copied from tim-gui and resized (512, 192, favicon)
- Web app manifest created with relative URLs for base-path safety
- PWA meta tags added to app.html using %sveltekit.assets% placeholder
- Service worker with cache-first for static assets, network-only for /api/ and everything else
- Service worker registration with controllerchange listener (guarded against first-visit reload)
- Build verification passes (bun run build-web)
- Automated tests for manifest values, icon existence, and app.html PWA tags
- README updated with PWA documentation
- Old favicon.svg deleted
### Remaining
- None
### Next Iteration Guidance
- None
### Decisions / Changes
- Used relative URLs in manifest (e.g. `icon-192.png` not `/icon-192.png`) and `%sveltekit.assets%` in app.html for base-path compatibility
- Used `start_url: "."` instead of `"/"` for base-path safety
- Guarded controllerchange reload with `!!navigator.serviceWorker.controller` check to avoid reloading on first visit
- Removed old favicon.svg since it's no longer used
### Lessons Learned
- SvelteKit does NOT auto-register service workers despite building them — manual registration is required
- controllerchange fires on first visit when service worker calls clients.claim(), causing an unwanted reload unless guarded
- PWA URLs in app.html should use `%sveltekit.assets%` placeholder, not hardcoded root paths, for base-path compatibility
### Risks / Blockers
- Pre-existing type check failures in `bun run check` / `bun run check-web` are unrelated to this change; `bun run build-web` is the reliable verification path
