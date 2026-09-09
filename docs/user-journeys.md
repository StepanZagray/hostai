# Host and client journeys

The intended product supports two people: a host owner making a local model
available, and a client finding a host and chatting without managing inference
software. The current product implements explicit local model downloads, discovery,
chat, and a local guest-access preview with durable, revocable keys.
**Internet sharing, remote reachability, verified host identities and a public host
directory are not implemented.** Local guest access does not complete the destination.

Reviewed with Claude Opus 5 High on 9 September 2026. Code and isolated UI fixtures
are the evidence. No real model was downloaded, inference benchmark run, tunnel
opened, or public endpoint deployed.

## What works and where the journey stops

| Person and step | Current evidence | Friction or missing capability | Intended experience |
| --- | --- | --- | --- |
| Host: open HostAI | [Source launcher](../scripts/workspace.mjs) starts Java, UI, then Electron | Requires source checkout, Node/pnpm and Java; no distributable installer. Window appears only after services start. | Launch one app, see startup progress and recoverable errors before setup. |
| Host: prepare inference | [Setup](../apps/web/src/routes/connection.tsx) shows Ollama commands | Ollama installation/startup are external; a failed status check is not proof that a process is stopped. | Detect existing runtime, explain the missing part, show only the action needed. |
| Host: choose/download a model | [Library](../apps/web/src/routes/models.tsx) lists installed models and manages explicit tagged downloads | No catalog search, fit estimate or automatic recovery after a gateway restart. | Review model size/requirements, explicitly start download, see progress, recover, then test that same model. |
| Host: refresh discovery | [HostProvider](../apps/web/src/lib/host-context.tsx) polls every 15 seconds while visible; manual refresh also exists | Download completion refreshes the library and offers an explicit Try action when the model is admitted. | Confirm the actual installed model before enabling Try; download status polls separately from host metadata. |
| Host: select and test | [Library](../apps/web/src/routes/models.tsx) links a selected model into [Playground](../apps/web/src/routes/playground.tsx) | Admission means allowed to try, not successfully loaded or proven to fit memory. No explicit first-run test status. | Selected model stays visible during loading/testing; distinguish installed, testing, ready, busy and unavailable. |
| Host: start serving | [Client access](../apps/web/src/routes/sharing.tsx) publishes one selected model on a separate local guest listener | Starting checks library presence, not memory fit or successful inference. Access restarts stopped. | Choose which model clients may use, test it, then enable serving deliberately. |
| Host: share over internet | [Java config](../backend/src/main/resources/application.properties) and [web server](../apps/web/server.mjs) bind loopback | Guest API, model-scoped grants and durable revocation exist locally; tunnel, TLS ingress, verified identities and reachability checks do not. | Share a verified endpoint with selected clients; expose status and Stop sharing in the same place. |
| Client: find a host | Local one-time invites exist; no host directory or saved remote hosts | Installed-model search is not host discovery. | Open an invite or browse explicitly listed hosts by model/capability; distinguish online, busy, offline and stale listings. |
| Client: connect | [Shell](../apps/web/src/components/shell.tsx) exposes one local host workspace | The separate guest page accepts a key and checks model permissions; its address is still local-only. Host names are self-asserted. | See host identity, model and access requirements; connect without installing Java, Ollama or a model. |
| Client: chat | Current Playground uses same-origin `/api/chat` | Guest chat has its own bundle/API and retains draft and partial output through reconnects. No remote transport exists. | A client-only conversation surface, with authenticated access to allowed models and useful recovery states. |
| Either: recover a send | Failed/stopped prompt stays in the transcript; partial answers are excluded from later context | Owner Playground still needs draft recovery. Guest chat restores failed prompts, excludes unfinished exchanges and respects Retry-After without autosending. | Edit/retry the failed turn without manually copying text or duplicating its context; preserve partial output. |
| Either: return to work | Conversations live in route-local state | Navigation, Clear and model switching discard conversations; model switch has no undo. | Keep conversations scoped to host/model, make New chat explicit, and provide recovery for destructive actions. |

## Initial changes implemented

The Connection page previously said to start `pnpm backend:dev` and then run
`pnpm desktop:dev`. The launcher checks that both ports are free and starts its
own Java service, so following that sequence caused a port conflict. Setup now
acknowledges that the workspace is already open, suppresses redundant service
commands for connected components, and leads an available library into model
selection and a first prompt. The ready guide precedes connection diagnostics.

The browser link now uses the actual workspace origin, including a nondefault
port, with a Copy workspace address label. It explains that another launcher is
unnecessary. Sharing copy now says remote access is unavailable, rather than
suggesting a disabled switch exists.

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
   Next, add catalog discovery and requirements/fit guidance before resource use. A tag's file size is not a guarantee
   of runtime memory fit. Keep custom Ollama endpoint commands consistent across
   overview, setup and library; the current examples still assume Ollama defaults.
   Check existing runtime/service ownership before adding Start/Stop controls.
   Download cancellation must not imply all cached layers were deleted.
2. **Make local chat recovery reliable.** Preserve conversations across navigation,
   keep host/model identity attached to each conversation, and add Edit & retry.
   Do not merely restore the prompt and append another turn: interrupted user
   messages are already retained in outgoing context, so naive retry duplicates
   them. Expose capacity/retry delay without automatically generating extra work.
3. **Build one private sharing journey end to end.** Separate operator-only runtime,
   request history and management APIs from guest model/chat APIs. Add durable
   access grants, revocation and per-client admission before internet exposure.
   Owner access must remain usable when guests fill capacity. Expose only selected
   models, not every installed model. An outbound tunnel or relay still needs an
   authenticated guest surface, HTTPS, and a public reachability check. Show
   starting, reachable, interrupted, stopped and revoked states; Stop sharing must
   terminate access and release guest work. The exact transport/provider remains
   a design decision, not an implemented service.
4. **Give clients a complete invite-to-chat path.** Opening an invitation should
   identify the host and model, establish access, then enter chat. Clients should
   not run the owner's Java/Ollama launcher. Distinguish unreachable host, invalid
   or revoked access, incompatible protocol, unavailable model and full capacity.
   Keep the draft/transcript through reconnects; never silently switch host/model.
   Explain who operates the host and receives the submitted messages before the
   first send. Guest access must not reveal owner telemetry or other clients' data.
5. **Add discoverability on top of working connections.** Save recent hosts locally;
   support explicit opt-in public listings with model/capability search, last-seen
   freshness, access requirements and capacity status. A directory needs a real
   registry/identity/heartbeat service; none exists in this repository. Avoid
   declaring a host healthy solely because its listing exists. Private invites
   must work without public listing, and removing a listing must not be confused
   with revoking access or stopping the host.

These priorities preserve the requested public host-discovery destination. Private
invites are a useful first complete sharing path, not a replacement for discovery.
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
- A failed prompt is not lost entirely: it remains visible and can remain in later
  context. The confirmed friction is missing composer/retry recovery.
- [Ollama's qwen3:0.6b listing](https://ollama.com/library/qwen3:0.6b) confirms the
  existing example tag. Its displayed 523MB is model storage, not a RAM estimate.
  HostAI did not download or run it during this audit.

UI evidence is retained under `test-results/setup-*-journey*.png`. Browser fixtures
verify the missing-runtime → empty-library → model-selection path and the actual
workspace origin. Full internet and remote-client journeys cannot be exercised
until their missing services and access boundaries exist.

## Local download cycle implemented

Setup now opens the in-app download form. A host explicitly supplies a tagged
Ollama library reference, starts one job, follows its current-layer progress,
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

This is deliberately labeled local preview throughout. It proves the owner/guest
boundary before transport integration. [Guest access](guest-access.md) documents
limits and the next internet-sharing work. Public discovery remains a separate
required product capability.
