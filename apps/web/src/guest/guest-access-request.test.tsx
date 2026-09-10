import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { GuestAccessRequest } from "./guest-access-request";
import { GuestChat } from "./guest-chat";
import {
  createGuestAccessRequest,
  useGuestAccessRequest,
  type GuestRequestView,
} from "./use-guest-access-request";

vi.mock("./use-guest-access-request", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-guest-access-request")>();
  return { ...actual, useGuestAccessRequest: vi.fn() };
});

const id = "51e6b724-f7f7-4dd1-a74a-7140f86eaf3b";
let state: GuestRequestView;
const onConnect = vi.fn();
const render = () =>
  renderToStaticMarkup(
    <GuestAccessRequest
      {...useGuestAccessRequest(true)}
      enabled
      connecting={false}
      onConnect={onConnect}
    />,
  );
beforeEach(() => {
  vi.stubGlobal("window", { location: { protocol: "https:" } });
  const request = createGuestAccessRequest();
  state = {
    ...request.getSnapshot(),
    details: "ready",
    hello: {
      version: 1,
      scope: "temporary-internet",
      requestsAccepted: true,
      intakeId: id,
      hostLabel: "Host",
      model: "model:small",
    },
  };
  vi.mocked(useGuestAccessRequest).mockImplementation(() => ({ state, request }));
  onConnect.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

it("renders host, model and guest names as plaintext, never HTML or Markdown", () => {
  state.hello = {
    ...state.hello!,
    requestsAccepted: true,
    intakeId: id,
    hostLabel: '<img src=x onerror="alert(1)">',
    model: "[model](javascript:alert(1))",
  };
  state.submission = { name: "<script>alert(1)</script>", model: state.hello.model };
  const html = render();
  expect(html).toContain("&lt;img");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("[model](javascript:alert(1))");
  expect(html).not.toMatch(/<(?:img|script|a)\b/);
});

it("offers explicit connection only after approval, with cancellation uncertainty blocking it", () => {
  state.submission = { name: "Guest", model: "model:small" };
  state.request = {
    version: 1,
    id,
    state: "pending",
    code: "ABC123",
    ...state.submission,
    channel: "internet",
    expiresInSeconds: 900,
    grantId: null,
    grantExpiresAt: null,
  };
  state.remainingSeconds = 900;
  expect(render()).not.toContain("Connect to model");
  state.request = {
    ...state.request,
    state: "approved",
    grantId: id,
    grantExpiresAt: "2026-09-10T00:00:00Z",
  };
  const connectButton = render().match(/<button([^>]*)>Connect to model<\/button>/);
  expect(connectButton).not.toBeNull();
  expect(connectButton![1]).not.toContain(' disabled=""');
  expect(onConnect).not.toHaveBeenCalled();
  state.recovery = "cancel";
  expect(render()).toMatch(/<button[^>]*disabled=""[^>]*>Connect to model<\/button>/);
  expect(render()).toContain("Retry cancellation");
});

it.each(["unavailable", "error", "unsupported"] as const)(
  "preserves the manual access-key form when requests are %s",
  (details) => {
    state.details = details;
    state.hello = null;
    const html = renderToStaticMarkup(<GuestChat />);
    expect(html).toMatch(/<input[^>]*id="guest-key"[^>]*type="password"/);
    expect(html).not.toContain('id="request-access-name"');
    expect(html).toMatch(/<details[^>]*open=""/);
    expect(html).not.toContain("Message composer");
  },
);

it("unconfirmed cancellation of a pending request does not assert that a key was issued", () => {
  state.submission = { name: "Guest", model: "model:small" };
  state.request = {
    version: 1,
    id,
    state: "pending",
    code: "ABC123",
    ...state.submission,
    channel: "internet",
    expiresInSeconds: 0,
    grantId: null,
    grantExpiresAt: null,
  };
  state.recovery = "cancel";
  state.intakeStopped = true;
  state.remainingSeconds = 0;
  const html = render();
  expect(html).toContain("revoke any key it issued");
  expect(html).not.toContain("revoke this key");
});
