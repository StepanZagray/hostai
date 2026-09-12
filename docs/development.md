# Development guide

This page covers the HostAI toolchain, launch modes, local configuration and
verification commands. Product behavior and wire contracts live in the
[architecture overview](architecture.md), [backend contract](../backend/README.md),
[runtime protocol](model-ui.md) and [guest access guide](guest-access.md).

## Stack

- pnpm 11 workspace
- Vite+ 0.3.1, TanStack Start 1.168.50, React 19.2.8, TypeScript 7.0.2
- Panda CSS 1.12.1 with locally bundled Instrument Sans and IBM Plex Mono,
  shared design tokens, and light/dark themes
- Electron 44.3.0 with a sandboxed renderer, no Node integration and no preload bridge
- Java 26, Spring Boot 4.1.1, Spring WebFlux, Jackson 3 and virtual threads
- Maven Wrapper 3.3.4 / Maven 3.9.12

## Requirements and launch modes

The source launch scripts target Linux and macOS; Linux is verified. You need
Node 24+, pnpm, JDK 26 and `curl` for the first Maven download. Install Ollama
separately if you want real inference. No repository command installs Ollama or
downloads a model automatically.

From the repository root:

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts the Java gateway and Vite+, then prints
`http://127.0.0.1:3000`. Ctrl+C stops both processes but does not stop Ollama.
The optional desktop mode runs the same services and opens Electron:

```sh
pnpm desktop:dev
```

Electron's **Workspace → Open in browser** menu reaches the same UI.

The launcher honors `JAVA_HOME`. On the verified Linux setup it can discover
`/usr/lib/jvm/java-26-openjdk` without changing the system Java installation.
Select a JDK explicitly elsewhere:

```sh
export JAVA_HOME=/path/to/jdk-26
pnpm dev
```

For frontend-only work, use `pnpm dev:web`. It shows an offline state without a
gateway. Start one separately with `pnpm backend:dev`; build the guest page
first with `pnpm --filter @hostai/web build:guest`.

To serve built assets:

```sh
pnpm build:all
pnpm start          # browser mode
pnpm desktop:start  # browser mode plus Electron
```

The combined launchers require ports 3000 and 8080 to be free and refuse to
reuse an unknown process on either port. Linux development uses Chromium's
user-namespace sandbox; unprivileged user namespaces must be available. The
launcher does not disable renderer sandboxing. On a machine without a usable
GPU, use `HOSTAI_SOFTWARE_RENDERING=1` with `pnpm desktop:start` or
`pnpm desktop:dev`.

## Local runtime configuration

The default Ollama origin is `http://127.0.0.1:11434`. A different loopback
port is allowed; arbitrary remote origins are rejected:

```sh
HOSTAI_OLLAMA_URL=http://127.0.0.1:11435 pnpm dev
```

Additional local runtimes and separately started OpenAI-compatible engines are
configured with `HOSTAI_RUNTIME_URLS` and `HOSTAI_OPENAI_URLS`. See the
[runtime protocol configuration](model-ui.md#configuration) for their exact
rules and examples. Guest storage and Cloudflare configuration are documented
in [guest access](guest-access.md#storage-and-configuration).

## Checks

```sh
pnpm check
pnpm test
pnpm build && pnpm test:http
pnpm backend:test
pnpm test:ui
```

The first four commands cover TypeScript/Vite+ checks, frontend stream and
proxy tests, a built-server HTTP test with an isolated backend stub, and Java
tests. `pnpm test:ui` requires Sway 1.12, bubblewrap, grim, wtype,
wl-clipboard, Chromium, Python and `/usr/bin/node`, plus a running frontend
when the integration mode is used. The runner verifies a private headless
software display before opening a browser or Electron, never uses an inherited
desktop socket, and cleans up its processes and temporary directory.

See [verification](verification.md) for dated results, evidence and the
isolation procedure.

## Compatibility notes

The current TanStack Start/Vite+ combination rejects an otherwise usable SSR
environment through an `instanceof` check. The version-pinned patch in
`patches/` checks the required `runner.import` method instead, and `pnpm
install` applies it reproducibly. Reassess the patch when upgrading Start; see
[upstream issue #7614](https://github.com/TanStack/router/issues/7614).

The `vite` peer-version warning comes from the Vite+ alias exposing version
`0.3.1` while Vitest expects Vite's version range. The project uses the single
Vite+ implementation and its bundled Vitest; development, builds and tests are
checked together.
