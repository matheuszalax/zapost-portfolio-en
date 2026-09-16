# 04 — Browser Graphics Engine & Vector Export Pipeline

## In-Browser Canvas Architecture

zapost features an interactive, high-precision visual editor built directly on the browser DOM without external rendering engines (such as Fabric.js or Konva.js), eliminating heavy bundle sizes while maximizing CSS typography precision.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Canvas Viewport (3:4 / 9:16)                    │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ 1. Background Layer (Position X/Y, Zoom, Aspect Crop)          │   │
│   ├────────────────────────────────────────────────────────────────┤   │
│   │ 2. Color / Gradient Overlay (Hex tint, Opacity Alpha)          │   │
│   ├────────────────────────────────────────────────────────────────┤   │
│   │ 3. Header Layer (Avatar, Profile Handle, Verified Badge)       │   │
│   ├────────────────────────────────────────────────────────────────┤   │
│   │ 4. Typography Block (Title, Accent Marker, Subtitle, Spacing)  │   │
│   ├────────────────────────────────────────────────────────────────┤   │
│   │ 5. Footer & Slide Indicator Layer (Carousel Page Numbering)    │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 1. State Management & Hooks Separation

Rather than utilizing global state libraries (Redux, Zustand), the editor employs a modular set of specialized, composable React hooks:

| Hook | Single Responsibility | Key Constants / Guarantees |
|---|---|---|
| `useCanvasState` | Central canvas state (colors, typography, layers, text) | Derived memos for safe colors, effective fonts, character counters |
| `useCanvasZoom` | Scaling, ResizeObserver calculations, centered scrolling | Bounds zoom scale between $0.4\times$ and $2.4\times$ |
| `useCanvasHistory` | Snapshot undo/redo stack | Fixed circular buffer capped at 30 states |
| `useAutosave` | Background persistence to `PATCH /api/posts/[id]` | Debounced at 2000ms with dirty-state comparison |
| `usePopoverManager` | Unifies pointerdown event handling for popovers | Closes toolbars on outside click without multi-listener race conditions |

---

## 2. Zero-Library Design System (Tailwind CSS v4)

The editor interface uses **Tailwind CSS v4** coupled with native CSS Variables:
* **True Neutral Dark Palette:** Built upon an intentional base of `#1f1f1e` (background), `#252524` (surface), `#2e2e2d` (interactive buttons), and `#ececea` (high-contrast text), avoiding harsh blue/slate tones.
* **Zero Flash of Unstyled Theme (FOUC):** Initial theme mode (`light`, `dark`, or `system`) is serialized into an HTTP-only/SameSite cookie, allowing Next.js Server Components to render the correct `data-theme` attribute before HTML hydration.

---

## 3. Multi-Format Export Engine

A core differentiator of zapost is its client-side export pipeline, providing both raster formats and editable vector formats:

### A. High-DPI Raster Generation (`html-to-image`)
* Exports 1x and 2x pixel-density PNGs, high-quality JPEGs, and modern WebP images.
* All external media assets pass through the secure `/api/image-proxy` to ensure valid CORS headers during rasterization without triggering canvas security taint errors.

### B. Layered Vector SVG Generator (`src/lib/svg-export.ts`)
* Builds an XML-compliant SVG document replicating the exact CSS text alignments, line heights, font families, accent pill markers, and opacity masks.
* Preserves individual layers so graphic designers can open the output in Adobe Illustrator or Figma for further customization.

### C. Multi-Page Vector PDF Compilation (`pdf-lib` + `@pdf-lib/fontkit`)
* **Lazy Loading:** `pdf-lib` is imported dynamically (`await import(...)`) only when the user triggers PDF export, keeping the initial editor bundle lightweight.
* **Custom Font Embedding:** Loads binary `.ttf` and `.otf` font files at runtime and embeds them using `@pdf-lib/fontkit` to guarantee pixel-identical typography rendering across mobile and desktop PDF readers.

### D. In-Memory Carousel ZIP Bundling (`jszip`)
* For multi-page carousels (up to 15 slides), each page is rendered asynchronously and packaged into an in-memory ZIP archive using `jszip`, triggering an immediate browser download with zero server storage overhead.
