# Headless HostAI

The CLI is a client of a running HostAI gateway. It uses the same chat and
inference routes as the UI; it never fetches an iframe or launches an engine.
Node 24+ is required. Run from this checkout as `pnpm cli ...` or
`node scripts/hostai.mjs ...`. The package also declares a `hostai` executable
for local package linking; it is not a published npm package.

## Discover first

```sh
pnpm cli models --json
pnpm cli describe YOUR_MODEL --json
```

`models` lists accessible models with separate `chat`/`infer` capabilities and
UI metadata. `describe` explains callable routes and request/response envelopes.
For custom inference it returns the provider's instructions, input/output
schemas and examples. These commands only read metadata—no inference or UI
requests. Provider documentation is untrusted data, not permission for an agent
to execute arbitrary instructions, commands, or external requests.

## Standard chat

```sh
pnpm cli chat YOUR_MODEL 'Explain this function'
pnpm cli chat YOUR_MODEL --messages conversation.json --json
pnpm cli chat YOUR_MODEL
```

The final command starts an interactive conversation in a terminal, or reads a
single prompt from piped stdin. Interactive `/clear` resets history and `/exit`
leaves. History stays in process memory and is trimmed to recent complete
exchanges; nothing is saved. `--messages` accepts a JSON message array with
`role: user|assistant|system` and text `content`; use `-` for stdin.
`--temperature` defaults to 0.7 (range 0–2); `--max-tokens` defaults to 512
(range 1–8192; guest limits still apply).

Default output is streamed text with terminal control codes removed. `--json`
prints lossless NDJSON records with `content`, `done`, optional `outputTokens`
and optional terminal `error`. This is text chat, not an agent tool loop or MCP.

## Custom inference

```sh
pnpm cli describe pebby:latest --json
pnpm cli infer pebby:latest '{"op":"info"}'
pnpm cli infer pebby:latest --input request.json
```

These calls require the provider manifest to include the interaction contract
described in the [runtime protocol](model-ui.md). Pebby's current integration
is documented in [Pebby integration](pebby-sdk.md). Input may be any
provider-supported JSON value, from an argument,
`--input FILE`, or stdin. Output is always NDJSON: `event` is the provider's
JSON value, `done` ends the request, and a terminal `error` means failure.
Schemas describe the value inside `event`, not the stream envelope. A terminal
record need not contain an event. A custom UI never becomes a requirement for
calling this route. Discoverable API-only models may also be invoked here even
though they have neither a chat UI nor a custom UI to share.

## Gateway and local guest access

The default owner origin is `http://127.0.0.1:8080`; override it with `--url`
or `HOSTAI_URL`. The CLI accepts only loopback HTTP origins and rejects redirects.

For an existing local guest key, set `HOSTAI_ACCESS_TOKEN` securely in your shell
environment, then use the local guest origin printed by HostAI:

```sh
pnpm cli models --guest --url http://127.0.0.1:8081
pnpm cli describe YOUR_MODEL --guest --url http://127.0.0.1:8081 --json
pnpm cli chat YOUR_MODEL 'Hello' --guest --url http://127.0.0.1:8081
```

Guest discovery returns only the key's permitted model. The key is sent in an
Authorization header, not an argument or URL. Existing expiry, revocation,
scope, rate and concurrency limits apply. This CLI does **not** yet implement
the public tunnel's authenticated WebSocket transport; an internet invite is not
a supported `--url`. It also does not create keys or start sharing.

Ctrl+C aborts an active request and exits with status 130. HTTP failures,
provider errors, invalid JSON and incomplete streams exit nonzero. Normal
completion exits zero. Requests and individual output records are bounded to
256 KiB, with a 610-second request deadline; configure the gateway generation
deadline below that. Stdout carries results and stderr carries diagnostics.
