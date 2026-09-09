# Optional host directory

Hosts can explicitly publish their shared model to a configured directory. Clients
can search that directory in **Find a host**, or use its standalone browser page
without installing HostAI or downloading a model. Opening a result leads to the
host's separate guest chat page. **The guest still needs an invitation key from
the host.** The directory never issues keys and there is no in-app access-request
or contact flow yet.

The repository includes a self-hostable reference registry; it does not configure
or deploy a public shared directory. Registration is open, with bounded storage
and rate limits. Accounts, moderation, spam resistance, verified identities,
verified ownership of guest URLs, and production denial-of-service protection
are not implemented. Use it as a small development service until those operating
requirements are addressed.

## Host workflow

1. Download/select a tagged local model and test it in Playground.
2. Start client access, then explicitly start Cloudflare internet sharing. Wait
   for the public WebSocket reachability check to pass.
3. In **Let clients find this host**, read which metadata becomes public and choose
   **Publish listing**. The gateway must already have `HOSTAI_DIRECTORY_URL` set
   to the directory's HTTPS root origin and have been restarted.
4. Create an internet invitation key and give it privately to the intended guest.
   Publishing a listing does not grant chat permission.
5. **Remove listing** withdraws discovery only. The tunnel and existing keys stay
   usable. **Stop internet sharing** closes public access; **Revoke** ends a key's
   permission and active requests.

Only the host name, one model, credential-free guest URL, stable installation ID,
update/expiry times and invitation requirement appear in the directory. Search
stays in the browser and browsing does not contact listed hosts. Opening a guest
page contacts that host and Cloudflare; Cloudflare terminates TLS and can see
messages and keys. See [guest access](guest-access.md).

Each successful tunnel check triggers a listing heartbeat while the host remains
opted in. A listing is fresh for 90 seconds after the registry receives its update;
expired entries can be shown explicitly, with navigation disabled, and are removed
after at most 15 minutes; a full registry can replace an expired entry earlier. “Updated” reports a host heartbeat, not verified availability.
Browser freshness uses registry time plus conservative local elapsed time, so a
different browser clock does not keep an expired listing clickable.

Stopping a tunnel or changing its attempt/address clears publication consent and
attempts a signed withdrawal. A transient interrupted check can recover only on
the same attempt/address. Restarting the gateway begins with publication off.
Failed or uncertain removal is reported: a listing may remain fresh for up to
90 seconds after its last update. Removing a listing never stops the tunnel or
revokes a guest key. A failed refresh keeps previous search results visible but
disables opening them until a successful refresh.

## Run the registry locally

Node 24 or newer is required, including its built-in SQLite support. No additional
registry dependencies, account, cloud credentials or outbound host probing are
used. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
mkdir -p "$HOME/.local/share"
pnpm directory:start
```

The registry listens only on `127.0.0.1:8090`. Its standalone page is available at
that address; it exposes neither the owner workspace nor owner APIs. The default
data directory is `~/.local/share/hostai-directory`; its parent must already exist.
`HOSTAI_DIRECTORY_DATA_DIR` can select a dedicated directory, and
`HOSTAI_DIRECTORY_PORT` changes the port. Directory data and signing identities
require private POSIX storage; Linux is tested.

For a host gateway using this same-machine development registry, set these in the
gateway's environment before starting it:

```sh
export HOSTAI_DIRECTORY_URL=http://127.0.0.1:8090
export HOSTAI_DIRECTORY_ALLOW_LOOPBACK=true
pnpm start
```

Plain HTTP is otherwise rejected by the gateway. The development exception only
accepts literal `127.0.0.1` with an explicit port. This local setup does not make
the directory reachable by other computers or replace the separate public tunnel.

For an operator-provided public registry, place a TLS reverse proxy in front of
the loopback registry and set `HOSTAI_DIRECTORY_PUBLIC_ORIGIN` on the registry to
the canonical HTTPS root origin, for example `https://directory.example`.
Preserve that exact Host header on upstream requests and serve both the client
page and `/registry/v1/*` from this origin. Each host configures the same origin
as `HOSTAI_DIRECTORY_URL`. The server validates Host and browser Origin and
ignores forwarding headers. All clients behind the same proxy share its bounded
socket-peer rate budget; these limits are not a production abuse defense.
There is no automatic deployment, default public domain or cross-directory search.

## Identity and protocol

Each configured access store has a distinct private sibling wrapper named
`.hostai-directory-<SHA256 of absolute access-store path>`, containing an `identity`
directory. This keeps the grant store's strict schema separate and permits a
custom grant directory under a shared parent such as `/tmp`. The signing key is
created only on first publication. It persists across gateway restarts and tunnel
URL changes; it proves continuity of the installation's signing key, **not a
person's identity or ownership of the listed URL**. No key is stored in a listing.
Unsafe permissions, symlinks, corruption and competing process ownership fail
closed without repairing or rotating the identity. Owner chat remains available.

The registry is deliberately passive: it never fetches a submitted URL. Signed
updates use Ed25519, canonical base64url (no padding), a 44-byte DER SPKI public
key and a 64-byte signature. The host ID is lowercase SHA-256 of the SPKI bytes.

| Route | Purpose |
| --- | --- |
| `GET /registry/v1/listings` | Version, registry `servedAt`, at most 100 public listings |
| `POST /registry/v1/challenges` | `{publicKey}` returns a random nonce and 30-second expiry |
| `POST /registry/v1/listings` | `{publicKey,payload,signature}` publishes or withdraws |

The decoded, signed payload has exactly `version`, `audience`, `nonce`,
`operation` and `listing`. Version is 1. Audience is the exact configured registry
origin without a trailing slash, preventing a different registry from relaying a
host's proof. Operation is `publish` with `{hostLabel,model,guestUrl,invitationRequired:true}`,
or `withdraw` with `listing:null`. Only canonical HTTPS single-label
`trycloudflare.com` guest roots are accepted, without credentials, ports, paths,
queries or fragments. No private invite key can be included.

An unsigned challenge request reuses an outstanding nonce without extending its
expiry. A nonce is tied to the signing identity, consumed once, and discarded on
registry restart. Only authenticated, valid-nonce mutations consume the per-key
budget (six burst requests, refilling one every ten seconds). Global admission,
bounded pending challenges, strict JSON/body limits and socket deadlines bound
other work. A directory can still be filled with attacker-created identities;
cryptographic signing is not a registration or reputation system.

SQLite commits preserve listing ownership and expiry across registry restarts.
Exclusive OS locking, private storage, bounded documents and failed-write checks
prevent uncertain storage from continuing to serve a cached success. No PID lock
file is used. Listings never contain private signing material or guest grants.

The owner gateway exposes fixed-origin `GET /api/directory` status,
`GET /api/directory/listings`, and empty-JSON `POST /api/directory/start` and
`POST /api/directory/stop`. Browser requests cannot choose another registry URL.
Directory GETs and mutations reject cross-origin browser requests at both the
web proxy and Java gateway. At most one registry list read runs at a time;
publication and withdrawal use their independent serialized worker. Network
exchanges have a total five-second monotonic deadline, strict response
schemas and size bounds, and no redirects, credentials, provider-body errors or
automatic request replay. New verified tunnel checks can trigger fresh signed
heartbeats while consent remains enabled.

## Verification

`pnpm directory:test` exercises the actual loopback HTTP server, cryptographic
proofs, replay/cross-registry rejection, rate admission, expiry, storage faults
and cross-process locking. `pnpm backend:test` includes Java protocol/lifecycle
tests and an actual Node-registry interoperability test with a synthetic verified
tunnel observation. UI tests use the isolated headless display runner; set
`HOSTAI_DIRECTORY_TEST_URL` to an explicitly started local registry to exercise
the standalone client page. These fixtures do not prove public deployment,
real-model performance, identity verification or production abuse resistance.
