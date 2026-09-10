/** A bundled shortlist, not live catalog or hardware-fit data. Sources checked 2026-09-10. */
export const starterModels = [
  {
    tag: "qwen2.5:0.5b",
    label: "Smallest download in this list",
    size: "398 MB",
    description: "A compact text-chat model for a first local prompt.",
    source: "https://ollama.com/library/qwen2.5:0.5b",
  },
  {
    tag: "gemma3:1b",
    label: "Another compact text model",
    size: "815 MB",
    description: "A text-only Gemma model. Requires Ollama 0.6 or later.",
    source: "https://ollama.com/library/gemma3:1b",
  },
  {
    tag: "qwen2.5:3b",
    label: "Larger download",
    size: "1.9 GB",
    description: "A larger text-chat option to compare with the smaller models.",
    source: "https://ollama.com/library/qwen2.5:3b",
  },
] as const;
