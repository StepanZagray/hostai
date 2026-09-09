# Host and client journeys

The intended product supports two people: a host owner making a local model
available, and a client finding a host and chatting without managing inference
software. The current product implements local discovery and chat. **In-app model
downloads, remote client access, authentication, internet sharing and a public host
directory are not implemented.** This audit describes the complete destination;
the initial setup fixes below do not complete it.

Reviewed with Claude Opus 5 High on 9 September 2026. Code and isolated UI fixtures
are the evidence. No real model was downloaded, inference benchmark run, tunnel
opened, or public endpoint deployed.

## What works and where the journey stops

| Person and step | Current evidence | Friction or missing capability | Intended experience |
| --- | --- | --- | --- |
| Host: open HostAI | [Source launcher](../scripts/workspace.mjs) starts Java, UI, then Electron | Requires source checkout, Node/pnpm and Java; no distributable installer. Window appears only after services start. | Launch one app, see startup progress and recoverable errors before setup. |
| Host: prepare inference | [Setup](../apps/web/src/routes/connection.tsx) shows Ollama commands | Ollama installation/startup are external; a failed status check is not proof that a process is stopped. | Detect existing runtime, explain the missing part, show only the action needed. |
| Host: choose/download a model | [Library](../apps/web/src/routes/models.tsx) lists installed models and a pull command | No catalog, fit estimate, progress, cancellation, resumable job or download error state in HostAI. | Review model size/requirements, explicitly start download, see progress, recover, then test that same model. |
| Host: refresh discovery | [HostProvider](../apps/web/src/lib/host-context.tsx) polls every 15 seconds while visible; manual refresh also exists | Download completion has no immediate handoff into selection. | Completion reveals the downloaded model and a clear Try action; avoid a second competing poller. |
| Host: select and test | [Library](../apps/web/src/routes/models.tsx) links a selected model into [Playground](../apps/web/src/routes/playground.tsx) | Admission means allowed to try, not successfully loaded or proven to fit memory. No explicit first-run test status. | Selected model stays visible during loading/testing; distinguish installed, testing, ready, busy and unavailable. |
| Host: start serving | [Java controller](../backend/src/main/java/com/hostai/backend/ApiController.java) serves local requests once the gateway starts | No independent model publication/start-stop state. Selecting a model in chat does not publish it. | Choose which model clients may use, test it, then enable serving deliberately. |
| Host: share over internet | [Java config](../backend/src/main/resources/application.properties) and [web server](../apps/web/server.mjs) bind loopback | No identities, guest API, access grants, revocation, tunnel, TLS ingress or reachability verification. | Share a verified endpoint with selected clients; expose status and Stop sharing in the same place. |
| Client: find a host | No host directory, saved remote hosts or invite handling exists | Installed-model search is not host discovery. | Open an invite or browse explicitly listed hosts by model/capability; distinguish online, busy, offline and stale listings. |
| Client: connect | [Shell](../apps/web/src/components/shell.tsx) exposes one local host workspace | No remote address/identity/session or client mode. The local Ollama address is not a share URL. | See host identity, model and access requirements; connect without installing Java, Ollama or a model. |
| Client: chat | Current Playground uses same-origin `/api/chat` | A remote client would inherit the owner-facing UI/API if this app were simply exposed. | A client-only conversation surface, with authenticated access to allowed models and useful recovery states. |
| Either: recover a send | Failed/stopped prompt stays in the transcript; partial answers are excluded from later context | Composer is cleared and no Retry/Edit action exists. Overload is a generic error despite `Retry-After`. | Edit/retry the failed turn without manually copying text or duplicating its context; preserve partial output. |
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

1. **Complete local onboarding and model lifecycle.** Add a host-owned model catalog
   and download job lifecycle: queued, downloading, verifying, complete, failed,
   cancelled. Show downloaded/total bytes when known, an indeterminate state when
   unknown, and cancellation/retry outcomes. A tag's file size is not a guarantee
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
