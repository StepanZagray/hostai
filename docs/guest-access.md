# Guest access and temporary internet sharing

HostAI has three loopback listeners: the owner web workspace (3000), owner Java
API (8080), and an explicitly enabled guest listener (8081). The guest listener
has an independent routing graph and static frontend bundle. It exposes no model
management, request history, owner status, actuator, or owner-page routes.

Hosting a model publishes it through an optional **Cloudflare Quick Tunnel**,
which uses a fourth, ephemeral loopback listener with the same restricted guest
routes. It never forwards to the owner workspace, owner API, Ollama, or the 8081
listener. That 8081 listener still runs and the gateway still enforces its `local`
channel, but the host UI no longer offers local preview as a way to share: every
listener binds to 127.0.0.1, so a local key could only ever be used by someone
already sitting at the host's own keyboard, which made it useless as a sharing
mechanism and actively misleading. Tailscale, stable public hosting, accounts and verified host identities are not
integrated. Connections are invite-only; host search and public directory
publication have been removed. Guest responses ask search engines not to index
or follow the page; this is a crawler directive, not an access control. A loopback bind and Host/origin
checks do not authenticate other local processes; owner controls remain
unauthenticated.

**Cloudflare terminates TLS and can see messages and access keys.** Transport
through this relay is not end-to-end encryption. Quick Tunnels have temporary
random URLs and no uptime guarantee; they are development/testing infrastructure,
not production hosting. A key is a bearer permission, not a verified identity.

The host sends a guest two separate things: the **public address**, which carries
no credential and only opens the guest page, and an **access key**, which permits
chat with one model. There is no combined invitation. Nothing mints a one-shot
`origin/#access=token` link for copy-paste any more. An address alone grants no
chat permission; a key alone has nothing to connect to.

## Host and guest flow

1. Download/select a local model and try a prompt in Playground.
2. Open Guest access → **Host on the internet**, choose **Model for guests** and a
   **Host name shown to guests**, read the **What hosting exposes** disclosure,
   then press **Start hosting**. That is one host-facing action in two gateway
   calls: it starts the local guest listener for the selected model, and only if
   that settles does it start the Cloudflare tunnel. It checks installed-model
   metadata; it does not prove that inference fits memory, test a prompt, or
   preload the model. Missing cloudflared disables **Start hosting** outright and
   requires installation and a gateway restart; HostAI does not install it or
   change existing Cloudflare/Tailscale configuration.
3. Wait for the public HTTPS/WebSocket check. The status line moves through
   *Starting hosting…*, *Verifying the public address…* and *Hosting is live*.
   On success the section shows the **Guest page address**, a **Copy guest
   address** button, and a QR code of that plain address under **Scan to open**.
   The address carries no key. If the local half started but the tunnel did not,
   the page says the model is served locally yet not reachable, and offers **Try
   the public connection again** or **Stop hosting**. While a connection is
   interrupted the address stays hidden and the gateway rechecks it periodically.
4. In **Access keys**, enter a **Key label**, choose an expiry of 1 hour, 24 hours
   or 7 days, and press **Create key**. Creating a key requires hosting to be
   started, because a key permits exactly one model and that model comes from the
   running session; there is nothing to bind a key to otherwise. It does **not**
   require the tunnel to be live. Looking an existing key up, copying it, revoking
   it and removing ended records are unconditional and work while hosting is off.
   The host UI only ever creates `internet` keys.
5. A key is a durable, recoverable credential, not a one-time string. **Show key**
   reads it back from the gateway at any time into a selected read-only field with
   a **Copy key** button; the same button then reads **Hide key** and closes the
   field without revoking anything. Keys survive gateway restarts and tunnel
   restarts. While the public address is live, a revealed key is also drawn as a
   QR code under **Scan to connect**, encoding `<public address>/#access=<key>` so
   a phone guest need not retype 85 characters; treat that image as the key
   itself. The QR is composed on demand from the current public address and the
   looked-up key, and is never stored. A key the gateway no longer lists as
   unrevoked stops being legible on screen.
6. Send the guest the address and the key, privately and separately. Anyone
   holding a key has its permission. Alternatively, separately enable
   [access requests](access-requests.md) and choose an expiry when approving each
   guest in the app. Request intake and hosting are separate controls. Keys
   approved that way are derived by the guest, so the gateway never holds them:
   they report `recoverable: false`, offer no **Show key**, and can only be revoked.
7. The guest opens the address and pastes the key into **Access key** on the guest
   page, which is the primary action there, then presses **Connect**. Scanning the
   key's QR code opens the same page with the key already filled in. The guest page
   removes its `#access=` fragment before requesting metadata and keeps the key in memory.
   HTTP metadata uses `Authorization: Bearer …`; internet chat sends the key in
   its first encrypted WebSocket message. Keys never go in cookies, queries,
   WebSocket subprotocols or browser storage. Connecting does not automatically generate a response.
8. Chat, Stop, or reconnect. Same-key reconnect retains the draft and transcript;
   a successful connection with a different key, Disconnect, or reload clears them.
   A rejected, unavailable or unreadable replacement check retains the previous
   conversation and draft while sending stays blocked. Reconnect retries the latest
   attempted key; re-enter the previous key to restore its retained conversation.
   Previous metadata is not relabelled as belonging to an unavailable replacement.
   A request made in this tab
   survives Disconnect, retaining its credentials for cancellation or an explicit
   reconnect; reload and closing the tab clear everything. Unfinished exchanges remain
   visible but are excluded from subsequent model context. An empty or whitespace-only
   answer is incomplete too: the question returns to an empty composer, while an
   independently typed draft is preserved. **Copy question** on incomplete exchanges
   recovers an earlier prompt without replacing the draft. Stop returns keyboard
   focus to the composer. Manual key entry stays mounted and read-only during its
   check so a rejection leaves keyboard users at the editable key field; moving
   focus elsewhere while waiting is respected. Involuntary expiry leaves draft focus in place instead
   of moving typing into the key field. Retry is manual; an empty answer does not require a new
   access check when the existing session is still usable. If Enter is pressed while
   access is being checked, the composer says the draft was not sent and updates
   that feedback when the check finishes. Access recovery never queues a send.
   Re-entering the same key during a reconnect cooldown explains the remaining
   wait without sending another check; a different key can still be checked.

   The displayed expiry is the host's timestamp rendered in your time zone, not a
   browser countdown. A wrong device clock or clock correction cannot invalidate
   a successful access check or interrupt an answer. The host checks every send
   and terminates expired streams. An idle page learns that access ended on its
   next explicit send or reconnect; no background access check or chat replay is
   added. Retry waits use elapsed monotonic time, capped at five minutes. HTTP-date
   retry headers require a valid host Date; otherwise retry is available manually.
   On browsers whose monotonic clock pauses during sleep, a wait resumes after
   waking. Host-side rate limits apply regardless of the browser timer.
9. Revoke a key to end permission and its active requests. **Stop hosting** ends
   all guest requests, the request inbox, the tunnel and local serving together;
   the host UI no longer exposes a control that stops only the public half.
   Unrevoked keys retain permission when the same model and their channel resume,
   and are kept and reusable at the next address; a restarted tunnel has a new URL,
   which must be sent to guests again. Revoke keys to permanently end that
   permission.

The **Host on the internet** form uses an explicitly selected model from the page
address, or the model and host name last reported by this gateway. A fresh gateway
requires an explicit model choice. Stopping and restarting hosting in the same
gateway run preserves its configuration; a missing model stays selected with recovery guidance
instead of being replaced by a different installed model. A link for another model
explains what is currently shared and requires an explicit **Stop hosting** before switching.
Host-name drafts stay in this owner tab while you visit Playground or other workspace
pages. Discard name draft returns to the last reported server name without changing
it. A matching successful **Start hosting** clears the draft; failed or lost responses and
background status checks retain it, including when another name is running. Reload
or closing the tab clears unsaved edits. Draft names never enter browser storage or
leave the browser before an explicit Start.

Before starting, **Host on the internet** shows whether this model name has a completed,
nonempty answer in its retained Playground conversation. That observation is
optional and does not gate Start. Switching models checks their separate histories;
Clear and reload remove the corresponding evidence. It is not tied to a model-file
digest, does not prove current availability or memory fit, and is not a durable
readiness record.

Access keys show permission separately from current availability. Stopped hosting,
a different served model, or an unreachable public address pauses their use;
it does not revoke them. Pausing is not revocation, and a paused key can still be
looked up, copied and revoked. Failed status checks show unknown availability. An active
permission badge is not a guarantee that inference will succeed or capacity is free.

Hosting starts stopped after every Java restart. Stopping hosting leaves the guest
local listener/static page available to show connection errors; closing the gateway
closes the listener and its connections. No active guest work survives stopping.
This closes HostAI's upstream exchange; it cannot prove an independent Ollama
process has freed GPU resources or stopped work shared with another caller.

## Controls and limits

- A key permits exactly one model and one channel, checked before metadata
  probing or inference. Internet keys are rejected by the local listener and vice versa.
  The channel comes from the listener that received the request, never from a
  forwarded header. The host UI now creates only `internet` keys; the binding
  remains a server-side security boundary, and pre-existing `local` keys still
  authenticate on the local listener.
- The key is `hga1.<grant id>.<secret>`, exactly 85 characters, carrying a random
  256-bit secret. The durable file now stores that secret alongside its SHA-256
  hash so the host can read the key back, but the hash stays authoritative:
  authentication digests the presented secret, compares it in constant time and
  never consults the stored secret. See
  [storage and configuration](#storage-and-configuration) for what retaining the
  secret does and does not change.
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
  expiry, protocol scope, limits and the shared model's `ui` (`null` or
  `{"runtime", "entry"}`). A name is not a verified identity. The host
  operator receives submitted messages.
- Static assets are local, protected with CSP, and carry no owner router. Guest
  API and owner grant responses use `Cache-Control: no-store`. Error messages do
  not echo credentials, arbitrary upstream bodies or storage paths.

## A model's own interface

Guest sessions report `capabilities: {chat, infer}` independently of `ui`.
Chat-capable HostAI runtimes can use the same default guest chat as Ollama,
over both local HTTP and public WebSocket transports. A model needs either
chat support or a custom UI with inference support to be shared. If a runtime
loses both, reconnect reports it unavailable and the guest page shows
**No supported interface** without a composer. See the
[runtime chat contract](model-ui.md#post-hostaichat).

A model served by a HostAI-protocol runtime whose manifest declares `ui` (see
[model UI and the runtime protocol](model-ui.md)) replaces the guest transcript
and composer with the runtime's own page, under a **Model interface** heading.
The access panel above it is unchanged: the guest still connects with a key,
sees the host name, model and disclosures, and can disconnect. Whatever the page
shows lives only inside that frame in the tab; HostAI does not persist it, and
reload, Disconnect or a changed session discards it.

Guest listener additions:

- `GET /guest/v1/session` gains `ui`: `null`, or `{"runtime", "entry"}` for the
  shared model.
- `POST /guest/v1/infer` mirrors `/guest/v1/chat`: the bearer key is checked
  before the body is read, `Content-Type: application/json` is required, the body
  is `{"model", "input"}` with any JSON `input`, and the same one-slot-per-key,
  six-per-minute and granted-model rules apply. It streams the owner
  `/api/infer` records: `{"event": <json>, "done": false}` and a final `{"done":
  true}`, optionally with `event` or `error`. On the internet channel it returns
  409; public guests use the WebSocket.
- WebSocket `/guest/v1/chat-stream`: the first message may be `{"key": "…",
  "infer": {"model": "…", "input": <json>}}` instead of `{"key": "…",
  "request": …}`. Every following frame is then an infer record.
- `GET /guest/v1/model-ui/{runtime}/{path}` serves the runtime's interface files
  and the gateway's own `hostai-bridge.js`. It requires no key, because the
  browser loads the frame with a plain request, and answers only while guest
  access is running for a model of that runtime; otherwise 404. Path, extension
  and header rules match the owner route: `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and the
  model-UI Content-Security-Policy with this listener's own browser-facing origin
  (`http://<Host>` locally, the tunnel origin publicly). These responses omit
  `X-Frame-Options` and `Cross-Origin-Resource-Policy`, unlike the listener's
  other responses, so the sandboxed frame can be embedded and load its own files.
- The guest page's own Content-Security-Policy adds `frame-src 'self'`; nothing
  else in it changes.

The frame is an `iframe` with `sandbox="allow-scripts"`: opaque origin, no
network, no storage, no access to the guest document. **Keys never enter the
frame.** The guest page performs inference on the frame's behalf — `POST
/guest/v1/infer` with the bearer header on the local channel, the WebSocket `infer`
envelope on the internet channel — and relays events, completion and a fixed
failure message back through the bridge; server error text is never forwarded
to a guest frame. The interface files are the host's runtime code, served under
this sandbox to every guest.

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
can revoke them in the same Access keys list; it never receives the guest-held
raw secret, so these grants are stored hash-only and cannot be shown again.
Stopping request intake leaves approved permissions valid.

The versioned JSON file is `grants.json`, bounded to 128 KiB and 100 total keys,
including revoked and expired keys. Schema v1 grants are read as local only;
schema v2 added explicit channels; **schema v3 adds a `secret` field and is what
every mutation now writes**. Migration is lazy: an older file is upgraded on the
next durable write. Older builds cannot read schema v3, so the bump is one-way.
A v3 row is validated as an exact field set, and a stored secret that does not
hash to its own row's `hash` rejects the whole file.

**`grants.json` now holds live credentials rather than only hashes.** This is a
deliberate trade. Storing only a hash meant a key could never be looked up again,
which forced the invite URL to be minted at creation time, which in turn forced key
creation to require a live tunnel; making the key a durable, recoverable credential
is what removed all three constraints. The mitigating context is that the owner API
has no authentication at all and is loopback-bound, so any process that can read
`grants.json` can equally well call `POST /api/sharing/grants` and mint itself a new
key. Hashing at rest only ever defended against file-only disclosure — a backup, a
synced folder, a stray copy of the home directory — and that defence is now gone.
The remaining protection is the file's 0600 mode inside the host's own
account-private store directory, which is under the host's home directory by
default. Revocation does not erase the secret: a revoked row keeps its key
material on disk and is refused by policy until **Remove expired and revoked keys**
deletes the row.

Rows carried over from an older file stay hash-only and are permanently
non-recoverable, as are grants committed from a guest-supplied secret. Such a grant
reports `recoverable: false`, offers the host no **Show key**, and can only be
revoked. `recoverable` describes storage, not permission: a non-recoverable key
still authenticates normally.

**Access keys → Remove expired and revoked keys** frees stored-key slots
explicitly. The gateway checks eligibility against its own clock
at removal; the displayed count is advisory. Active permissions, including paused
local and internet keys, are preserved. Removal is durable and irreversible, even
if the clock later moves backward. Nothing is pruned automatically, and cleanup
does not start hosting, create keys or send anything to a guest. A lost reply is reported
as unconfirmed and status is refreshed without automatically retrying cleanup.
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
small NDJSON records. The local channel keeps HTTP NDJSON. The WebSocket route
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
session/chat requests and reveals the public address and its QR code.

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
describes its temporary hosting limits. Hosts send invitations privately; there
is no shared host directory or public listing.

## API summary

Owner routes are under `/api/sharing` on the owner gateway/proxy. Mutations require
JSON and enforce exact browser Origin checks. They do not grant CORS access.

| Method and owner path | Body | Result |
| --- | --- | --- |
| GET `/api/sharing` | — | State (`stopped`, `local`, `unavailable`), host name, selected model, local guest URL, error, grant metadata including `recoverable`, and nested `internet` status; never key material |
| POST `/api/sharing/start` | `{ "model": "model:tag", "hostLabel": "My host" }` | Current state; switching model/name while enabled requires stopping first |
| POST `/api/sharing/stop` | `{}` | Stopped access and terminated guest work; grants remain |
| POST `/api/sharing/internet/start` | `{}` | Begin an explicit temporary tunnel attempt; returns current full status |
| POST `/api/sharing/internet/stop` | `{}` | Block public access and begin teardown; local access remains. Still served, but the host page no longer calls it |
| POST `/api/sharing/grants` | `{ "label": "Visitor", "expiresInHours": 24, "channel": "internet" }` | `{ "grant": …, "token": "hga1.…" }`. Requires access to be started, not a live tunnel. No invite URL is returned or stored |
| POST `/api/sharing/grants/<UUID>/key` | `{}` | `{ "token": "hga1.<id>.<secret>" }` for a recoverable, active grant. 404 unknown, 409 revoked/expired/non-recoverable, 400 malformed id. Independent of publication state: it answers while access is stopped |
| POST `/api/sharing/grants/<UUID>/revoke` | `{}` | Updated state after durable revocation; repeating a known revoke is idempotent |
| POST `/api/sharing/grants/cleanup` | `{}` | `{ status, removedCount }` after durable removal of expired/revoked records; `status.removableKeys` reports current gateway eligibility |

On the guest listener, GET `/guest/v1/session` and POST `/guest/v1/chat` require
one Authorization bearer header. Session metadata includes `hostLabel`, `model`,
`expiresAt`, `available`, nullable `unavailableReason`, `maxConcurrentGuests: 1`,
`maxTokens: 1024`, `requestsPerMinute: 6` and `scope: "local-preview"` or
`"temporary-internet"`. An omitted creation channel still defaults to `local` at
the API; the host page always sends `internet`.

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
