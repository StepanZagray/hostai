import { expect, it } from "vite-plus/test";
import {
  directoryOrigin,
  readSavedHosts,
  saveHost,
  removeSavedHost,
  savedHostPrefix,
} from "./saved-hosts";
const origin = "https://directory.example";
const host = (id = "a".repeat(64)) => ({ id, hostLabel: "Remembered host", model: "model:small" });
function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}
it("saves IDs and labels only, isolates exact registry origins and removes only the selected host", () => {
  const store = storage();
  saveHost(store, origin, {
    ...host(),
    guestUrl: "https://private.trycloudflare.com/#access=secret",
  } as ReturnType<typeof host>);
  saveHost(store, "https://other.example", host());
  const record = store.getItem(savedHostPrefix(origin) + host().id)!;
  expect(JSON.parse(record)).toEqual(host());
  expect(record).not.toMatch(/secret|guestUrl|trycloudflare/);
  expect(readSavedHosts(store, origin + "/")).toEqual([host()]);
  removeSavedHost(store, origin, host().id);
  expect(readSavedHosts(store, origin)).toEqual([]);
  expect(readSavedHosts(store, "https://other.example")).toEqual([host()]);
});
it("independent entries preserve another tab's save and removal", () => {
  const store = storage();
  saveHost(store, origin, host());
  saveHost(store, origin, host("b".repeat(64)));
  removeSavedHost(store, origin, host().id);
  saveHost(store, origin, host("c".repeat(64)));
  expect(readSavedHosts(store, origin).map((item) => item.id)).toEqual([
    "b".repeat(64),
    "c".repeat(64),
  ]);
});
it("tolerates a host removed by another tab during enumeration", () => {
  const store = storage();
  saveHost(store, origin, host());
  const getItem = store.getItem;
  store.getItem = (key) => {
    store.removeItem(key);
    return getItem(key);
  };
  expect(readSavedHosts(store, origin)).toEqual([]);
});
it("malformed or future data is left intact and blocks writes", () => {
  for (const raw of [
    "{",
    "null",
    JSON.stringify({ ...host(), futureField: true }),
    JSON.stringify({ ...host(), model: "bad\nmodel" }),
    "x".repeat(2001),
  ]) {
    const store = storage();
    const key = savedHostPrefix(origin) + host().id;
    store.setItem(key, raw);
    expect(() => readSavedHosts(store, origin)).toThrow();
    expect(() => saveHost(store, origin, host("b".repeat(64)))).toThrow();
    expect(store.getItem(key)).toBe(raw);
    expect(store.length).toBe(1);
  }
});
it("refuses new saves at capacity without evicting and still permits updates/removal", () => {
  const store = storage();
  for (let i = 0; i < 50; i++) saveHost(store, origin, host(i.toString(16).padStart(64, "0")));
  expect(() => saveHost(store, origin, host())).toThrow("Save up to 50");
  saveHost(store, origin, { ...host("0".repeat(64)), model: "updated:small" });
  expect(readSavedHosts(store, origin)).toHaveLength(50);
  removeSavedHost(store, origin, "0".repeat(64));
  saveHost(store, origin, host());
  expect(readSavedHosts(store, origin)).toHaveLength(50);
});
it("propagates write failures without replacing existing entries", () => {
  const store = storage();
  saveHost(store, origin, host());
  store.setItem = () => {
    throw new Error("Quota");
  };
  expect(() => saveHost(store, origin, host("b".repeat(64)))).toThrow();
  expect(readSavedHosts(store, origin)).toEqual([host()]);
});
it("normalizes origins and rejects credentials, paths and unsupported schemes", () => {
  expect(directoryOrigin("https://DIRECTORY.example:443/")).toBe(origin);
  expect(directoryOrigin("http://127.0.0.1:8090/")).toBe("http://127.0.0.1:8090");
  for (const bad of [
    "https://user@directory.example",
    "https://directory.example/path",
    "https://directory.example/?key=secret",
    "http://public.example",
    "javascript:alert(1)",
  ])
    expect(() => directoryOrigin(bad)).toThrow();
});
