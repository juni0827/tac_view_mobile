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
- Local sidecar caching and snapshot reuse for faster cold starts
- Desktop geolocation with fallback support

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

Relevant keys:

- `client.googleApiKey`
- `client.cesiumIonToken`
- `server.openskyClientId`
- `server.openskyClientSecret`
- `server.aisstreamApiKey`
- `server.nswTransportApiKey`

For local web-only dev, `.env` and `server/.env` still work.

### Run

```bash
npm run dev
npm run dev:server
```

Desktop run:

```bash
npm run tauri:dev
```

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

`test:smoke:desktop` launches the desktop app and checks that the sidecar and frontend boot sequence come up cleanly.

## Repository Layout

```text
config/       Runtime config examples
scripts/      Sidecar build and desktop smoke helpers
server/       Express sidecar, runtime config, snapshot storage
src/          React/Cesium application
src-tauri/    Tauri shell and desktop integration
tests/        Unit, contract, and desktop smoke coverage
```

## Notes

- This repository is now desktop-first. Old Vercel/serverless deployment artifacts have been removed.
- Build output such as `dist/`, `.sidecar-build/`, `src-tauri/target/`, and packaged binaries is treated as generated state.
- Missing API keys degrade features selectively rather than preventing the app from booting.
