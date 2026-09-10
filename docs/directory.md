# Optional host directory

Hosts can explicitly publish their shared model to a configured directory. Clients
can search that directory in **Find a host**, or use its standalone browser page
without installing HostAI or downloading a model. Opening a result leads to the
host's separate guest chat page. **The host must approve access**, either through
an invitation key or an explicitly enabled [access-request inbox](access-requests.md).
The directory never issues keys or enables request intake.

The repository includes a self-hostable reference registry; it does not configure
or deploy a public shared directory. Clients can explicitly save hosts in their browser
for a later visit; these saves do not grant permission or verify identity. Registration is open, with bounded storage
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
4. Create an internet invitation key and give it privately to the intended guest,
   or separately allow access requests and review them in Client access. Publishing
   a listing does not grant chat permission.
5. **Remove listing** withdraws discovery only. The tunnel and existing keys stay
   usable. **Stop internet sharing** closes public access; **Revoke** ends a key's
   permission and active requests.

Only the host name, one model, credential-free guest URL, stable installation ID,
update/expiry times, requirement for host permission and reported request availability
appear in the directory. `invitationRequired: true` means clients always need a
key, whether privately supplied or obtained through host approval. Search
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

## Find hosts accepting access requests

**Requests reported open** filters both All listings and Saved hosts by the host's
latest unexpired signed report, even if Include expired listings is selected.
Rows distinguish open, closed and unreported request status.
Closed requests do not invalidate existing invitation keys; opening the guest page
still works when its listing is fresh. An empty filtered view explains how to see
closed or unreported hosts again. Search and this filter never contact hosts.

At each verified tunnel heartbeat, the publisher samples the request inbox's
availability, including intake being enabled and room for another approved key.
The report can become stale before its next heartbeat and remains only a report
until the listing expires. The guest page checks current availability separately,
and the host still decides whether to approve. The owner panel shows the last
confirmed published report and explains that full key capacity can close requests
while intake remains enabled. A failed or uncertain publication clears that report
when its outcome is unknown. Publication neither enables intake
nor promises spare inference capacity. Expired listings and failed directory checks
retain the earlier report but disable opening as before.

Older publishers do not supply this field. Version 2 directory reads represent
these reports as `null`, never as open or closed. Unlisted saved hosts likewise have
no current report. Filtering may hide them; clearing the filter restores the saved
view without removing bookmarks.

## Return to saved hosts

Use **Save host** on a listing, then **Saved hosts** to find that installation again.
Saves survive reload in this browser and are scoped to the exact registry origin
(scheme, hostname and port). The owner workspace and standalone directory website
use different browser origins, so their saves do not sync. Changing the configured
registry selects a separate saved list; switching back restores the earlier saves.

Only the 64-character installation ID and remembered host/model names are stored.
Guest URLs, hostnames, access keys and conversation contents are not saved. Records
use one local-storage key per host, with explicit writes and no automatic eviction.
The UI admits up to 50 saves per directory; remove a save to make room. Different
host edits in other tabs cannot replace the whole list. Same-host actions honor the
Save/Remove intent shown by the control even if a storage event arrives late.

A saved ID resolves only through a successfully checked listing from the same
registry. Opening uses that listing's validated URL and rechecks expiry at click
time. Missing entries remain visible with remembered labels and **Not currently
listed**, without a guest link. Failed checks say **Check unavailable**, and a
pending first check makes no absence claim. These states do not prove the host is
offline: it may have stopped publishing while private invitations still work.

A changed model displays both the saved and current model and requires **Use current
model** before a guest link is offered. Review belongs to the visible listing, so
blocked browser storage does not prevent it. The action also attempts to update
remembered details when storage is usable, but neither opens the host nor grants
access. A failed write or unconfirmed reread leaves its error and remembered model
visible while the reviewed current model can be opened. Keyboard focus moves to
the guest link without activating it.

**Check saved model** retries reading storage. If the saved model still differs,
**Update saved model** explicitly retries the write using fresh listing details.
Temporary review is cleared when that row leaves the view, its current model
changes, the directory changes or the page reloads. Changing only the temporary
address or saved labels does not undo review of the same current model; opening
still uses the current URL and checks freshness. A changed host name displays its saved name too.
The current hostname is always shown; old addresses are not retained or compared.
The installation ID denotes signing-key continuity, not a verified person or URL
owner. Guest session metadata still determines actual access and model permission.

**Remove saved host** removes only that bookmark. **Undo remove** restores the most
recent removal while this directory view remains mounted, including an unlisted
host. Its remembered name and model identify the current undo target. It never restores a URL or permission. Blocked/full/damaged browser storage
produces a visible error; failed reads never reset or overwrite stored data. Check
saved hosts retries storage access, also available beside a changed-model listing.
A completed write followed by a failed reread is reported separately from
a rejected write. Clearing browser site data removes saved hosts.
No automatic host request, prefetch, favicon, account sync or registry write occurs
when saving or browsing saves.

The owner-proxied `/api/directory/listings` response now includes `registryUrl`, added
by the gateway from the same immutable configuration used to fetch that response.
The embedded frontend rejects a missing or mismatched source and tells the owner to
reload setup or update/restart the gateway. This prevents a restarted/reconfigured
gateway from resolving old saves against another registry. The standalone client fetches version 2 listings directly from its own origin.

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
page and both `/registry/v1/*` and `/registry/v2/*` from this origin. Each host configures the same origin
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
| `GET /registry/v2/listings` | Version, registry `servedAt`, at most 100 public listings |
| `POST /registry/v2/challenges` | `{publicKey}` returns a random nonce and 30-second expiry |
| `POST /registry/v2/listings` | `{publicKey,payload,signature}` publishes or withdraws |

The decoded, signed payload has exactly `version`, `audience`, `nonce`,
`operation` and `listing`. Version is 2. Audience is the exact configured registry
origin without a trailing slash, preventing a different registry from relaying a
host's proof. Operation is `publish` with `{hostLabel,model,guestUrl,invitationRequired:true,requestsAccepted:boolean}`,
or `withdraw` with `listing:null`. Only canonical HTTPS single-label
`trycloudflare.com` guest roots are accepted, without credentials, ports, paths,
queries or fragments. No private invite key can be included.

Version 1 routes remain available with their original exact schemas: v1 reads omit
request status, and v1 publishers cannot supply it. A v1 update replaces any prior
capability report with unknown. Payload versions must match the mutation route.
Both versions share the same identities, nonce pool, admission budgets and store;
using another API version does not provide a separate quota or replay opportunity.

Upgrade the registry before the gateway and directory frontend: these clients now
use `/registry/v2/` and do not silently downgrade to a registry without v2. Older
v1 clients and publishers continue to work against the updated registry. Storage
reads existing document version 1 and writes version 2 on the next mutation; new
stores start at document version 2. The SQLite table and signing-key format do not
change. An older registry binary cannot reopen a version 2 document; take an
operator-managed backup before an upgrade if rollback is needed. No deployed
registry or existing user database was upgraded during development.

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
