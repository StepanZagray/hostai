# Guest access requests

Hosts can explicitly approve guests from an in-app request inbox for
internet guest access. This is the secondary way in: the primary one is an access
key the host creates and sends, and the inbox exists for a guest who does not have
one. It does not add accounts, verified identities, end-to-end encryption or
production hosting.

## Host consent and guest flow

A host first presses **Start hosting**, which serves an installed model and starts
the Cloudflare tunnel as one action. After the public connection is verified, the
host can separately choose **Allow access requests**. Request intake starts off
after every gateway restart and every new tunnel attempt. Send the public guest
page address privately to the intended visitor. That address carries no credential
and never grants chat permission by itself.

The **Access key** input is the primary action on the guest page: it is always
rendered, always expanded, and focused on load, on both HTTP and HTTPS origins.
The page separately discovers whether this host accepts requests. When it does and
no request exists yet, requesting access waits below the key form inside a closed
disclosure summarised **No key? Ask the host for access**. Once a request is
actually under way its panel renders expanded and is never hidden, so its code,
status, timer and cancellation stay reachable. If requests are unavailable,
unsupported or fail to load, only the key form is offered and the page says an
existing key still works. The request flow is absent entirely on a non-HTTPS
origin, because the gateway serves no request routes there. Discovery never steals
keyboard focus or submits either form. Changing intake availability preserves a key
already being entered.

An unsent name stays editable through failed host-detail refreshes or closed intake,
and survives connecting with an access key and disconnecting chat. It lives only in
this tab's memory; reloading or closing the tab clears it. Refreshing details never
submits it. Submission requires current accepting-host details and an explicit action.
The form checks the inbox's name restrictions before generating credentials and
explains unsupported characters inline; the server remains authoritative.

A first submission rejected with HTTP 400 restores the name for correction and
requires refreshing host details before submitting again. The inbox rejects those
details before creating a request. A lost response remains uncertain: retries keep
the original name, model and credentials, even if a retry then returns 400.

The guest enters a
name, reviews the model and submits a request. The host sees that unverified name,
the shared model and a matching code. The code helps distinguish requests; it does
not verify a person. The host must choose a duration before approving. Approval
allows only the selected model over the internet, for 1–168 hours.

Approval creates a durable permission immediately. The guest then explicitly
chooses **Connect**; connecting reads metadata and does not generate a response.
The conversation area appears after a session exists; access failures retain an
existing conversation and draft. Credentials stay in memory only. **Disconnect**
clears the active conversation and chat draft, while retaining this tab's access request
and its credentials so the guest can cancel or explicitly connect again. Reloading
or closing the tab loses all of them. An approved permission still lasts until expiry or revocation even if
the guest loses its credential. Unlike a host-created key, it cannot be looked up
and sent again: the host never held that secret, so the only remedy is to revoke
the key and approve a fresh request.

**Stop requests** closes the inbox, leaving approved keys and the tunnel usable.
**Stop hosting** closes public access and local serving together. **Revoke** in Access keys ends that
key's permission and active generation. An explicit guest cancellation racing with
approval either prevents issuance or durably revokes the newly approved key before
reporting cancellation. Closing a tab does not automatically cancel a request.

After connecting, **Manage access request** keeps request status and cancellation
reachable without filling the conversation page with the full onboarding form.
It remains available when using another key; the page distinguishes that separate
request from the current chat permission. **Keep current access** backs out of key
entry without changing the key or the draft.

Cancelling the request used by this chat pauses sends and reconnects with that key,
closes its active stream, and retains the transcript and draft. A lost cancellation
response remains unconfirmed; the same cancellation can be retried after Disconnect,
without a new submission or credential. Disconnect during an in-flight cancellation
lets that operation finish. Confirmed terminal outcomes stay visible. A failed
revocation does not claim that the key was revoked: the guest is directed to the
host. Cancelling a different retained request does not revoke or pause a manually
entered, unrelated key.

The recovery record expires independently of the durable grant. When the local
recovery timer ends, the UI offers **Try cancellation** and explains that the host
may no longer have its record. It does not prevent an explicit attempt based only
on this browser's timer. If cancellation cannot be confirmed, the host must revoke
the key in Access keys. An expired or missing request record never proves key
revocation. **Discard this request…** still requires the existing explicit warning;
it forgets the request credentials without revoking permission or disconnecting
an independently retained active chat key.

## Credential and lifecycle boundary

The supported guest client generates two independent random 256-bit secrets: one
for requesting/polling/cancelling, and one for the eventual access key. It sends
only SHA-256 of the access secret for approval. The host stores the request bearer
hash in a bounded in-memory inbox and commits the access-secret hash to the existing
private grant store when the owner approves. That grant is therefore stored
hash-only and reports `recoverable: false`, so the host can never display it, even
though host-created keys in the same store are now recoverable. Neither secret appears in a URL,
cookie, browser storage or owner response.

The server assigns the grant UUID. An approved guest recovers that UUID through
its authenticated request status and assembles the usual `hga1` bearer locally.
Lost submission/status responses can be retried with the same request credential,
independently of whether the host currently accepts new requests;
repeated approval cannot create a second key. Reusing a request credential with a
different name, model or commitment is rejected. There is no server-held raw-token
handoff or claim state.

The server cannot enforce random secret generation by a modified guest client.
Such a client can choose a guessable 32-byte access secret or disclose its own
bearer permission. Owner-approved scope, duration and revocation still apply.
Grant IDs and commitments are not published. Cloudflare terminates TLS and can
see relayed messages and credentials; this feature does not change that boundary.

Backgrounding the tab pauses status polling, but an already-started submit or
cancellation keeps its bounded ten-second request deadline. A stalled mutation
still becomes uncertain and requires manual retry. Closing the page aborts local
work without sending cancellation.

The inbox is bound to a tunnel attempt, public origin, model and host name. A
reachability interruption pauses requests and approvals while retaining the inbox
for recovery within the same attempt. Stopping, replacing the tunnel, changing the
shared model or restarting clears it. Storage errors stop guest access. Approval,
cancellation and durable grant changes are serialized under the sharing service's
monitor. If a tunnel changes during a successful grant write, the service revokes
that grant before returning failure.

## Bounds and recovery

- At most 10 pending requests and 100 temporary request records. Pending requests
  expire after 10 minutes; records disappear within 15 minutes of submission.
- New requests have a burst of six, refilling one per 10 seconds. Unknown request
  credentials share a burst of 30, refilling four per second. Each known request
  independently allows a burst of 12 authenticated actions, refilling two per
  second; anonymous traffic cannot consume this allowance. Discovery has its own
  burst of 12, refilling two per second. Polling the same record is limited to
  once per two seconds. The page normally checks every five seconds while visible
  and respects `Retry-After`.
- At most 20 active request-created keys and 100 total stored keys. The latter
  includes expired and revoked keys: revocation frees an active request slot but
  does not itself free a stored-key slot. Use **Remove expired and revoked keys**
  in Access keys to recover stored capacity. Active and paused permissions remain,
  and pending requests still need explicit approval after cleanup.
- Request bodies are bounded to 2 KiB and a five-second upload deadline. Names
  are at most 40 UTF-16 units and exclude controls, formatting characters and
  surrogate characters. There is no freeform request message.

These are bounded admission controls, not comprehensive denial-of-service
protection. Unknown clients can exhaust admission for new requests, while existing
request holders retain separate polling and cancellation budgets. A host can
stop request intake and continue issuing access keys directly.

## API

All owner mutations return the full sharing status. Its nested `requests` object
contains `enabled`, `available`, `intakeId`, remaining total/request key slots and
bounded owner request metadata. It never contains secrets or commitments.

| Owner POST path | JSON body |
| --- | --- |
| `/api/sharing/requests/start` | `{}` |
| `/api/sharing/requests/stop` | `{}` |
| `/api/sharing/requests/<UUID>/approve` | `{ "code": "ABC123", "expiresInHours": 24 }` |
| `/api/sharing/requests/<UUID>/reject` | `{ "code": "ABC123" }` |

Guest request routes exist only on the verified internet listener. The local
listener returns 404. They reject cross-origin browser requests and credential queries.

| Guest route | Authentication / body |
| --- | --- |
| GET `/guest/v1/hello` | No key. Returns protocol version, whether requests are accepted, and current intake/model/host metadata only when available. |
| POST `/guest/v1/requests` | `Bearer hgq1.<request-secret>`; `{ intakeId, name, model, accessCommitment }` |
| GET `/guest/v1/requests/self` | Same request bearer |
| POST `/guest/v1/requests/self/cancel` | Same request bearer; `{}` |

Request responses contain a server-assigned ID, matching code, name, model,
internet channel, relative remaining record lifetime and a state: `pending`,
`approved`, `rejected`, `cancelled`, `expired`, `revoked` or `failed`. Approved
responses include the public grant ID and its expiry. Owner rows additionally
include the submission timestamp. Request deadlines use a monotonic clock;
committed key expiry uses the same wall clock as existing manual grants.
