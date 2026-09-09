# Local guest access

HostAI has three loopback listeners: the owner web workspace (3000), owner Java
API (8080), and an explicitly enabled guest listener (8081). The guest listener
has an independent routing graph and static frontend bundle. It exposes no model
management, request history, owner status, actuator, or owner-page routes.

There is **no Cloudflare Tunnel, Tailscale integration, public URL, TLS ingress,
external reachability check, directory or verified host identity**. This feature
is a local preview on the same machine. A localhost bind and Host/origin checks
do not authenticate other local processes; owner controls remain unauthenticated.

## Host and client flow

1. Download/select a local model and try a prompt in Playground.
2. Open Client access, select the model and a name clients will see, then start
   local client access. This checks installed-model metadata; it does not prove
   that inference fits memory, test a prompt, or preload the model.
3. Create a named key expiring in 1 hour, 24 hours or 7 days. Copy the link once;
   it cannot be recovered later. Anyone possessing it has its permission.
4. Open the link in another browser tab on this machine. The guest page removes
   its `#access=` fragment before requesting metadata and keeps the key in memory.
   It sends credentials only in `Authorization: Bearer …`, never cookies, queries
   or browser storage. Connecting does not automatically generate a response.
5. Chat, Stop, or reconnect. Same-key reconnect retains the draft and transcript;
   a different key, Disconnect, or reload clears them. Unfinished exchanges remain
   visible but are excluded from subsequent model context. Retry is manual.
6. Revoke a key to end permission and its active requests. Stop client access to
   end all guest requests. Unrevoked keys work again when the same model resumes.

Access starts stopped after every Java restart. Stopping access leaves the guest
listener/static page available to show connection errors; closing the gateway
closes the listener and its connections. No active guest work survives stopping.
This closes HostAI's upstream exchange; it cannot prove an independent Ollama
process has freed GPU resources or stopped work shared with another caller.

## Controls and limits

- A key permits exactly one model, checked before metadata probing or inference.
- The key contains a random 256-bit secret. The durable file stores its SHA-256
  hash and grant metadata; authentication compares hashes in constant time.
- Revocation is committed before success is returned. Expiry and revocation also
  terminate an active generation. Errors before the first record use HTTP errors;
  after streaming begins, they use a terminal NDJSON error record.
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
permissions. `HOSTAI_GUEST_PORT` changes the guest port (default 8081).

Storage requires POSIX permissions, stable file identities, exclusive locking,
atomic rename and directory fsync. The store directory is 0700 and files are 0600.
Only one gateway can open a store. Windows/non-POSIX storage support is not
implemented; Linux is verified. No existing permission is silently repaired.

The versioned JSON file is bounded to 128 KiB and 100 total keys, including revoked
and expired keys. There is no pruning/delete UI yet. Raw keys are never stored.
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

## Internet-sharing follow-up

For a browser link usable without joining a private network, an outbound HTTPS
transport such as Cloudflare Tunnel is a candidate. Tailscale Serve is a candidate
for private tailnet access; Tailscale Funnel exposes a service publicly. None is
selected or wired into the application yet. A tunnel provides transport and does
not replace model permissions, key lifecycle or owner/guest separation.

Next work must establish the intended public origin, HTTPS, verified reachability,
transport process ownership/recovery, and a Stop sharing operation that withdraws
public access. Publish only the guest listener after validating that deployment
boundary. Host discovery additionally needs an explicit registry, identity and
freshness/heartbeat service. A saved or listed address is not proof of reachability.

Provider distinctions follow [Tailscale Funnel/Serve documentation](https://tailscale.com/docs/features/tailscale-funnel)
and [Cloudflare's Tunnel and Access documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).

## API summary

Owner routes are under `/api/sharing` on the owner gateway/proxy. Mutations require
JSON and enforce exact browser Origin checks. They do not grant CORS access.

| Method and owner path | Body | Result |
| --- | --- | --- |
| GET `/api/sharing` | — | State (`stopped`, `local`, `unavailable`), host name, selected model, local guest URL, error and grant metadata; never raw keys |
| POST `/api/sharing/start` | `{ "model": "model:tag", "hostLabel": "My host" }` | Current state; switching model/name while enabled requires stopping first |
| POST `/api/sharing/stop` | `{}` | Stopped access and terminated guest work; grants remain |
| POST `/api/sharing/grants` | `{ "label": "Visitor", "expiresInHours": 24 }` | Grant metadata, raw token and fragment invite URL, returned only by creation |
| POST `/api/sharing/grants/<UUID>/revoke` | `{}` | Updated state after durable revocation; repeating a known revoke is idempotent |

On the guest listener, GET `/guest/v1/session` and POST `/guest/v1/chat` require
one Authorization bearer header. Session metadata includes `hostLabel`, `model`,
`expiresAt`, `available`, nullable `unavailableReason`, `maxConcurrentGuests: 1`,
`maxTokens: 1024`, `requestsPerMinute: 6` and `scope: "local-preview"`.

Chat accepts the existing `model`, `messages`, `temperature` and `maxTokens` JSON
contract with the stricter guest cap. It streams the existing `content`, `done`,
optional `outputTokens` and `error` NDJSON records. The first `done: true` record
terminates the client protocol. Missing/unknown/expired/revoked keys get a uniform
401. A valid key while access is stopped gets 503; a request for an ungranted
model gets 403. A key for a different current publication is rejected with 401.
