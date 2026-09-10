# Guest access and temporary internet sharing

HostAI has three loopback listeners: the owner web workspace (3000), owner Java
API (8080), and an explicitly enabled guest listener (8081). The guest listener
has an independent routing graph and static frontend bundle. It exposes no model
management, request history, owner status, actuator, or owner-page routes.

Local preview works on the same machine. Optional **Cloudflare Quick Tunnel**
sharing uses a fourth, ephemeral loopback listener with the same restricted guest
routes. It never forwards to the owner workspace, owner API, Ollama, or the local
preview listener. Tailscale, stable public hosting, accounts and verified host identities are not
integrated. An [optional self-hostable directory](directory.md) adds opt-in host
search; no public registry is deployed by default. A loopback bind and Host/origin
checks do not authenticate other local processes; owner controls remain
unauthenticated.

**Cloudflare terminates TLS and can see messages and access keys.** Transport
through this relay is not end-to-end encryption. Quick Tunnels have temporary
random URLs and no uptime guarantee; they are development/testing infrastructure,
not production hosting. A key is a bearer permission, not a verified identity.

## Host and client flow

1. Download/select a local model and try a prompt in Playground.
2. Open Client access, select the model and a name clients will see, then start
   local client access. This checks installed-model metadata; it does not prove
   that inference fits memory, test a prompt, or preload the model.
3. For remote clients, read the Cloudflare disclosure and explicitly start
   internet sharing. Wait for the public HTTPS/WebSocket check to pass. Missing
   cloudflared requires installation and a gateway restart; HostAI does not install
   it or change existing Cloudflare/Tailscale configuration.
4. Create a named **local** or **internet** key expiring in 1 hour, 24 hours or
   7 days. Internet keys can only be created while the public connection is live.
   Copy the link once; it cannot be recovered later. Anyone possessing it has its
   permission. Existing local keys never become internet keys. Alternatively, separately
   enable [access requests](access-requests.md) and choose an expiry when approving
   each guest in the app. Intake, directory publication and tunnel access are independent.
5. Open a local link on this machine, or an internet link on the client's device. The guest page removes
   its `#access=` fragment before requesting metadata and keeps the key in memory.
   HTTP metadata uses `Authorization: Bearer …`; internet chat sends the key in
   its first encrypted WebSocket message. Keys never go in cookies, queries,
   WebSocket subprotocols or browser storage. Connecting does not automatically generate a response.
6. Chat, Stop, or reconnect. Same-key reconnect retains the draft and transcript;
   a different key, Disconnect, or reload clears them. A request made in this tab
   survives Disconnect, retaining its credentials for cancellation or an explicit
   reconnect; reload and closing the tab clear everything. Unfinished exchanges remain
   visible but are excluded from subsequent model context. An empty or whitespace-only
   answer is incomplete too: the question returns to an empty composer, while an
   independently typed draft is preserved. **Copy question** on incomplete exchanges
   recovers an earlier prompt without replacing the draft. Stop returns keyboard
   focus to the composer; involuntary expiry leaves draft focus in place instead
   of moving typing into the key field. Retry is manual; an empty answer does not require a new
   access check when the existing session is still usable.
   The displayed expiry is the host's timestamp rendered in your time zone, not a
   browser countdown. A wrong device clock or clock correction cannot invalidate
   a successful access check or interrupt an answer. The host checks every send
   and terminates expired streams. An idle page learns that access ended on its
   next explicit send or reconnect; no background access check or chat replay is
   added. Retry waits use elapsed monotonic time, capped at five minutes. HTTP-date
   retry headers require a valid host Date; otherwise retry is available manually.
   On browsers whose monotonic clock pauses during sleep, a wait resumes after
   waking. Host-side rate limits apply regardless of the browser timer.
7. Revoke a key to end permission and its active requests. Stop client access to
   end all guest requests and the tunnel. Stop internet sharing ends only public
   access. Unrevoked keys retain permission when the same model and their channel
   resume; a restarted tunnel has a new URL. Revoke keys to permanently end that
   permission.

Access starts stopped after every Java restart. Stopping access leaves the guest
local listener/static page available to show connection errors; closing the gateway
closes the listener and its connections. No active guest work survives stopping.
This closes HostAI's upstream exchange; it cannot prove an independent Ollama
process has freed GPU resources or stopped work shared with another caller.

## Controls and limits

- A key permits exactly one model and one channel, checked before metadata
  probing or inference. Internet keys are rejected by the local listener and vice versa.
- The key contains a random 256-bit secret. The durable file stores its SHA-256
  hash and grant metadata; authentication compares hashes in constant time.
- Revocation is committed before success is returned. Expiry and revocation also
  terminate an active generation. Local errors before the first record use HTTP status; public WebSocket errors
  use a fixed status frame. After streaming begins, both use a terminal error
  record. Provider error bodies are never displayed.
- One guest request may run at a time, within two total inference slots. Guests
  cannot occupy both slots. This does not reserve memory or guarantee low latency.
- Each key may make six admitted chat attempts per minute. Rejections use 429 and
  Retry-After. Input retains the gateway's 256 KiB/64-message/character bounds;
  guest output is capped at 1,024 requested tokens (the page requests 512).
- Uploads time out after ten seconds. Existing chat idle and total deadlines apply.
  The guest listener also bounds connections and HTTP headers. These limits are
  not a complete internet abuse or denial-of-service protection system.
- Guest metadata contains only the host-provided name, granted model, availability,
  expiry, protocol scope and limits. A name is not a verified identity. The host
  operator receives submitted messages.
- Static assets are local, protected with CSP, and carry no owner router. Guest
  API and owner grant responses use `Cache-Control: no-store`. Error messages do
  not echo credentials, arbitrary upstream bodies or storage paths.

## Storage and configuration

`HOSTAI_ACCESS_DIR` selects a dedicated private directory. The default is
`$XDG_DATA_HOME/hostai/access`, or `~/.local/share/hostai/access`. The gateway creates
missing directories privately; it rejects symlinks and unsafe existing store
permissions. `HOSTAI_GUEST_PORT` changes the local guest port (default 8081).
`HOSTAI_CLOUDFLARED_PATH` optionally names an installed executable; otherwise the
gateway searches PATH for `cloudflared`. It never accepts an executable path from
a browser request. The verified binary during development is cloudflared 2026.9.0.
The process wrapper requires `/bin/sh` and POSIX permissions; Linux is tested.

Storage requires POSIX permissions, stable file identities, exclusive locking,
atomic rename and directory fsync. The store directory is 0700 and files are 0600.
Only one gateway can open a store. Windows/non-POSIX storage support is not
implemented; Linux is verified. No existing permission is silently repaired.

Request-created keys are labelled with the guest name and matching code. The host
can revoke them in the same Access keys list; it never receives the client-held
raw secret. Stopping request intake leaves approved permissions valid.

The versioned JSON file is bounded to 128 KiB and 100 total keys, including revoked
and expired keys. Schema v1 grants are read as local only; the next mutation
writes schema v2 with explicit channels. Older builds cannot read schema v2.
There is no pruning/delete UI yet. Raw keys are never stored.
Authentication uses the committed memory snapshot; external file edits are not a
revocation interface. Corrupt data, unsafe permissions or a failed mutation stop
guest access without disabling local owner chat. Repair requires a gateway
restart; restoration never enables guests automatically. A failed write has an
uncertain durable outcome and must not be reported as a successful revocation.

Build the guest page before Java resources are packaged:

```sh
pnpm build:all
```

For separate browser development, run `pnpm --filter @hostai/web build:guest`
before `pnpm backend:dev`; rebuild/restart Java after guest-page changes. The desktop
dev launcher does that initial guest build automatically. Tests use an explicit
temporary access directory and simulated Ollama, never the user's default store.

## Tunnel lifecycle and boundary

Start returns promptly while a worker creates a private process environment,
starts cloudflared, and checks its announced address. Initial verification allows
up to two minutes for public DNS and the streaming check; Stop remains available. The child receives an
explicit private YAML configuration, a private HOME/config/data/temp directory,
loopback metrics binding, disabled updates and a fixed loopback HTTP origin. The
ingress header secret is stored only in the 0600 configuration, not in argv.
Raw logs and process arguments never appear in the API. The origin parser accepts
only one canonical HTTPS hostname under `trycloudflare.com`.

Internet chat uses WSS because real Quick Tunnel HTTP responses buffered the
small NDJSON records. Local preview keeps HTTP NDJSON. The WebSocket route
uses the same model/key/admission lifecycle; closing it cancels its upstream
exchange. The initial envelope and incoming frames are bounded, one generation
is allowed per socket, and missing credentials time out. The guest bundle always
constructs a same-host WSS URL with no credential query or subprotocol. Browser
WebSocket handshakes reject redirects; HostAI sets no authentication cookies.

The public listener requires that exact Host and a per-attempt secret header
added by cloudflared. Browser-supplied forwarding headers do not select a channel
or grant permission. The local listener rejects tagged traffic. Owner routes do
not exist on either guest listener. A protected, per-attempt WebSocket probe returns two
proof records two seconds apart; the production verifier requires valid WSS,
the matching proof, the correct record order and incremental delivery. It does
not follow redirects or test inference. Only a passed check enables public
session/chat requests and exposes a copyable internet invite.

States are `off`, `starting`, `verifying`, `live`, `interrupted`, `stopping` and
`failed`. Checks repeat every 15 seconds after the first success. A failed check
hides the public link, blocks new public requests and ends active public exchanges;
recovery permits new requests without reviving a cancelled exchange. Stop closes
permission immediately and tears down the process before releasing its listener.
Failed teardown retains a refusing listener and reports failure. There is no
automatic restart or replacement URL after process exit.

A parent-death watchdog stops the direct owned connector if the Java process
disappears. Descendant discovery requires the live JVM. Normal shutdown also removes the private scratch directory;
abrupt process death can leave private configuration and scratch files. Lifecycle
verification and provider-specific evidence are recorded in
[verification](verification.md). Failures distinguish DNS, HTTPS, rejected verification requests and buffered or
incomplete streaming responses without exposing provider bodies. The manager’s debug logging records only the announced hostname, never keys,
probe paths or raw connector logs. A passed reachability check does not prove model
memory fit, latency, host identity, or comprehensive internet abuse protection.

[Cloudflare Quick Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
describes its temporary hosting limits. The [optional directory](directory.md) supplies a reference registry, signed
installation identity and listing freshness. It requires explicit configuration
and deployment for clients on other machines.

## API summary

Owner routes are under `/api/sharing` on the owner gateway/proxy. Mutations require
JSON and enforce exact browser Origin checks. They do not grant CORS access.

| Method and owner path | Body | Result |
| --- | --- | --- |
| GET `/api/sharing` | — | State (`stopped`, `local`, `unavailable`), host name, selected model, local guest URL, error, grant metadata and nested `internet` status; never raw keys |
| POST `/api/sharing/start` | `{ "model": "model:tag", "hostLabel": "My host" }` | Current state; switching model/name while enabled requires stopping first |
| POST `/api/sharing/stop` | `{}` | Stopped access and terminated guest work; grants remain |
| POST `/api/sharing/internet/start` | `{}` | Begin an explicit temporary tunnel attempt; returns current full status |
| POST `/api/sharing/internet/stop` | `{}` | Block public access and begin teardown; local access remains |
| POST `/api/sharing/grants` | `{ "label": "Visitor", "expiresInHours": 24, "channel": "local" }` | Grant metadata, raw token and fragment invite URL, returned only by creation |
| POST `/api/sharing/grants/<UUID>/revoke` | `{}` | Updated state after durable revocation; repeating a known revoke is idempotent |

On the guest listener, GET `/guest/v1/session` and POST `/guest/v1/chat` require
one Authorization bearer header. Session metadata includes `hostLabel`, `model`,
`expiresAt`, `available`, nullable `unavailableReason`, `maxConcurrentGuests: 1`,
`maxTokens: 1024`, `requestsPerMinute: 6` and `scope: "local-preview"` or
`"temporary-internet"`. An omitted creation channel defaults to `local`.

Nested `internet` status contains `state`, `provider: "cloudflare-quick"`,
`available`, nullable `publicUrl`, `checkedAt`, `error`, and `restartRequired`. Only `live` returns a
public URL. Public checks do not open access while publication is stopped. A terminal
cleanup failure requires a gateway restart and disables further tunnel actions.

Chat accepts the existing `model`, `messages`, `temperature` and `maxTokens` JSON
contract with the stricter guest cap. It streams the existing `content`, `done`,
optional `outputTokens` and `error` NDJSON records. The first `done: true` record
terminates the client protocol. Missing/unknown/expired/revoked keys get a uniform
401. A valid key while access is stopped gets 503; a request for an ungranted
model gets 403. A key for a different current publication is rejected with 401.


Public guests use `/guest/v1/chat-stream` over WSS instead of the local HTTP chat
route. The first text frame contains `{ "key": "…", "request": { …ChatRequest } }`.
There is one generation per socket. Successful response frames carry the same
`content`, `done`, optional `outputTokens` and `error` fields as local NDJSON.
A pre-stream failure carries `{ "type": "error", "status": 429, "retryAfter": 12 }`
with the applicable HTTP-equivalent status; no arbitrary detail is exposed.
A browser Origin, when present, must match the public HTTPS origin exactly.

For slow public DNS propagation, `hostai.tunnel-startup-timeout` accepts a duration
between one second and ten minutes (default `PT2M`). This changes only the initial
verification deadline. It never bypasses TLS, instance proof, incremental delivery,
channel permissions or explicit owner Stop. No extra public URL is created by a
retry within the same attempt.
