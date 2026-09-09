import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Answer } from "./answer";
import { externalUrl } from "../../../shared/external-url.mjs";

describe("answer rendering", () => {
  it("does not repeat inactive autolinks", () => {
    const html = renderToStaticMarkup(
      <Answer text="http://example.com foo@example.com www.example.com" />,
    );
    expect(html).not.toContain(" (http");
    expect(html).not.toContain(" (mailto");
    expect(html).toContain("foo@example.com");
  });
  it("disables copying an empty fence", () => {
    const html = renderToStaticMarkup(<Answer text={"```\n```"} />);
    expect(html).toMatch(/aria-label="Copy code" disabled=""/);
  });
  it("renders headings, lists, inline code, fences and tables", () => {
    const html = renderToStaticMarkup(
      <Answer
        text={
          "# Example\n\n- **Strong** and `inline`\n\n```js\nconst n = 1;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |"
        }
      />,
    );
    expect(html).toContain("<h4>Example</h4>");
    expect(html).toContain("<strong>Strong</strong>");
    expect(html).toContain("<code>inline</code>");
    expect(html).toContain("const n = 1;");
    expect(html).toContain("<table>");
    expect(html).toContain('aria-label="Copy code"');
  });
  it("renders an unfinished fence without inventing source text", () => {
    const html = renderToStaticMarkup(<Answer text={'```python\nprint("hello")'} />);
    expect(html).toContain("<pre");
    expect(html).toContain("print(&quot;hello&quot;)");
  });
  it("never creates model-supplied HTML or fetchable images", () => {
    const html = renderToStaticMarkup(
      <Answer
        text={
          '<script>alert(1)</script>\n\n<img src="https://example.com/leak">\n\n![Diagram](https://example.com/image.png)'
        }
      />,
    );
    expect(html).not.toMatch(/<(script|img|iframe)\b/);
    expect(html).toContain("[Image: Diagram]");
    expect(html).toContain("&lt;script&gt;");
  });
  it("only activates credential-free HTTPS links in a separate context", () => {
    const html = renderToStaticMarkup(
      <Answer
        text={
          "[Docs](https://example.com/docs) [Bad](javascript:alert%281%29) [File](file:///tmp/a) [Relative](/api/chat)"
        }
      />,
    );
    expect(html).toContain(
      'href="https://example.com/docs" target="_blank" rel="noopener noreferrer"',
    );
    expect(html.match(/<a /g) ?? []).toHaveLength(1);
  });
});

describe("shared browser and desktop external URL policy", () => {
  it.each([
    "https://example.com/docs",
    "https://github.com/remarkjs/react-markdown",
    "https://docs.ollama.com/",
  ])("accepts %s", (url) => expect(externalUrl(url)).toBe(url));
  it.each([
    "javascript:alert(1)",
    "file:///tmp/a",
    "data:text/html,hi",
    "http://example.com",
    "/api/chat",
    "//example.com",
    "mailto:a@example.com",
    "https://user:secret@example.com",
    "https://",
  ])("rejects %s", (url) => expect(externalUrl(url)).toBeNull());
});
