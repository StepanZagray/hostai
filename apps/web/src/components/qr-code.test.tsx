import { renderToStaticMarkup } from "react-dom/server";
import { encode } from "uqr";
import { describe, expect, it } from "vite-plus/test";
import { QrCode } from "./qr-code";

const url = "https://example.com/join?key=ABC-123";
function attribute(html: string, name: string) {
  return html.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? "";
}

describe("qr code rendering", () => {
  it("renders an inline labelled image rather than markup or a fetchable source", () => {
    const html = renderToStaticMarkup(<QrCode value={url} title="Scan to open the guest link" />);
    expect(html).toContain("<svg");
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Scan to open the guest link"');
    expect(html).not.toMatch(/<img\b/);
    expect(html).not.toContain(url);
  });
  it("surrounds the modules with a four-module quiet zone", () => {
    const html = renderToStaticMarkup(<QrCode value={url} title="Guest link" />);
    const modules = encode(url, { ecc: "M" }).size;
    expect(attribute(html, "viewBox")).toBe(`0 0 ${modules + 8} ${modules + 8}`);
    expect(attribute(html, "d").length).toBeGreaterThan(0);
    expect(attribute(html, "d")).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(html).toContain('fill="#000"');
    expect(html).toContain('fill="#fff"');
  });
  it("encodes each value into its own modules", () => {
    const first = renderToStaticMarkup(<QrCode value={url} title="Guest link" />);
    const second = renderToStaticMarkup(<QrCode value={`${url}X`} title="Guest link" />);
    expect(attribute(first, "d")).not.toBe(attribute(second, "d"));
  });
  it("renders nothing instead of throwing when the value exceeds every QR version", () => {
    const html = renderToStaticMarkup(<QrCode value={"a".repeat(5000)} title="Guest link" />);
    expect(html).toBe("");
  });
});
