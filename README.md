# HostAI

HostAI is a local inference workspace with one frontend for **Electron and your
browser**, backed by Java. Connect Ollama or another local runtime, download
and run models, stream conversations, inspect request activity, or let a
runtime provide its own sandboxed interface.

Guest access is invite-only and model-scoped. A host publishes one model through
a temporary Cloudflare Quick Tunnel, then privately sends a guest two separate
things: the public address, which carries no credential, and an expiring access
key, which the guest pastes into the page. Keys are durable, so a host can look one
up again and re-send it; the gateway therefore stores key material at rest in a
0600 file. Cloudflare terminates TLS and can see relayed messages and access keys.
Hosts can also enable an approval inbox for guests who have no key. Stable public
hosting, verified host identities, conversation persistence across reloads, signed
installers and bundled Java runtimes are not implemented. See
[guest access](docs/guest-access.md) for the security boundary and current
verification limits.

## Quick start

Requirements: Node 24+, pnpm, JDK 26 and `curl` for the first Maven download.
Install Ollama separately if you want real inference.

```sh
pnpm install
pnpm dev
```

Open **http://127.0.0.1:3000**. The command starts the Java gateway and web
server; Ctrl+C stops both, but does not stop Ollama. To open the same workspace
in Electron, use `pnpm desktop:dev`.

See the [development guide](docs/development.md) for built assets,
`JAVA_HOME`, frontend-only work, software rendering and verification.

## Connect a model

Start Ollama and open **Models → Download a model**. Choose a [starter
model](docs/starter-models.md) or enter an explicit library tag, review it and
start the download. An installed model can go straight to Playground. See
[using models](docs/using-models.md) for runtime configuration, discovery,
progress and recovery behavior.

## Connect another runtime

Any local process that speaks the small [HostAI runtime protocol](docs/model-ui.md) can serve models next to, or instead of, Ollama. Point the gateway at its loopback origin:

```sh
HOSTAI_RUNTIME_URLS=http://127.0.0.1:11434,http://127.0.0.1:11435 pnpm dev
```

See [model UI and the runtime protocol](docs/model-ui.md) for discovery,
capabilities, custom UIs and the required interaction contract. Model downloads
always target `HOSTAI_OLLAMA_URL`.

For a separately started OpenAI-compatible engine, such as vLLM:

```sh
HOSTAI_OPENAI_URLS=http://127.0.0.1:8000 pnpm dev
```

Use the engine origin without `/v1`. Both origin lists can be combined; when
both are empty, discovery defaults to `HOSTAI_OLLAMA_URL`.

## Use models without a UI

```sh
pnpm cli models
pnpm cli describe pebby:latest --json
pnpm cli infer pebby:latest '{"op":"info"}'
pnpm cli chat YOUR_MODEL 'Hello'
```

The [CLI](docs/cli.md) talks to the running HostAI gateway, not directly to the
model. Both UI modes have headless access. The [Python SDK](python/README.md)
helps providers declare and validate their UI and headless contract. Public
tunnel WebSocket access is not implemented in the CLI.

## Share a model with guests

Install `cloudflared` and restart the gateway first; hosting needs it. After
testing a model, choose **Models → Set up guest access**, then **Start hosting**
to serve the model and publish it through Cloudflare in one action. Copy the
guest page address, create a named key with an expiry, and send the guest both.
**Show key** reads an existing key back at any time, so you can re-send it instead
of issuing a new one, and a QR code next to it saves a phone guest from retyping.
Creating a key needs hosting started, because the key binds to the served model;
looking one up, copying, revoking and cleanup work with hosting off. **Revoke**
ends a key's permission and active generation; **Stop hosting** ends all guest
requests, the tunnel and local serving. Hosting starts stopped after a gateway
restart.

See [guest access](docs/guest-access.md) for setup, limits, storage and
temporary-hosting constraints, and [access requests](docs/access-requests.md)
for host-approved invitations. There is no host search, public listing or
shared directory; see [invite-only connections](docs/directory.md).

## Documentation

- [Development guide](docs/development.md) — stack, launch modes, configuration and checks
- [Architecture overview](docs/architecture.md) — request topology, state ownership and UI behavior
- [Using models](docs/using-models.md) — discovery, local model acquisition and recovery
- [Model UI and runtime protocol](docs/model-ui.md) — custom runtimes, inference and sandboxed UIs
- [Headless CLI](docs/cli.md) — terminal chat and opaque JSON inference
- [Guest access](docs/guest-access.md) — hosting, access keys, storage and API
- [Guest access requests](docs/access-requests.md) — approval inbox and request lifecycle
- [Backend contract](backend/README.md) — Java API and exact wire behavior
- [Python provider SDK](python/README.md) — provider integration
- [Starter models](docs/starter-models.md) — bundled model choices and published sizes
- [Verification](docs/verification.md) — test evidence and known limits
- [Host and guest journeys](docs/user-journeys.md) — current UX audit

The [improvement log](docs/improvement-log.md) records the reasoning behind
recent product changes. It is a project record, not a deployment guide.
