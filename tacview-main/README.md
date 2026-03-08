# TAC_VIEW

TAC_VIEW is a desktop-first tactical intelligence globe built with `Tauri`, `React`, `Cesium`, and a local `Node` sidecar. The globe is the primary interface: live feeds, prediction overlays, ontology relationships, and selection context are rendered visually first, with panels acting as secondary detail views.

## Stack

- `Tauri v2` desktop shell
- `React 19` + `TypeScript` + `Vite`
- `CesiumJS` / `Resium` for globe rendering
- `Express` sidecar for `/api/*` aggregation, caching, auth, and snapshots
- `Vitest`, `Supertest`, `selenium-webdriver`, `tauri-driver` for validation

## Runtime Model

- The desktop shell launches a packaged sidecar binary from `src-tauri/binaries/`.
- The sidecar exposes the existing `/api/*` contract on a local port.
- The renderer gets runtime bootstrap data from Tauri instead of hard-coded build-time env values.
- Desktop config lives at `appData/tac_view/config.json`.
- The example config file is `config/tac_view.config.example.json`.

## Main Capabilities

- Real-time globe layers for flights, ships, satellites, earthquakes, traffic, and CCTV
- Selection-driven visual intelligence overlays
- Predicted paths, destination candidates, relationship arcs, facility rings, and group hulls on the globe
- Worker-backed tiered grouping for micro groups, meso groups, and altitude-gated activity clouds
- Adaptive render budgets, camera query hysteresis, and Google 3D quality throttling for dense scenes
- Local sidecar caching and snapshot reuse for faster cold starts
- Desktop geolocation with fallback support

## Architecture Highlights

- `groupController` diffs live track inputs and streams only patches into a worker-backed grouping pipeline.
- `renderBudget` and `renderQuery` scale layer density and prioritize tracked or related entities as the camera changes.
- The desktop sidecar refuses direct standalone startup by default; the supported runtime contract is `tac_view.exe` launching the packaged sidecar.

## Development

### Prerequisites

- `Node.js 20+`
- `npm`
- `Rust` + Tauri desktop prerequisites
- On Windows, the Visual Studio C++ build tools used by Tauri

### Install

```bash
npm install
```

### Configure

Copy `config/tac_view.config.example.json` into your runtime config location and fill in the keys you actually use.
Keep the example file as a placeholder template only; do not commit real API keys into it.

Relevant keys:

- `client.googleApiKey`
- `client.cesiumIonToken`
- `server.openskyClientId`
- `server.openskyClientSecret`
- `server.aisstreamApiKey`
- `server.nswTransportApiKey`

The packaged desktop flow reads runtime keys from `appData/tac_view/config.json`.

### Run

There is no standalone local-web dev flow in this repository.

Use the packaged desktop build path instead:

```bash
npm run tauri:build:win
```

After the build finishes, the top-level outputs are:

- `TAC_VIEW/` for the portable desktop run set
- `TAC_VIEW_setup.exe` for the Windows installer

### Build

```bash
npm run build:sidecar
npm run build
npm run tauri:build:win
```

## Test Commands

```bash
npm run lint
npm run build
npm run test:unit
npm run test:contracts
npm run test:e2e:desktop
npm run test:smoke:desktop
```

`test:smoke:desktop` and `test:e2e:desktop` both validate the packaged desktop executable path.
Unit coverage includes the tiered group engine, render-budget controller, and render-priority query helpers.

## Repository Layout

```text
config/       Runtime config examples
scripts/      Sidecar build and desktop smoke helpers
server/       Express sidecar, runtime config, snapshot storage
src/          React/Cesium application
src/intelligence/ Tiered grouping engine, worker bridge, selection context
src/lib/      Render safety, budget, priority query, performance stores
src-tauri/    Tauri shell and desktop integration
tests/        Unit, contract, and desktop smoke coverage
```

## Notes

- This repository is now desktop-first. Old Vercel/serverless deployment artifacts have been removed.
- Standalone local-web development entry points have been removed. The supported runtime is the packaged desktop app plus its local sidecar API.
- Build output such as `dist/`, `.sidecar-build/`, `src-tauri/target/`, and packaged binaries is treated as generated state.
- Temporary runtime snapshots and Playwright CLI logs are treated as generated local artifacts.
- Missing API keys degrade features selectively rather than preventing the app from booting.
