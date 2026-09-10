# Host and client journeys

The product supports a host running a local model and an invited client chatting
without managing inference software. Hosts download and select a local model,
test it, start client access, then privately send an invitation. Optional Cloudflare
Quick Tunnel sharing provides remote guest access with separate channel permissions
and HTTPS streaming checks. **Connections are invite-only: no host search, public
listings, registry service, or discovery roadmap.** Stable public hosting and
verified identities remain unimplemented.

Guests use an invitation key or follow a privately shared guest link and request
approval when the host enables its [approval inbox](access-requests.md).

Reviewed with Claude Opus 5 High on 9–10 September 2026. Code and isolated UI fixtures
are the evidence. Disposable Quick Tunnels have been exercised with synthetic
data; provider evidence and remaining limits are recorded in verification. No
real model was downloaded or inference benchmark run.

## What works and where the journey stops

| Person and step | Current evidence | Friction or missing capability | Intended experience |
| --- | --- | --- | --- |
| Host: open HostAI | [Source launcher](../scripts/workspace.mjs) starts Java, UI, then Electron | Requires source checkout, Node/pnpm and Java; no distributable installer. Window appears only after services start. | Launch one app, see startup progress and recoverable errors before setup. |
| Host: prepare inference | [Setup](../apps/web/src/routes/connection.tsx) shows Ollama commands | Ollama installation/startup are external; a failed status check is not proof that a process is stopped. | Detect existing runtime, explain the missing part, show only the action needed. |
| Host: choose/download a model | [Library](../apps/web/src/routes/models.tsx) lists installed models and manages explicit tagged downloads; disappearing running records retain an unknown-outcome notice and trigger a library check | A dated [starter shortlist](starter-models.md) supplies exact tags and approximate listed sizes; no live catalog search, hardware-fit estimate or automatic resumption. Model drafts, pending actions and recovery notices survive navigation within the owner tab; reload or closing the tab clears local recovery details. | Review model size/requirements, explicitly start download, see progress, recover, then test that same model. |
| Host: refresh discovery | [HostProvider](../apps/web/src/lib/host-context.tsx) polls every 15 seconds while visible; manual refresh also exists | Download completion refreshes the library and offers an explicit Try action when the model is admitted. | Confirm the actual installed model before enabling Try; download status polls separately from host metadata. |
| Host: select and test | [Library](../apps/web/src/routes/models.tsx) links a selected model into [Playground](../apps/web/src/routes/playground.tsx) | Playground and the Client access start form distinguish available-to-try from a completed, nonempty reply in the retained conversation for that model name. Clear/reload remove this evidence; it is not a durable readiness or memory-fit assessment. | Selected model stays visible during loading/testing; distinguish installed, testing, ready, busy and unavailable. |
| Host: start serving | [Client access](../apps/web/src/routes/sharing.tsx) publishes one selected model on a separate local guest listener | Explicit model links and the gateway’s last configuration survive the start/stop handoff; host-name drafts survive the Playground round trip in tab memory, and missing choices explain recovery. Starting checks library presence, not memory fit or successful inference. Access restarts stopped. | Choose which model clients may use, test it, then enable serving deliberately. |
| Host: share over internet | [Java config](../backend/src/main/resources/application.properties) and [web server](../apps/web/server.mjs) bind loopback | Temporary Cloudflare Quick Tunnel sharing checks HTTPS streaming before issuing internet keys. Cloudflare sees traffic; there is no production uptime guarantee or verified identity. | Share a verified endpoint with selected clients; expose status and Stop sharing in the same place. |
| Client: open an invitation | The separate guest page accepts an expiring, model-specific key, or requests explicit host approval after the host privately shares its link | No verified identities; temporary tunnel addresses can change. A guest URL alone grants no chat permission. | Open the host’s invite, check the model and privacy disclosure, connect, then chat. |
| Host: approve a guest | [Request inbox](access-requests.md) shows an unverified name, matching code and model; duration must be chosen explicitly | Intake is internet-only and starts off. Approved permissions survive closing intake; 20 active request keys and 100 total stored keys are the limits. | Review a specific guest, approve a scoped permission, and revoke it from Access keys. |
| Host: recover invitation capacity | Access keys reports the gateway’s count of expired or revoked records and offers explicit cleanup | Up to 100 records are stored. Cleanup is irreversible, keeps active/paused permissions and never creates or sends an invitation. Browser expiry badges still use the device clock; removal uses the gateway clock. | Remove ended records, then explicitly create a new invitation or approve a pending guest. |
| Client: request access | Guest page discovers intake, retains the unsent name through details failures and chat connection changes, validates names, and waits for approval | No accounts or identity verification. Reload loses drafts and credentials. Disconnect retains request credentials for cancellation/reconnect; request records have a shorter lifetime than approved keys, which still require expiry or revocation. | Correct an initial rejected submission, retry uncertain responses without duplicate requests, cancel explicitly, then connect without sending a prompt automatically. |
| Client: connect | [Shell](../apps/web/src/components/shell.tsx) exposes one local host workspace | The separate guest page checks model and channel permissions. An internet invite needs no client installation; the host name remains self-asserted. | See host identity, model and access requirements; connect without installing Java, Ollama or a model. |
| Client: chat | Current Playground uses same-origin `/api/chat` | Guest chat has its own bundle/API and retains draft and partial output through reconnects and failed replacement-key checks. A successful replacement clears prior-key content before sending; re-entering the original key restores its retained conversation. Temporary internet access requires a live verified tunnel and a separate internet key. | A client-only conversation surface, with authenticated access to allowed models and useful recovery states. |
| Either: recover a send | Failed/stopped prompt stays in the transcript; partial answers are excluded from later context | Owner Playground and guest chat restore failed/stopped prompts and exclude the entire unfinished exchange. Both owner and guest chat respect valid Retry-After delays. Owner waits span models in the same tab, retain editable drafts while the runtime is available, and never resend automatically. | Edit/retry the failed turn without manually copying text or duplicating its context; preserve partial output. |
| Either: return to work | Owner conversations, drafts and settings are retained per model in workspace tab memory; guests retain work through same-key reconnects | Reload/closing the tab clears work. Owner Clear removes only the selected history, retaining its draft/settings; no undo or durable conversation storage. | Return to the same model without losing work or automatically sending; make deletion explicit and recoverable. |

## Initial changes implemented

The Connection page previously said to start `pnpm backend:dev` and then run
`pnpm desktop:dev`. The launcher checks that both ports are free and starts its
own Java service, so following that sequence caused a port conflict. Setup now
acknowledges that the workspace is already open, suppresses redundant service
commands for connected components, and leads an available library into model
selection and a first prompt. The ready guide precedes connection diagnostics.

The browser link now uses the actual workspace origin, including a nondefault
port, with a Copy workspace address label. It explains that another launcher is
unnecessary. Sharing copy distinguishes the local owner workspace from optional temporary
Cloudflare guest access and explains why copying the owner address does not grant access.

The design intent is a host owner completing the next unfinished step without
learning the process topology first. The existing Manrope/Geist typography,
4px spacing scale, teal action/status tokens and bordered white sections stay in
place. Completion text is quieter than the next action. Relevant domain concepts
are runtime, local model, download, test prompt, serving endpoint and access grant;
the useful signature is progress from local runtime to a tested, explicitly shared
model—not a generic metrics dashboard.

## Implementation priorities for the complete cycle

1. **Complete local onboarding and model lifecycle.** The explicit download job lifecycle now covers starting, downloading, verifying,
   finalizing, completed, failed and cancelled, with one active request and no queue.
   Current-layer counts are shown when known and progress is indeterminate otherwise.
   A dated starter chooser now supplies explicit tags, listing sizes and source links
   before an explicit download; installed choices lead directly to Playground. Next, add
   live catalog discovery and hardware-fit guidance. A tag's file size is not a guarantee
   of runtime memory fit. Overview, setup and library now use the gateway’s configured
   loopback endpoint in copyable Linux/macOS commands, including custom ports and IPv6.
   Missing or malformed status withholds commands; HTTPS setup explains the existing TLS
   endpoint rather than offering a plaintext server command. Ready overview steps show
   completion text instead of redundant commands.
   Check existing runtime/service ownership before adding Start/Stop controls.
   Download cancellation must not imply all cached layers were deleted.
2. **Make local chat recovery reliable.** Owner navigation and model switching now
   retain separate conversations, drafts and settings in tab memory. Leaving Playground
   stops generation and retains partial output without auto-resuming. Next, design durable
   storage, deletion recovery and Edit & retry while keeping model identity attached.
   Failed, stopped and empty responses now restore the prompt while both halves of
   that exchange stay out of outgoing context. Earlier completed exchanges remain
   eligible. Owner capacity/retry delays now survive navigation and model changes without automatically generating extra work.
3. **Build one private sharing journey end to end.** Separate operator-only runtime,
   request history and management APIs from guest model/chat APIs. Add durable
   access grants, revocation and per-client admission before internet exposure.
   Owner access must remain usable when guests fill capacity. Expose only selected
   models, not every installed model. An outbound tunnel or relay still needs an
   authenticated guest surface, HTTPS, and a public reachability check. Show
   starting, reachable, interrupted, stopped and revoked states; Stop sharing must
   terminate access and release guest work. The temporary Cloudflare Quick Tunnel
   path now implements this boundary; stable hosting and verified identity remain
   separate follow-up work. Stop closes transport; Revoke ends durable key permission.
4. **Give clients a complete invite-to-chat path.** Opening an invitation should
   identify the host and model, establish access, then enter chat. Clients should
   not run the owner's Java/Ollama launcher. Distinguish unreachable host, invalid
   or revoked access, incompatible protocol, unavailable model and full capacity.
   Keep the draft/transcript through reconnects; never silently switch host/model.
   Explain who operates the host and receives the submitted messages before the
   first send. Guest access must not reveal owner telemetry or other clients' data.
5. **Keep access invite-only.** Do not add host search, public listings or a registry.
   Improve the private invitation, approval, expiry and revocation journey instead.
   Explain that recipients can forward bearer keys and that a changed tunnel URL
   requires the host to send a new address.

Do not expose the current owner workspace by changing bind addresses alone.

## Evidence and corrections to advice

- Opus independently identified the contradictory startup sequence. The new ready
  journey failed before the fix, then passed after it.
- Its polling concern was scoped to route files. Primary inspection confirmed the
  existing visibility-aware 15-second poll; no new poller was added.
- Both inbound loopback binds are confirmed in Java config and the web server;
  `LocalOllamaEndpoint` alone only proves the outbound runtime restriction.
- A suggested same-route model-query mismatch remains an investigation candidate,
  not a confirmed bug in the current library-to-chat path. Normal navigation from
  the library mounts the selected model correctly. Do not add an effect that
  silently changes an active conversation before reproducing the precise case.
- At the initial audit, a failed prompt remained visible and in later context. The
  owner-recovery cycle now restores it to the composer and excludes its whole
  unfinished exchange from later requests. Earlier completed context is retained.
- [Ollama's qwen3:0.6b listing](https://ollama.com/library/qwen3:0.6b) confirms the
  existing example tag. Its displayed 523MB is model storage, not a RAM estimate.
  HostAI did not download or run it during this audit.

UI evidence is retained under `test-results/setup-*-journey*.png`. Browser fixtures
verify the missing-runtime → empty-library → model-selection path and the actual
workspace origin. This initial setup audit preceded guest access and transport integration; later
verification is recorded in [verification.md](verification.md).

## Local download cycle implemented

Setup now opens the in-app download form. A host chooses a dated starter or supplies
a custom tagged Ollama library reference, starts one job, follows its current-layer progress,
cancels or retries, and chooses **Try downloaded model** after library confirmation.
Navigating away does not cancel the backend-owned job. A lost start response
retains its request ID for retry within the backend's retained history. Neither
idempotency nor job history survives a gateway restart or history eviction.

Status refresh failures retain the last known progress with a stale-status message;
explicit cancellation remains usable. Polling pauses while hidden and refreshes
on visibility, every two seconds while active and less often while idle. The UI
never starts a download just by choosing a model, opening a page or completing chat.
Downloading does not load a model for inference or enable serving/sharing.

The API uses Ollama's [documented pull stream](https://github.com/ollama/ollama/blob/main/docs/api.md#pull-a-model).
Layer totals are not aggregate download size. Ollama may retain partial layers and
multiple clients may share a pull, so cancellation is described as stopping this
request. No real model was pulled during verification.

## Local guest access implemented

The owner selects a model, explicitly starts a separate guest listener, creates a
key for one model and an expiry, and copies a one-time client link. Guest startup
removes the key fragment before requesting session metadata. It explains who
receives messages, shows a self-asserted host name and permitted model, and lets
the client chat, Stop, reconnect or disconnect. Revocation and expiry terminate
active guest streams; interruption keeps partial output and an editable draft.
The incomplete exchange is excluded from later context to avoid duplicate retries.

Local keys remain labeled local preview. Optional internet sharing now adds a
verified temporary Cloudflare endpoint and explicitly separate internet keys.
Guests see the relay privacy disclosure and self-asserted host identity before
sending. Public chat uses WebSockets, with the same expiry, revocation, Stop and
admission behavior as local chat. [Guest access](guest-access.md) documents its
limits. Public host discovery is explicitly outside the product scope.


## Testing a local model and recovering a prompt

Playground now labels metadata admission **Available to try**. A completed,
nonempty reply changes that to **Model answered a prompt** and offers **Set up
client access** for the same model. This records evidence only within the current
conversation, retained across in-app navigation; it does not benchmark memory fit or
survive a reload. The link opens settings and never starts sharing or inference by itself.

A failed, stopped or empty reply restores its question to the composer for explicit
editing and sending. Partial output and the original question remain visible, but
neither half is included in later context. Earlier completed exchanges for the
selected model stay eligible, within the existing request limits. Stop suppresses
its click's default action and has a separate button identity from Send, so restoring
a draft cannot accidentally submit it during that same click.

Conversation storage across reloads, deletion recovery, catalog discovery and
runtime fit guidance remain follow-up work. Owner Retry-After feedback is now
implemented across models and navigation within the tab.

Owner conversations now live in the workspace provider, separately for each model.
Navigation and model switching retain drafts, completed/partial output and run
settings. Leaving Playground stops generation; returning never sends automatically.
Clear removes only the selected history, retaining its draft/settings. A missing
model stays selected with its work intact until restored or explicitly switched.
Nothing is written to conversation storage, and reload or closing the tab clears it.
