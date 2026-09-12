# Starter model choices

The model download form includes a bundled shortlist for a first local text-chat
prompt. Choosing a starter only fills the existing explicit-tag field. The host
must press Download model to start a job. Custom local tags and the complete
[Ollama library](https://ollama.com/library) remain available.

These are compact examples, not a live catalog, a quality ranking, or recommendations
based on the host's hardware. HostAI does not measure available disk, RAM or VRAM,
reserve capacity, or predict model fit or speed. Inference memory also depends on
context length and parallel requests; see [Ollama's memory explanation](https://docs.ollama.com/faq#how-does-ollama-handle-concurrent-requests).

## Published sizes and sources

Checked against the exact Ollama tag pages on 10 September 2026 (local machine date).
Sizes below use the publisher's decimal units. Cached layers can reduce actual
transfer; tags and published sizes can change. Model file size is not the memory
required to run it. The listing links include the model's terms.

| Explicit tag | Listed model size | Purpose of inclusion | Source |
| --- | --- | --- | --- |
| `qwen2.5:0.5b` | approximately 398 MB | Smallest download in this shortlist; text chat | [Exact listing](https://ollama.com/library/qwen2.5:0.5b) |
| `gemma3:1b` | approximately 815 MB | Another compact text model; Ollama 0.6 or later | [Exact listing](https://ollama.com/library/gemma3:1b) |
| `qwen2.5:3b` | approximately 1.9 GB | A larger text-chat option for comparison | [Exact listing](https://ollama.com/library/qwen2.5:3b) |

The shortlist intentionally avoids promising the latest or best model. These tags
were verified in the public listings, not downloaded or benchmarked during this UX
cycle. Successful inference on a particular host still requires an explicit test.
The default interface is text chat; a runtime may instead provide
[its own interface](model-ui.md). Listing other family members with vision or tools
does not make those capabilities available in HostAI.

## Selection and recovery

- The chooser and tag field have one selected value. Typing a custom tag removes
  the starter's size/source information, so an unrelated tag cannot inherit it.
- Both controls lock while a start is pending or uncertain. Retrying an uncertain
  request retains the original request ID and model. The existing explicit change
  action remains the way to leave uncertainty; it does not cancel accepted work.
- An exact installed tag offers Try installed model when runtime admission allows
  chat. Download again remains an explicit way to check upstream files for updates.
- Browsing choices works while Ollama is offline. Downloading remains blocked,
  with its setup/status explanation linked to the button for assistive technology.
- The connected empty-library action focuses the chooser. Download completion still
  refreshes actual model discovery before offering the same-model Playground link.
  Choosing, completing a download and opening Playground do not send a prompt.

Source data lives in `apps/web/src/lib/starter-models.ts`. When changing it, verify
the exact tag page, size, modality and any stated runtime minimum; update the date
in the data comment, UI and this record. The invariant test rejects malformed,
cloud or duplicate tags and requires the matching official listing URL.
