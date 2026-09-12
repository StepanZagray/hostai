# Using models

HostAI can discover installed models from Ollama or from another configured
local runtime. It can download models only through the configured Ollama
origin; other runtimes are not download managers. See the [runtime protocol](model-ui.md)
for custom runtimes and the [starter model list](starter-models.md) for the
bundled first-run choices.

## Connect and download

Start Ollama, then open **Models → Download a model**. Choose a [starter
model](starter-models.md) with a published approximate size, or enter a custom
explicit library tag. Review the model details and explicitly start the
download. Choosing a starter only fills the form; it does not start a job or
estimate RAM/VRAM fit. An installed model can go straight to Playground.

The default Ollama origin is `http://127.0.0.1:11434`. To use another local
port:

```sh
HOSTAI_OLLAMA_URL=http://127.0.0.1:11435 pnpm dev
```

HostAI accepts only loopback Ollama origins. Keep Ollama configured for local
inference. Downloading or running a model consumes disk, memory and compute;
HostAI does not measure available disk, RAM or VRAM, reserve capacity, or
predict model fit or speed. Inference memory also depends on context length
and parallel requests. The [Ollama memory explanation](https://docs.ollama.com/faq#how-does-ollama-handle-concurrent-requests)
has more background.

## Discovery and admission

Model discovery keeps unavailable entries visible with the gateway's reason.
The Playground chooses a model that passes known gateway rules and blocks an
unsupported selection before Send. Refreshing availability preserves the
selected model's conversation; discovery does not probe model capabilities or
memory. If the web app is updated, restart the Java gateway too: missing
admission metadata is shown as unknown and cannot enable generation.

Runtime models report separate `chat` and `infer` capabilities. A model with a
custom UI needs inference support; a model with chat support can use HostAI's
default chat panel. Models with neither supported interface remain listed but
cannot chat or be shared. The [runtime protocol](model-ui.md) describes these
contracts in detail.

## Download lifecycle and recovery

After the host explicitly starts a download, HostAI shows the current layer's
progress, cancellation and retry. Completion refreshes the library and offers
**Try downloaded model**. Downloads started directly in the Ollama terminal
also appear after refresh.

Download jobs run one at a time and retain only the latest 20 records in
memory. A gateway restart clears those records and stops its active request;
Ollama keeps model files and may retain partial layers. Cancelling HostAI's job
stops this gateway request, not a download another Ollama client started.
There is no catalog search, disk/RAM fit estimate or automatic download
resumption. See the [backend download contract](../backend/README.md#local-model-downloads)
for request fields, state transitions and validation rules.

If a running download disappears from a successful status check, the Models
page retains a **Status unknown** notice and checks the library. The host can
try the model if it is available, check status again, explicitly download
again with a new request, or dismiss the notice. A missing record does not
prove that Ollama stopped or that the model finished. Up to 20 notices and the
model entry remain in the owner tab through navigation; reload or closing the
tab clears them. Dismissing a notice does not cancel work or delete files.

## Playground behavior and recovery

Owner conversations, drafts and run settings stay separate per model and
survive in-app navigation. Switching models shows that model's retained work;
clearing the conversation starts fresh. Leaving Playground stops generation;
reloading or closing the tab clears all of this work. A model's own interface
keeps its state inside its frame; leaving Playground unmounts it and HostAI does
not persist it. Runtime and request metrics come from the backend, never sample
data. The interface follows the system light/dark preference; the header
control can switch between system, light and dark and remembers that choice in
the browser.

Interrupted answers remain visible with an exclusion label. Later prompts reuse
recent user messages and completed, nonblank answers; both halves of an
unfinished exchange are excluded from later model context. The Playground keeps
the newest whole turns that fit the gateway's message, character and
serialized-upload limits. Before Send, it discloses how many older turns will
be omitted, including when only the new message fits. The new message and
visible transcript remain intact, and each sent message records its omission
count. These are request limits, not a model's token window. Oversized new
messages remain editable with a visible error until shortened.

Streaming follows the latest output until the user scrolls back to read. **Jump
to latest**, scrolling to the bottom, or sending a new prompt resumes it.
Keyboard users can focus the conversation pane and use its native scroll keys;
automatic scrolling stays inside that pane and preserves the surrounding page.

Assistant answers support Markdown headings, lists, tables and scrollable code
blocks. Copy response preserves the original Markdown; Copy code copies the
current block. Interrupted output is labeled **Copy partial response** and
stays excluded from later prompts. Raw HTML displays as text and images display
their alt text without downloading anything. Credential-free HTTPS links open
separately, in the system browser on desktop. Code uses plain monospace without
highlighting.
