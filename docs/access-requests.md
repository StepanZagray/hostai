# Guest access requests

Hosts can explicitly approve guests from an in-app request inbox for
internet guest access; manual invitations remain available. It does not add
accounts, verified identities, end-to-end encryption or production hosting.

## Host consent and guest flow

A host first starts client access for an installed model, then explicitly starts
Cloudflare internet sharing. After the public connection is verified, the host
can separately choose **Allow access requests**. Request intake starts off after
every gateway restart and every new tunnel attempt. Publishing a directory
listing never enables requests or grants access.

The guest page discovers whether this host accepts requests. The guest enters a
name, reviews the model and submits a request. The host sees that unverified name,
the shared model and a matching code. The code helps distinguish requests; it does
not verify a person. The host must choose a duration before approving. Approval
allows only the selected model over the internet, for 1–168 hours.

Approval creates a durable permission immediately. The guest then explicitly
chooses **Connect**; connecting reads metadata and does not generate a response.
The browser keeps its credentials in memory only. Disconnecting, reloading or closing the tab
loses them. An approved permission still lasts until expiry or revocation even if
the guest loses its credential, just like a manually created invitation that was
never copied.

**Stop requests** closes the inbox, leaving approved keys and the tunnel usable.
**Stop internet sharing** closes public access. **Revoke** in Access keys ends that
key's permission and active generation. An explicit guest cancellation racing with
approval either prevents issuance or durably revokes the newly approved key before
reporting cancellation. Closing a tab does not automatically cancel a request.

## Credential and lifecycle boundary

The supported guest client generates two independent random 256-bit secrets: one
for requesting/polling/cancelling, and one for the eventual access key. It sends
only SHA-256 of the access secret for approval. The host stores the request bearer
hash in a bounded in-memory inbox and commits the access-secret hash to the existing
private grant store when the owner approves. Neither secret appears in a URL,
cookie, browser storage, directory listing or owner response.

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
  does not free a stored-key slot. There is no key deletion control yet.
- Request bodies are bounded to 2 KiB and a five-second upload deadline. Names
  are at most 40 UTF-16 units and exclude controls, formatting characters and
  surrogate characters. There is no freeform request message.

These are bounded admission controls, not comprehensive denial-of-service
protection. Unknown clients can exhaust admission for new requests, while existing
request holders retain separate polling and cancellation budgets. A host can
stop request intake and continue using private invitations.

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

Guest request routes exist only on the verified internet listener. Local preview
returns 404. They reject cross-origin browser requests and credential queries.

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
