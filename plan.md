# OSIRIS Final Code Review Plan

## Project Overview
- **Name**: osiris-native-desktop (OSIRIS)
- **Tech Stack**: Next.js 16.2.6, React 19.2.4, TypeScript 5, Electron 42.4.1, Tailwind CSS v4, MapLibre GL, Framer Motion, WebSocket
- **Total LOC**: ~12,600 lines across main app, desktop, intel, scanner, plugins-sdk
- **Scope**: Stability, functionality, and performance ONLY. Security is NOT the focus.

## Review Domains (5 parallel agents)

### Agent 1: Frontend Main App + Map Components
Files: src/app/page.tsx, src/app/layout.tsx, src/components/OsirisMap.tsx, src/components/LayerPanel.tsx, src/components/SearchBar.tsx, src/components/ScaleBar.tsx, src/components/ViewPresets.tsx, src/components/GlobalStatusBar.tsx, src/components/ErrorBoundary.tsx
Focus: React 19 + Next.js 16 compatibility, map rendering performance, state management, error boundaries, memoization, event listener leaks, re-render cascades.

### Agent 2: Frontend OSINT + Intelligence Components
Files: src/components/OsintPanel.tsx, src/components/AiAnalyst.tsx, src/components/IntelFeed.tsx, src/components/CameraViewer.tsx, src/components/LiveAlerts.tsx, src/components/MarketsPanel.tsx, src/components/ScmPanel.tsx, src/components/EntityGraphPanel.tsx
Focus: Async data fetching, WebSocket handling, unbounded data growth, AbortController usage, streaming/camera resource cleanup, AI engine integration stability.

### Agent 3: Frontend Settings + UI Utilities
Files: src/components/SettingsPanel.tsx, src/components/ExtensionsSettings.tsx, src/components/WorkspacesSettings.tsx, src/components/SharePanel.tsx, src/components/KeyboardShortcuts.tsx
Focus: Settings persistence, workspace state management, extension loading stability, localStorage/sessionStorage safety, keyboard event cleanup, share functionality edge cases.

### Agent 4: Core Libraries + Data Layer
Files: src/lib/ai-engine.ts, src/lib/osint-utils.ts, src/lib/stealthFetch.ts, src/lib/http-utils.ts, src/lib/sanctions.ts, src/lib/workspaces.ts, src/lib/ssrf-guard.ts, src/lib/bulgaria-sources.ts, src/proxy.ts
Focus: SSRF guard correctness, fetch retry logic, cache strategies, type safety, resource cleanup, proxy stability, AI engine error handling, unbounded loops.

### Agent 5: Desktop + Backend Services + Config
Files: desktop/main.js, desktop/preload.js, desktop/runtime-config.js, desktop/prepare-standalone.js, desktop/after-pack.js, intel/server.js, intel/sources.js, scanner/server.js, plugins-sdk/index.ts, next.config.ts, package.json, tsconfig.json
Focus: Electron lifecycle, IPC security, inter-process communication, backend service stability, config correctness, build pipeline, dependency versions, Node.js engine compatibility.

## Output Format
Each agent returns structured findings with:
- Severity: Critical / High / Medium / Low
- File:path and line numbers
- Description: what the issue is
- Impact: why it matters for stability/performance/functionality
- Recommendation: specific fix

## Synthesis
After all agents complete, merge into a unified report with:
- Executive Summary (top 15 issues by impact)
- Severity-ranked tables
- Priority action plan (quick wins vs architectural fixes)
