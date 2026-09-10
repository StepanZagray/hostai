# Autonomous improvement log

## Keep downloads intact through workspace navigation

Claude Opus 5 High advised moving the download session into the owner workspace:
leaving Models previously discarded drafts and recovery details and aborted the
browser's pending mutation. The owner tab now retains the model entry, validation
state, pending actions, uncertain request IDs and up to 20 missing-job notices.
Returning to Models checks status immediately without repeating a mutation. An
explicit retry keeps the original uncertain request ID and model.

Checks start only after the first Models visit. One polling loop then continues
while the document is visible, using the existing active/idle intervals. Completed
record tracking is bounded to the currently reported history. DOM focus references
remain local to the mounted panel, so navigation does not restore stale focus.
Nothing is written to browser storage or URLs; reload, closing the tab and a new
tab start a fresh local session. Gateway history remains separate and non-durable.

Nine new isolated browser cases exercise actual navigation links, pending start
and cancel responses, uncertainty, missing records, completion refreshes, blank
and custom drafts, and reload/new-tab boundaries. Narrow and desktop captures were
visually inspected. Download, owner-memory and sharing regressions also pass;
real backend sharing remains an opt-in test and was skipped in this fixture run.

## Recover when the gateway stops reporting a download

Claude Opus 5 High identified that a successful empty status response after a
gateway restart silently removed an observed running job. The client now retains
that job in a separate, bounded collection of unknown outcomes, checks the model
library once per missing episode and offers explicit check, try, start-again and
dismiss actions. A returning ID reconciles with the authoritative response;
evicted completed, failed or cancelled records need no warning.

The outcome stays unknown: a missing record alone cannot establish whether a
download completed, stopped, aged out or continues through another Ollama client.
Starting again uses a new request ID and discloses possible additional transfer.
Dismissing only clears the notice and returns focus to the model input. No model
download, inference or public sharing starts automatically. Recovery history is
limited to 20 notices. Initially these lived in the mounted Models page; the
owner-tab session change above extends their lifetime through navigation.
Gateway history and download resumption remain non-durable.

Browser verification also exposed an early-render starter-selection race. The
model entry and starter selector now remain disabled until initial download
discovery completes, so edits cannot be accepted before the form can retain them.
The check can fail and still release editing; starting still requires known status.

The final Opus review improved keyboard and screen-reader recovery: removal of a
focused Cancel button transfers focus to that model's unknown-status heading,
actions include their model in accessible names, and a persistent live region
announces the missing-record count. Background polling no longer disables the
manual status check; a manual check can join the active poll with visible feedback.
The final browser cases cover these transitions, multiple records and uncertain
starts. Oversized gateway responses remain rejected by the existing API parser.

## Keep model review usable when bookmark storage fails

Claude Opus 5 High confirmed that Use current model was a storage-dependent gate:
a failed write or reread left the old bookmark in memory and prevented the guest
link from appearing. Review now belongs to the visible listing independently of
the bookmark write. The same action still attempts a save when storage is usable;
failures remain visible, and keyboard focus moves to the current guest link without
opening it. Recovery can check storage and explicitly retry updating the saved model.

Review is scoped by registry, host installation and current model. Changing the
model away and back resets it, as do filtering the row out, changing directories
and reload. An address-only or saved-label change preserves review of the exact
same current model. Existing failed-check, provenance and expiry guards still
control opening. No key, URL or review marker is added to browser storage.

The final Opus review identified lost focus after an explicit save retry and a
weak reload assertion. Both retry outcomes now return focus to the guest link,
whose accessible description includes the unconfirmed-save explanation. Browser
tests check that description, focus after failed and successful retries, and that
review was active before reload. Review was static; primary verification runs the UI.

The advisor's separate finding about unknown saved status after an initial storage
read failure remains follow-up work: an error is visible, but an unreadable bookmark
cannot currently supply a remembered model for comparison. This cycle addresses
recovery when a remembered model is available. Verification is recorded below.

## Preserve guest request names through recovery

The unsent request name now belongs to the guest tab controller. Failed details
refreshes, closed intake and connecting/disconnecting with a manual key preserve
the editable draft, including an intentionally emptied field. Fresh accepting-host
details and an explicit submission are still required; reload clears the draft.
Submitted names and credentials stay fixed for uncertain retries.

Claude Opus 5 High reviewed the lifecycle and identified invalid-name rejection
as another recovery trap. The form now checks the inbox's UTF-16 restrictions
before creating credentials and shows an accessible inline error. A first HTTP
400 restores editing and requires refreshed details. Primary inspection confirmed
that the inbox rejects these details before creating a row; a 400 on a retry
cannot establish that an earlier attempt failed, so retry credentials are retained.

Controller tests and isolated browser scenarios cover recovery, no accidental
submission, connection remounts, changed models and unsupported characters. The
saved-host model-review dependency on bookmark storage remains follow-up work.
See verification.md for evidence and test boundaries.

## Report request availability before opening a host

Claude Opus 5 High identified the inability to distinguish hosts accepting requests
from hosts requiring an existing invitation. Directory v2 now signs a boolean
request-availability report with each publication heartbeat. It is sampled from
SharingService's actual request availability, including grant storage capacity,
and does not enable intake or promise approval/inference capacity.

The directory distinguishes reported open, closed and unknown and filters both
all listings and saved hosts without probing guest endpoints. Clearing the filter
reveals hidden bookmarks and closed/unknown reports again. Empty states explain
recovery; existing-key access remains possible when intake is closed. Publisher
consent copy includes the new public field.

V1 routes retain exact schemas and shared admission/nonces; old publications become
unknown in v2, and legacy republishing clears an earlier report. Registry storage
reads documents 1 and 2 and writes 2, including new stores. Update the registry
before new clients; older registry binaries cannot reopen document 2. No deployed
service or user database was changed. See directory.md for the upgrade boundary.

The follow-up Opus review tightened expiry handling so the request filter admits
only unexpired reports in both views, including when expired listings are otherwise
included. Closed-report copy now refers to an existing key, without implying the
host can issue another at full capacity. The owner panel shows its last confirmed
published report; successful publication updates it atomically with timestamps,
and confirmed removal or an unknown publication outcome clears it. A direct
controller-response test confirms legacy null status survives Java serialization.

The advisor also identified request-name loss after details failures and model
review tied to bookmark-storage success. Those remain follow-up work; this cycle
addresses informed discovery end to end.

## Owner retry guidance across models and navigation

Playground now honors valid Retry-After headers on 429/503 responses. One elapsed-time
deadline belongs to the owner tab, so changing models, Clear and navigation cannot
bypass it. The store checks the deadline as well as disabling Send, covering Enter
and direct submission. Drafts remain per-model and editable when the runtime is
available. Expiry announces that the owner may try again, without claiming capacity
is free or generating another request.

The shared parser is the existing guest implementation extracted unchanged: numeric
seconds or a response Date-relative HTTP date, bounded to five minutes. Missing or
invalid values add no guessed delay. One store timer releases the wait; the visible
countdown ticks only while Playground is mounted and waiting, with no per-second
live announcement. Closing the store cancels the timer. Browser suspend may pause
monotonic time, so a courtesy wait can resume after waking; the server owns admission.

Claude Opus 5 High advised shared scope and a store-level guard. Its requested backend
filename was absent; primary inspection found the real ApiErrors handler, which emits
Retry-After: 1 for InferenceRegistry's shared capacity rejection. No invented body
fallback or default five-second delay was added. The existing host-Date parser avoids
the device-clock issue raised by the advisor. Verification is recorded below.

## Retain the sharing draft through a model test

A host-name draft now belongs to the owner workspace tab, so Test model in
playground and returning to Client access preserve the edit. Explicit discard
restores the last reported server name and returns keyboard focus to the field.
A matching successful Start acknowledges the submitted draft; a failed response,
a lost response, or a status poll showing another running name cannot discard it.
The draft remains separate from server state and from all access credentials.
Reload and closing the tab clear it, and no browser storage is used.

Client access derives test evidence from the chosen model name's retained
conversation using the same completed/nonempty predicate as Playground. Switching
models, empty/failed output and clearing history cannot leave a stale tested flag.
The observation is advisory: it neither gates Start nor proves memory fit, current
model-file identity, availability or client capacity.

Claude Opus 5 High advised deriving evidence and using owner-tab state. A dedicated
draft provider keeps form intent separate from conversation state. The suggested
rule to clear on any running status was not adopted: another window or an uncertain
write can report a different running name, and the browser test preserves the draft
through that case. Verification and screenshots are recorded in verification.

## Preserve the intended model when enabling client access

Client access now follows the model in its URL and updates that URL when the host
changes the picker. Without an explicit model link, the form resumes the gateway's
last model and host name; a fresh gateway requires a model choice. Stopping a
non-default model no longer prepares a different model under the default host name.
A removed or inadmissible selection stays visible with an explanation and a model
library recovery link. The submit handler and button share the same admission gate.

Arriving for model B while A is running now explains the mismatch before the host
explicitly stops A and reviews B. The currently served model has its own Playground
link. Key rows distinguish active permission, paused access and unknown status;
switching models or interrupting the tunnel no longer leaves a misleading Valid key
badge. Pausing is explicitly distinct from revoking a key.

Claude Opus 5 High reviewed this handoff and identified selection drift, blocked
selection recovery and misleading key status. Existing per-tab test evidence remains
in Playground; carrying that evidence into Sharing is a separate improvement.
Unsaved host-name edits remain page-local. Validation is recorded in verification.

## Guest access with an incorrect device clock

A successful host access check now remains usable regardless of the guest device's
wall clock. The page no longer invents a 401 or interrupts a stream from local
expiry arithmetic. The host still authenticates every send and terminates expired
streams. Expiry is explicitly labelled host-reported and rendered in the guest's
time zone; idle pages learn that access ended on the next manual send or reconnect.
No relative lifetime contract, countdown, background access check or replay is added.

Retry delays now use monotonic deadlines. HTTP-date delays use the response's Date
instead of the guest date, require a valid host Date, and are capped at five minutes.
Host rate limits remain authoritative. Browser sleep can pause this courtesy wait
on platforms where the monotonic clock stops during suspend.

Claude Opus 5 High confirmed the duplicate-authority bug. Its optional relative
lifetime/countdown design was not needed for this fix: expiry remains informational.
Validation includes wrong clocks in both directions, clock corrections during a
stream, host-reported expiry recovery and existing backend expiry cancellation.
Evidence and limitations are recorded in [verification](verification.md).

## Guest control of requested access after connecting

The request controller now belongs to the guest page, independently of the chat
session reset. Disconnect clears conversation and draft while preserving the
request credentials and current cancellation outcome. Manage access request stays
reachable while chatting or entering another key. Request-key cancellation pauses
that key's active stream and future sends/reconnects; cancellation of an unrelated
request leaves the current manually entered key alone. Key entry also has an
explicit way back to current access without clearing the draft.

Claude Opus 5 High advised preserving the controller across Disconnect instead of
adding another discard confirmation. Existing request-discard warnings remain.
The implementation also lets bounded explicit submit/cancel operations finish when
a tab is backgrounded; polling still pauses and stalled mutations time out.
The final review caught a stale request association after discard/replacement; chat
is now associated with both request and grant IDs. Compact management retains
Cloudflare request-credential disclosure and announces outcomes outside the closed
section. The request recovery window does not define the grant lifetime. Expired recovery
timers allow an explicitly labelled cancellation attempt, and unconfirmed/missing
records or failed revocation point to host revocation without claiming access ended.

Validation and review evidence are recorded in [verification](verification.md).
All credentials remain in memory, and reload/close still lose them. This does not
add a durable guest self-revocation endpoint after the host's request record expires.

## Guest recovery after an unanswered prompt

Guest chat no longer claims completion when a successful stream returns no visible
answer. Empty and whitespace-only replies are marked incomplete, restoring the
question only if the composer is empty. Earlier completed context remains eligible;
retry sends the unanswered question once and never starts automatically. A healthy
session does not need a redundant reconnect just because its model answered empty.

Incomplete exchanges now offer Copy question, preserving a newer independently
typed draft while making the earlier question recoverable on mobile. Stop returns
keyboard focus to the composer and retains its existing non-submit behavior.
Expiry no longer steals focus from a draft into the password field; initial local
key entry and an explicit Use another key action still focus that field.

Claude Opus 5 High audited guest recovery. Its confirmed involuntary-focus finding
was fixed in this cycle. Device-clock expiry, request cancellation after connecting,
model-change context disclosure and backoff/key-entry behavior remain candidates
for separate lifecycle improvements. The advisor read access-request test titles
beyond the requested scope; those observations were verified against local sources.
Frontend and isolated browser evidence are recorded in [verification](verification.md).

## Saved hosts and returning clients

Clients can explicitly save a host in the directory website or owner workspace,
then return through Saved hosts after a reload. Saves retain only installation
IDs and remembered host/model names, scoped to the exact registry and browser
origin. Missing listings remain visible; failed checks and expired listings cannot
provide an open link. Changed models require explicit acknowledgement before
opening the current listing. No address, credential or conversation is persisted.

Claude Opus 5 High supplied independent advice and a final read-only review. The
implementation uses one storage key per host, preserves the action actually shown
when another tab writes, and makes the last removed host explicit beside Undo.
Review fixes distinguish successful writes with failed rereads, tolerate concurrent
removal during enumeration, and place storage recovery beside blocked model review.
Host-supplied labels are isolated for bidirectional text; they remain unverified.
Gateway responses now identify their configured registry, preventing a configuration
change from attaching one registry's saved identities to another registry's rows.
An older gateway needs updating/restarting with this frontend.

Validation and isolated visual evidence are recorded in [verification](verification.md).
These saves do not synchronize accounts or browser origins, prove host/URL ownership,
or restore credentials. The directory still requires explicit configuration and
hosting; no default public registry or production tunnel was added.

## Starter models before an explicit download

The download form now offers three dated, source-linked text-chat starters with
approximate published sizes. Selecting one only fills the explicit tag field;
custom local tags remain available. Installed choices lead with Try installed model,
while Download again remains a secondary explicit action. Actual runtime admission
still gates Try. A connected empty library now points into the chooser rather than
sending the host back to setup.

The chooser remains readable offline and locks together with the tag field during
pending/uncertain starts. Existing retry request IDs, cancellation and completion
handoffs remain intact. Published file size is explicitly separated from RAM/VRAM
requirements, available capacity and the amount transferred after cache reuse.
The shortlist and source dates are documented in [starter models](starter-models.md).

Claude Opus 5 High supplied focused read-only advice about explicit selection,
uncertain-start locking, installed-model shortcuts and the empty-library detour.
The implementation uses a native select to keep the download panel compact; source
links sit outside the control. It keeps an explicit Download again action instead
of removing update access for installed tags. Published sizes and tag pages were
checked directly; they are not inferred hardware-fit or quality measurements.

Validation: 287 frontend tests, type/lint/format checks, production builds and 36
isolated browser scenarios passed. Tests cover source/size changes, custom tags,
no automatic download/chat, same-model handoff, installed and blocked starters,
offline information, uncertainty locking, keyboard navigation and 320/768/1440px
layouts. The first run's sole failure expected the wrong offline setup-link label;
the existing Open setup action was present. The corrected final run passed.
Screenshots were visually inspected. No real model download, GPU inference, Java
integration run or public tunnel was performed in this frontend cycle.

## Owner conversations retained per model

Owner Playground now keeps each model's conversation, draft and run settings in
workspace tab memory. Navigation and explicit model switching retain that work;
leaving stops generation and preserves partial output and the restored prompt.
Returning never sends automatically. Clear affects only the selected history and
retains its draft/settings. Reload or closing the tab clears all conversations.

The selected model stays pinned if discovery temporarily loses it, including when
the only work is an unsent draft. Recovery now points to the model library instead
of telling an already connected host to connect Ollama again. Completed model-test
evidence and the same-model client-access handoff survive in-app navigation.

Claude Opus 5 High advised retaining separate model sessions, finalizing cancellation
synchronously and rejecting late callbacks. The implementation uses a provider-owned
external store instead of the suggested module singleton, so separate rendered
workspaces cannot share conversation state. Only untouched empty/default sessions
are pruned; meaningful work is never silently evicted. Browser verification exposed
a first-edit race before passive model selection; binding the selected conversation
before paint fixes it without accepting edits from stale views. The final Opus review
also caught focus moving to the composer when switching between models with different
recovery counters; focus recovery now stays within the same model.

Validation: 286 frontend tests, 43 owner browser scenarios and three actual Java/proxy
scenarios against synthetic Ollama passed, along with type/lint/format checks and
production builds. Changed states were visually inspected on the isolated display.
No real model, GPU workload or public tunnel was used. Evidence is retained under
`test-results/owner-memory/`; all test services and private display resources were
removed. Durable conversation storage and deletion undo remain follow-up work.

## Owner prompt recovery and model-test handoff

Failed, stopped and empty owner replies now restore the prompt for editing. The
shared context builder includes only completed, nonempty exchanges for the selected
model, so retrying cannot duplicate an interrupted question. The whole visible
exchange is labelled excluded; earlier completed context remains eligible.

Playground distinguishes **Available to try** from **Model answered a prompt** and
links a completed test to that model’s client-access settings. It does not enable
sharing, run another prompt or promise future memory fit. This observation lasts
only for the current conversation.

Claude Opus 5 High independently identified the orphan-question bug and missing
draft recovery. Its suggestion to discard all context before an interruption was
not adopted: preserving earlier completed exchanges supports a retry in the same
conversation. Size limits still truncate a contiguous suffix of eligible completed
exchanges. Browser verification also caught a Stop/Send button-reuse race after
draft restoration; separate button identities and preventing the Stop click’s
default action keep cancellation from starting another generation.

Validation: 279 frontend tests, type/lint/format checks, production builds and 73
isolated browser scenarios passed. These include actual Java/proxy download and
cancellation flows against the synthetic Ollama fixture, guest chat regression,
owner failure recovery at 320/768/1024/1440px, and same-model sharing handoff without
a mutation. Screenshots were inspected. No real model download, GPU workload or
public tunnel was used. At that milestone, conversation persistence, model-switch
history recovery and owner Retry-After feedback were incomplete; the entry above
records the subsequent navigation/model-switch retention work.


## Guest onboarding without a key

A guest arriving from discovery now sees the request path before manual key entry.
The key form remains directly available when request intake is off, unsupported or
fails to load, and a typed key survives intake changes. Opening the alternative is
keyboard accessible; initial discovery does not focus a field or open the keyboard.
The unused conversation/composer stays hidden until there is a session, while
existing drafts and transcripts remain visible through access failures.

Claude Opus 5 High reviewed the guest journey. Its findings informed conditional
key-form priority, consolidating the relay disclosure, preserving history on access
errors and explaining that Disconnect loses the key without revoking permission.
Request recovery, host approval and explicit connection retain their existing rules.

Validation: 279 frontend tests, 41 isolated browser scenarios, TypeScript, lint,
formatting and the production builds passed. Browser coverage includes keyboard
entry, 320/768/1024/1440px layouts, unavailable intake, typed-key preservation,
request retry/cancellation, approval, expiry and connection-error history. A fixture
teardown race on late asset fetches was fixed by awaiting route handlers before
context disposal. Screenshots were visually inspected and retained under
`test-results/guest-onboarding-*.png`; test services and private display were removed.
No real model, GPU workload or public tunnel was used in this presentation cycle.


## Guest requests with explicit host approval

Guests can now request access from a public guest page, wait for the host to choose
an expiry, then explicitly connect. Hosts get an opt-in inbox with unverified names,
matching codes, required duration selection, rejection and existing key revocation.
Directory copy now explains both invitations and requests. Intake, tunnel and
listing controls remain independent; stopping intake does not revoke approved keys.

The guest holds independent request/access secrets and submits only the access
commitment. Approval, cancellation and durable grant changes share one monitor.
Lost responses reuse one immutable request; a changed tunnel during approval rolls
back the key. Anonymous admission, known request actions and discovery have separate
bounded budgets. Request records expire, and the UI explains the 20 active request
key / 100 total stored key limits without claiming revocation frees stored slots.

Claude Opus 5 High advised on the protocol and reviewed the backend integration.
Its findings led to independent known-request rate limits, cheaper bounded discovery,
consistent host-name acceptance, explicit stale-rejection errors and safer storage
error classification. Primary integration caught last-slot approval recovery being
incorrectly gated by new-request discovery, request-record expiry being confused
with key expiry, and credentials surviving Disconnect.

Validation: 555 Java tests, 279 frontend tests, five built HTTP tests, 74 local
browser regression scenarios and a standalone-directory browser scenario passed.
A separate real Cloudflare browser scenario passed request, approval, explicit
Connect, streaming, mid-generation revocation and a revoked-key recheck, using the
synthetic Ollama fixture. A repeated tunnel startup failed DNS verification and
kept access blocked: this remains temporary infrastructure, not stable hosting.
Real public tests now require HOSTAI_PUBLIC_INTEGRATION=1 as well as the isolated
integration flag, so ordinary local tests cannot enable a public tunnel.

No public registry was deployed, no real model was downloaded and no GPU benchmark
was performed. Screenshots and the detailed verification record are in
[test-results](../test-results/) and [verification](verification.md).

## Optional searchable host directory

Hosts can explicitly publish a verified temporary guest endpoint to their configured
directory. A standalone browser page and the owner's Find a host route search by
model or host name, distinguish empty/error/expired results, and retain search
through refresh failures. At that milestone, guests still needed an invitation obtained privately from
the host; the approval inbox was added in the subsequent cycle above. A default
public directory remains undeployed.

The Node reference registry accepts audience-bound Ed25519 updates, persists at
most 100 listings, and expires freshness after 90 seconds. It never probes submitted
URLs. A stable installation key proves continuity only, not a person's identity or
ownership of a guest URL. Publication remains separate from tunnel and grant
controls; removal does not stop chat, and a replacement tunnel requires new consent.

Independent advice identified cancellation-sensitive identity I/O. Focused failure
tests reproduced it, and identity operations now finish on private I/O threads
without losing the caller's interrupt status or durable lock. Integration also
corrected unsigned challenge invalidation, per-key rate charging, cross-directory
proof relay, clock skew and per-installation identity storage. An uncertain remote
write has no invented expiry timestamp.

Actual Java-to-Node interoperability and isolated browser checks cover publication,
search, withdrawal, restart, changed tunnel consent, responsive layouts and lost
responses. A synthetic model fixture also verifies guest streaming and revocation.
Setup copy now consistently points to optional guest sharing and host discovery.
Opus 5 High's final review also led to cross-site protection for directory reads,
bounded reader connections, replacement of expired listings at capacity, numeric
expiry tests and clearer busy/full feedback. Browser links recheck conservative
elapsed time at click, including time advanced while a browser was suspended.
See [directory setup and limits](directory.md) and [verification](verification.md).

## Temporary internet guest access

With Claude Opus 5 High advice and review, Sharing now offers explicit temporary
Cloudflare Quick Tunnel start/stop, verified availability, separate local/internet
keys, channel labels, expiry and revocation. One-time invites are cleared when
their endpoint becomes stale. Terminal cleanup failures identify when a gateway
restart is required. Host and guest pages disclose Cloudflare's access to messages
and credentials, temporary URLs and the host's self-asserted identity.

The tunnel targets an independent guest listener. Exact Host and a secret bridge
tag protect that route; public requests cannot reach owner controls. The secret
lives in private YAML rather than process arguments. A worker owns startup,
incremental reachability checks, cancellation and process cleanup; a watchdog
terminates the direct connector if its parent JVM disappears. Keys intentionally
survive stopping transport until revoked or expired. Old local keys never gain
internet scope, including after loading the prior store schema.

Real-provider testing found HTTP NDJSON buffering, so public chat and verification
use bounded WebSockets. Local preview retains HTTP. All guest paths share the same
model permission, rate/admission, expiry and revocation lifecycle. The final Opus
review prompted explicit handling of upload timeout and permission loss before
the first message. Its possible buffer-ownership concern was checked against
the actual dependency bytecode; automatic release was confirmed. A proposed
probe-budget increase was not adopted without a reproduced timing failure.

The production public route and isolated browser completed streamed chat, Stop,
retry, revocation and reconnect rejection with synthetic data. No real model was
run. Tests, corrections and evidence are recorded in [verification.md](verification.md).
All public test connectors were removed. Cloudflare sees relayed content; stable
hosting, verified identity, public discovery and production abuse controls remain
incomplete. Tailscale is not integrated. The earlier entries below describe their
historical implementation boundaries.

## Streaming reliability

Advice and focused reviews used Claude Opus 5 at high effort through Claude Code.
Recommendations were checked against the implementation and reproducing tests.

- The browser stops at the terminal NDJSON record, includes its content, releases
  the stream, and presents a consistent error for malformed records.
- The proxy enforces the backend's byte limit while reading, preserves overload
  headers, handles upload cancellation/timeouts, and lets the backend's default
  generation deadline expire first.
- Real socket checks caught a Node incoming-stream cancellation crash and a
  continuing-upload write race. Early responses now precede bounded draining and
  connection closure. These tests run in CI against the built server.
- A deterministic test reproduced completion misclassified as cancellation when
  the consumer stopped on the final record. Accounting now commits completion and
  tokens before exposing that record. Cancellation before it remains terminal;
  a later signal does not overwrite the registry's first terminal state.
- The idle-timeout message describes stalled stream progress without attributing
  every timeout to Ollama. Backpressure still bounds resource retention.
- UI cleanup now accounts for orphaned workers in the runner's exact process
  groups, with Bubblewrap parent-death protection. A separate orphan-worker
  harness verified detection and cleanup; the isolated UI suite also passed.

Validation: type checking, lint, formatting, production build, 35 stream/proxy
tests, 22 Java tests, five real-socket HTTP tests, and seven isolated UI/Electron
scenarios. Development-server oversized uploads were also checked. Playground
completion/error screenshots are retained in ignored `test-results/`.

Limits: HTTP fixtures do not run models or measure inference quality/performance.
Authentication, tunnels, persistent history, installers, and bundled Java remain
unimplemented. The UI suite still requires the documented Linux isolation tools
and is separate from CI. The proxy deadline is fixed; custom Java generation
timeouts must remain below it.

## Independent refresh failures

Opus 5 High advised on endpoint independence and freshness. Refresh now keeps
successful status/model/history results independently. Failed fields are cleared
and labeled unavailable; cached values are not presented as current. In
particular, a history failure leaves healthy chat usable, while failed status or
model discovery cannot imply generation readiness. An available, empty model
library remains distinct from failed discovery.

A shared accessible notice identifies each failure and offers keyboard-accessible
retry on every page. Activity and model views show unavailable states instead of
claiming empty results, and unknown model counts use an unavailable label. Abort
and controller-identity guards discard superseded refreshes.

The focused Opus review also caught two display assumptions: a missing status
check now reads unavailable, and an empty library follows successful discovery
even when the separate status check fails. One review attempt exited without an
answer; the retry completed. The backend contract was checked before accepting
the review's claims about successful-but-unavailable responses.

Validation: 47 unit tests, type checking/lint/formatting, production build, and
ten isolated browser/Electron scenarios. Browser checks cover mixed endpoint
outcomes, chat during a history failure, recovery, keyboard retry, and responsive
layouts, and unknown counts during loading. The Java integration scenario was
skipped in this cycle; proxy and Java code were not changed. Screenshots are in ignored `test-results/`.

## Interrupted conversation history

A browser regression reproduced an unfinished answer being included in the next
request. With Opus 5 High advice, display turns now carry lifecycle state and
produced a separate wire history at that milestone: all user messages for the selected
model remained, but only completed, nonblank assistant responses were reused. The
owner-recovery cycle above corrects this to exclude the whole unfinished exchange. Interrupted and empty
responses stay visible with an exclusion label. This also prevents blank completed
answers from violating the backend's nonblank-message validation on the next send.

Turns retain their model identity. The chosen model is pinned on the first send;
if discovery loses it, generation pauses with an unavailable selection instead of
silently using a different model or relabeling previous answers. Explicit model
switch and Clear reset history. A synchronous guard prevents duplicate admission.

Validation: 54 unit tests, type checking/lint/formatting, production build, and 16
distinct isolated UI/Electron/integration scenarios across the full and focused
runs. The Java-backed cancellation scenario verifies the next request retains
completed context and user prompts but excludes cancelled output. Other checks
cover empty answers, HTTP failure before content, truncation, Stop before headers,
duplicate submission, model disappearance, switch, and Clear. Screenshots of
interrupted, cancelled, and unavailable-model conversations were inspected.

The focused review was checked against the stream parser: it already stops at
`done:true` and rejects premature EOF, contrary to two review assumptions. The
review's concern about consecutive user messages was checked by running the
Java integration scenario. Its Ollama endpoint remains a test stub; no real model
compatibility or inference-quality claim follows from those tests.

## Conversation request limits

A regression reproduced 32 completed exchanges producing a rejected 65-message
request. With Opus 5 High advice, request preparation now retains a contiguous
suffix of whole turns within all four gateway limits: 64 messages, 16,384 UTF-16
units per message, 65,536 combined units, and 262,144 serialized UTF-8 bytes.
An oversized historical answer drops its turn and all older turns. Incomplete
answers still contribute only their user prompt. The new prompt is never
shortened, and the display transcript is not mutated.

The composer discloses omissions before Send, explicitly saying when only the
new message fits. The request uses that exact prepared body; its omission count
stays attached to the sent user message after completion. These are transport
and validation limits, not the model's token window or a quality guarantee.

Validation: 62 unit tests, type checking/lint/formatting, production build, and
17 distinct isolated browser/Electron scenarios passed across the full and focused
runs. Tests cover exact boundaries, JSON escaping, Unicode, contiguous whole-turn
removal, and preservation of
incomplete-turn behavior. Browser checks verify both complete history omission
and retention of recent turns, the actual request body, disclosure before Send,
persistent annotations, mobile wrapping, and Clear. Desktop and mobile evidence
was visually inspected in `test-results/context-limit-*.png`. The Java integration
scenario was skipped this cycle; Java and proxy code were unchanged, and no real
model was run.

The Opus review confirmed the fitting algorithm and exact boundary arithmetic.
It also identified the textarea's old 16,000-character cutoff, which silently
shortened pasted text before validation. That cutoff is removed: oversized new
messages remain editable, show an error, and cannot be sent until shortened.
A focused browser check verifies full pasted-text preservation, blocked Enter,
error recovery, and a successful next send. Request assertions in the new
context browser scenario run outside route handlers so failures report directly.

## Model admission feedback

Discovery returned model names that chat refused, while the library labeled them
local and enabled generation. A real HTTP regression confirmed missing admission
feedback. Opus 5 High advised sharing one backend policy; the first advisory
process exited without an answer, and a smaller retry completed successfully.
`ModelAdmission` now drives both validation and the discovery DTO's explicit
nullable `chatUnavailableReason`.

Unavailable models remain visible with a reason and no chat link. The playground
chooses the first allowed model by default, blocks unsupported explicit selections,
and retains the chosen conversation when refresh changes admission. Overview
readiness and setup completion use the same discovery metadata. Missing metadata
is unknown, with an update/restart message, rather than permission to generate.
These checks cover known gateway restrictions, not model capabilities or memory.

Validation: 62 web unit tests, 24 Java tests, type checking/lint/formatting,
production build, and 24 distinct isolated browser/Electron/integration scenarios
passed across full and focused runs. A prior label assertion was updated from
installed to discovered. The real Java integration scenario includes a cloud
fixture entry, verifies its reason and the allowed default, then checks streaming
and cancellation through Java. No model was downloaded or run. The new library
and blocked playground states were visually inspected, including mobile.

The final Opus review identified two mixed-state problems, now covered by browser
checks: runtime setup stays available when connectivity and model admission both
fail, and API examples require an allowed selected model. Its proposed narrowing
of the existing `-cloud` restriction was not adopted; this cycle preserves the
existing admission policy while making its decisions visible.

The suspected mobile heading clipping was not reproduced by settled geometry
checks across all five routes at 320px. The check waits for fonts and host state;
viewport and full-page captures were inspected. No heading CSS was changed.

## Reading streamed conversations

Two isolated browser regressions reproduced each chunk pulling the reader back
to the bottom (523px in the initial check) and moving the surrounding mobile page
(62px). With Opus 5 High advice, the conversation now scrolls its own container,
tracks following intent, and offers an accessible Jump to latest button. A new
prompt resumes following; reading earlier text pauses it. Clear, model switches,
and new submissions use a fresh native scroll container so an unfinished browser
keyboard animation cannot carry into the next answer. Jump returns focus to the
pane without moving the page.

The initial advice assumed resize does not fire scroll events. A failing Chromium
resize test disproved that, so geometry changes preserve follow intent. The review
also prompted explicit upward wheel, keyboard, and touch handling: genuine input
wins over simultaneous reflow. A rapid-stream regression found near-bottom
keyboard animation could undo a pause; resuming from that state now requires
movement toward the bottom. The immediate model-switch and rapid keyboard cases
both passed three repeated runs after their fixes.

Validation: 62 web unit tests, type checking/lint/formatting, production build,
and 30 distinct isolated UI/Electron scenarios passed across full and focused
runs. Tests cover native wheel/keyboard input, follow-up sends, Clear/model reset,
resize at 320/768/1440px, page-position preservation, and deterministic concurrent
input/reflow. Desktop and mobile states were visually inspected. Java integration
was skipped because gateway/proxy behavior did not change; no actual model ran.
Touch coverage exercises event handling in Chromium, not a native mobile browser.

## Readable answers and copying

With Opus 5 High advice and review, assistant answers now render Markdown and GFM
lists/tables with accessible, horizontally scrollable code blocks. Original
response text remains the source for whole-response copying and outgoing context.
Unfinished fences render naturally; failed/cancelled answers retain the adjacent
context exclusion notice and expose Copy partial response. Empty code cannot be
copied. Copy status belongs to its source text and ignores stale async results.

Images become alt-text placeholders without a request. Raw HTML is escaped, and
only credential-free HTTPS links activate. Browser and desktop share this URL
policy; desktop now supports answer references beyond the previous three docs
hosts. Invalid navigation and unavailable system browsers cannot throw out of the
handler. External browser handoff itself was not exercised.

The review caught duplicated inactive autolinks and empty-code copying. Its claim
that raw HTML vanished was contradicted by the installed renderer's raw-to-text
transform and a regression test; no additional HTML plugin was added. Plain-text
soft line breaks stay visible. Completed answer parsing is memoized, but active
answers still parse per chunk; no large-output performance claim is made.

Isolated desktop verification exposed the existing blanket clipboard-write deny.
Both permission handlers now allow only sanitized writes from the trusted main
frame and local origin. A native key event supplies the private Wayland clipboard
serial, and wl-paste checks the actual copied command. Reads remain denied. No
live desktop or clipboard was accessed. New runner prerequisites are wtype and
wl-clipboard.

Pinned dependencies are react-markdown 10.1.0 and remark-gfm 4.0.1. The test glob
now includes TSX so renderer unit tests actually run; Panda excludes those tests.
The existing Vite-plus alias still causes pnpm's peer checker to report Vite
version mismatches in Vitest/mocker; this predates the Markdown dependencies.

Validation: 80 web unit tests, type checking/lint/formatting, production build,
and 34 isolated UI/Electron scenarios passed. Desktop, formatted answers, and
mobile/code overflow states were visually inspected. The Java integration case
was skipped because gateway behavior did not change. No actual model ran;
macOS clipboard and external browser launch remain unverified.

## Scheduling streamed answer formatting

A production-app fixture measured one 16,000-character answer across 1,000
worker-paced chunks. Without artificial slowdown, dense Markdown produced a
33ms p95 frame gap versus 16ms for prose; neither had >50ms main-thread tasks.
Thus a zero long-task count alone would have missed the scheduling difference.
Under Chromium's artificial 4× CPU slowdown, Markdown produced 117ms p95 frame
gaps and a 151ms maximum in the initial run. Prose still uses the same parser;
this comparison isolates content complexity, not all parser overhead.

Following Opus 5 High advice, `Answer` now defers only the displayed string and
passes it to a memoized formatting component. The memo boundary prevents urgent
renders with the old deferred text from parsing that text again. Raw accumulated
state, terminal handling and response copying stay unchanged. `aria-busy` marks
the formatting catch-up. Completed turns retain memoization.

The first deferred run reduced the dense fixture's p95 frame gap from 117ms to
67ms and its maximum from 151ms to 109ms at 4× slowdown. This is a partial,
exploratory result on a software-rendered test display; individual synchronous
parses can still block, and the displayed answer can lag received text. The
change does not claim a model-speed or real-device responsiveness benchmark.

Two follow-up runs waited for `aria-busy` to clear before stopping measurement:
dense Markdown p95 callback gaps were 66ms and 57ms, with maxima of 107ms and
120ms. They recorded 50 and 49 >50ms tasks versus 70 in the initial baseline.
Worker delivery spanned 9,990ms in both; both copied all 16,000 source characters.
These few runs support the direction, not a precise cross-device speedup.

The final Opus review identified the terminal-DOM measurement boundary and a
multi-chunk coverage gap. Both are now explicit checks. Validation: 80 unit tests,
type checking/lint/formatting, production build, 35 distinct browser/Electron
scenarios across full/focused runs, and both diagnostic scenarios repeated twice.
Completed deferred output was visually inspected. The unchanged Java integration
was skipped, and no actual model ran.

## Auditing the host and client journeys

After finishing the rendering cycle, the user's full workflow was traced with
Opus 5 High advice. [The journey audit](user-journeys.md) separates implemented UX
problems from absent download management, authentication/sharing, remote access
and host-directory services, with concrete host/client states and recovery paths.
The global 15-second visibility-aware poll already exists; the advice to add
polling was not applied. Inbound loopback binds were checked directly.

The first setup regression reproduced the missing handoff into model selection.
The Connection page's old instructions also combined a standalone gateway with a
launcher that requires its port to be free. The revised guide appears before
diagnostics, acknowledges running services, leads a ready library to chat, and
uses the current workspace origin for browser access. Unavailable discovered
models lead to their reasons before a redundant download suggestion. Sharing
copy explicitly names the missing remote capabilities.

Validation: type checking/lint/formatting and production build passed, along with
seven distinct targeted setup, navigation, responsive-heading and Electron
scenarios across focused runs. Ready, empty and unavailable-model setup states
were visually inspected. One fixture initially omitted `connected: true` and
correctly triggered discovery failure; it was corrected without weakening the
application check. The full remote workflow remains unimplemented, no model was
downloaded, and nothing was exposed to the internet.

## Completing local model downloads

Opus 5 High advised the download lifecycle. Fable High was attempted twice but
rejected both calls with the account's resource-limit response; GPT-6 Astra XHigh
implemented the bounded Java scope in an isolated worktree instead. Its socket
sandbox prevented network tests, so the primary agent reviewed and integrated
its changes and ran the full HTTP suite with isolated local runtime fixtures.
No delegated model was credited for execution its account or sandbox rejected.

The Models page now accepts explicit tagged library names and manages one download
at a time. Jobs belong to the gateway, survive browser navigation, expose bounded
current-layer progress and explicit cancel/retry, and retain at most 20 records.
An uncertain start retains its request ID, with an explicit way to dismiss the
entry; cancellation is never implied by dismissal. Completion refreshes model
discovery and offers a deliberate handoff to chat. Setup links to this flow.
Unknown counts stay indeterminate, malformed/status failures remain actionable,
and stale GET responses cannot overwrite a completed cancellation.

The first independent backend run found an overall-deadline connection leak:
`takeUntilOther` with an error-producing timer forwarded failure without cancelling
its main source in the installed Reactor version. A real socket regression also
reproduced the same existing chat bug. Both paths now emit a deadline value to
cancel the source, then translate completion into the explicit timeout error.
The before-fix tests observed a live upstream socket after failure; the corrected
suite verifies its closure. Pull idle timeout is independently five minutes to
allow silent integrity verification; total pull time remains bounded at two hours.

The new management endpoints require JSON and exact browser origin checks. The
Java boundary also rejects non-loopback Host names, including a matching rebound
Origin/Host pair; the production web server already had this Host restriction.
These checks are not authentication. The UI/API remain unauthenticated and bound
to loopback; no tunnel, sharing, directory, remote client or access grant exists.

Opus's first final review could read only frontend files because the isolated
backend worktree was outside its permitted scope. It correctly flagged raw JSON
parse errors and a missing uncertain-request dismissal; those were addressed.
Its insecure-LAN UUID warning does not apply to the supported loopback deployment,
and its web Host warning was checked against the existing server guard. Malformed
job lists still fail closed, because silently skipping an active job would enable
misleading controls. Backend review was repeated after files were integrated and confirmed the deadline
fix and subscription ownership. Its Host-header finding reflected a read made
before the concurrently added guard/test; the final 71-test suite covers that case.
Its statement that cache/history caveats were unsurfaced was checked against the
existing cancellation text and history footer. Suggestions about future HTTP
methods and fatal JVM errors were not treated as current defects. Cross-record
counter inconsistency remains an explicit protocol failure; supported layer changes
carry their digest, and unknown counts are already represented without a percentage.

Verification evidence is recorded in verification.md. No model was downloaded or
run, and no public endpoint was opened; integration uses only simulated Ollama
responses. Download history/idempotency are intentionally not durable across
restart or eviction, and cancellation cannot promise deletion of cached layers or
termination of work another Ollama client requested.

## Next candidates to investigate

Continue the full host/client destination in [user-journeys.md](user-journeys.md):
requirements-aware model discovery, reliable conversation retry/preservation,
then authenticated model serving with revocable invites and a distinct client
connection/chat surface. Choose and verify a transport before implementing internet
sharing, and add searchable public hosts on top of working private connections.
The local download improvements do not substitute for those missing services.

## Local guest access cycle — 9 September 2026

Added a complete local owner-to-guest path: publish one installed model, create an
expiring key, open the separate client page, connect, chat and revoke. The owner
can stop all guest work while retaining local chat. Publication always restarts
stopped. Grants and revocation persist atomically in private hash-only storage;
raw links appear only at creation. The distinct guest handler graph exposes no
owner routes. Guest limits reserve one of the two inference slots for owner use,
cap output requests at 1,024 tokens and allow six admitted attempts per key/window.
Those limits do not guarantee memory fit or public abuse resistance.

Opus 5 High advised on the model and reviewed the integrated backend. GPT-6 Astra
XHigh implemented the isolated access store and guest frontend and contributed
focused lifecycle tests; primary integrated, reviewed and ran actual builds,
socket tests and browser checks. Fable was not retried after its previously
confirmed account limit. No unavailable model was credited with completed work.

Review led to tolerating a benign parent-directory creation race and tying guest
session registration to `Flux.using`, so a synchronous assembly failure cannot
orphan the single guest slot. The regression verifies a subsequent request can
run. Model policy is enforced in the service as well as credential validation at
the HTTP boundary. Additional HTTP tests cover missing/duplicate bearer headers,
raw rebound Hosts and asset traversal, and old keys after a publication change.
An existing owner Host test was outside Opus's review scope; it was not absent.

The reviewer flagged the still-bound listener after Stop. This is deliberate:
Stop client access ends authorization/work, while the guest page remains available
for reconnect feedback. Owner link controls depend on active state and clear on
stop/revoke. Gateway shutdown closes the listener. The existing stream parser
already terminates at the first done record, addressing the terminal-record race
without inventing a second completion contract.

Browser verification caught a native form-default bug: replacing the clicked Stop
button with Send restored and immediately resubmitted the prompt. Preventing that
click's default action now preserves the draft and admits no new request. A
separate non-submit type keeps Check model library from enabling guest access.
Guest connection checks time out, same-key reconnect keeps the transcript/draft,
and interrupted exchanges are excluded from later context. Visual inspection
also shortened the empty conversation so the first-message box stays in view.

Validation: 215 Java tests, 113 frontend unit/proxy tests, five production HTTP
checks, and 72 distinct isolated browser/Electron/integration checks passed; the
two optional rendering benchmarks were skipped. The final empty-state adjustment
was rechecked in the guest suite. Build/typecheck/lint/format and diff checks pass.
Evidence is retained under `test-results/guest-*.png`, `sharing-*.png` and
`isolation.json`. Test fixtures used a temporary access store and simulated Ollama;
no real model, account, tunnel, public endpoint or GPU benchmark was used.

This remains a local preview. Owner APIs are unauthenticated loopback endpoints,
so guest keys are not protection against another process already on the machine.
Internet transport/TLS/reachability, verified identity and public host discovery
remain required. Conversation/history durability, model requirements/fit guidance,
key pruning and production abuse controls are also incomplete. See
[guest-access.md](guest-access.md) and [user-journeys.md](user-journeys.md).
