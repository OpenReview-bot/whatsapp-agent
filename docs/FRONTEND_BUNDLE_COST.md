# Frontend dependency and bundle cost

Audit #46, Phase 2. Measured with `cd ui && bun install && bun run build` (Vite 8, Bun 1.4.5). No dependency was removed: this records evidence so removals can be decided.

## Build output

| Asset | Size | Gzip |
| --- | --- | --- |
| `index-*.js` (single chunk) | 1,828.86 kB | 573.00 kB |
| `index-*.css` | 359.28 kB | 59.54 kB |
| `index.html` | 0.61 kB | 0.36 kB |

`dist/` is 2.2 MB. Vite warns the JS chunk exceeds 500 kB: there is no code splitting. `ui/node_modules` is 709 MB (dev machine only, not shipped). 8,668 modules are transformed for about 15 source components.

## Who uses what (imports in `ui/src`)

| Package | Import sites | Notes |
| --- | --- | --- |
| `@lobehub/ui` | 7 files: `App.tsx`, `i18n.tsx`, `ChatList.tsx`, `ChatThread.tsx`, `ModeratorDrawer.tsx`, `PersonaSettingsPage.tsx`, `StickerStudioModal.tsx` (`Avatar`, `Badge`, `Tag`, `AgentAvatar`, `ConfigProvider`, `/icons`) | Largest likely contributor. A handful of small components. |
| `@lobehub/icons` | 4 imports | Brand icons. |
| `@astryxdesign/core`, `theme-neutral` | `Badge`, `Button`, `StatusDot`, `theme`, `built` | Small surface. |
| `lucide-react` | 11 files | Tree-shakes well. |
| `motion` | 1 import | |
| `tailwindcss` + `@tailwindcss/vite` | used | Source of the CSS. |
| `@stylexjs/stylex` | 0 direct imports | Per `ui/bun.lock`: peer dependency of `@astryxdesign/core` and a hard dependency of `@lobehub/ui`. Keep while either is used. |
| `@lobehub/fluent-emoji` | 0 direct imports | Per `ui/bun.lock`: a peer dependency of `@lobehub/ui` only, not of `@lobehub/icons`. Needed while `@lobehub/ui` is installed; nothing here imports it directly. |
| `@supabase/supabase-js` | 1 file, `src/utils/supabase.ts`, which nothing imports | Dead module. Likely tree-shaken out of the bundle, but the dependency and file are unused. Safe candidate to remove after confirming the browser never needs Supabase. |

## Findings and options

1. The JS bundle is 573 kB gzip for a small operator console. Most weight probably comes from `@lobehub/ui` pulling its component graph for 5 components. Not yet measured per package: run `bunx vite-bundle-visualizer` or rolldown's analyzer to confirm before swapping libraries.
2. Cheap win: lazy-load the heavy, rarely opened views with `React.lazy`. `App.tsx` renders `ModeratorDrawer` and `StickerStudioModal` unconditionally, so swapping the imports is not enough: also mount them only when open (for the modal, `isStickerStudioOpen`), or they still load on first render. Needs a visual check in a real browser, which was not done here.
3. Remove `ui/src/utils/supabase.ts` and the `@supabase/supabase-js` dependency if confirmed unused.
4. Replacing `@lobehub/ui` for 5 simple components is a larger change with visual risk. Do not do it without screenshots.

## Not measured

Runtime performance, first paint on a phone, Arabic/RTL layout cost, and per-package byte attribution.
