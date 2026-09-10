import type { Listing } from "./registry";

export type SavedHost = Pick<Listing, "id" | "hostLabel" | "model">;
const prefix = "hostai.saved-host.v1:";
const idPattern = /^[a-f0-9]{64}$/;
export const savedHostLimit = 50;

export function directoryOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))
  )
    throw new Error("Invalid directory origin");
  return url.origin;
}
export function savedHostPrefix(registry: string) {
  return `${prefix}${encodeURIComponent(directoryOrigin(registry))}:`;
}
const label = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  !Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
function parse(value: string | null, id: string): SavedHost {
  if (!value || value.length > 2000) throw new Error("Saved hosts could not be read.");
  const item = JSON.parse(value);
  if (
    !item ||
    !idPattern.test(id) ||
    item.id !== id ||
    !label(item.hostLabel, 80) ||
    !label(item.model, 200) ||
    Object.keys(item).some((key) => !["id", "hostLabel", "model"].includes(key))
  )
    throw new Error("Saved hosts could not be read.");
  return { id, hostLabel: item.hostLabel, model: item.model };
}

// Each host has its own atomic storage key: writes in another tab cannot replace the whole list.
export function readSavedHosts(storage: Storage, registry: string): SavedHost[] {
  const scope = savedHostPrefix(registry);
  const result: SavedHost[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(scope)) continue;
    const value = storage.getItem(key);
    // Another tab can remove the entry between enumeration and reading it.
    if (value === null) continue;
    if (result.length >= 100) throw new Error("Saved hosts could not be read.");
    result.push(parse(value, key.slice(scope.length)));
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
export function saveHost(storage: Storage, registry: string, host: SavedHost) {
  const entries = readSavedHosts(storage, registry);
  if (!entries.some((item) => item.id === host.id) && entries.length >= savedHostLimit)
    throw new Error("Save up to 50 hosts per directory. Remove a saved host first.");
  const data = { id: host.id, hostLabel: host.hostLabel, model: host.model };
  const serialized = JSON.stringify(data);
  parse(serialized, host.id);
  storage.setItem(savedHostPrefix(registry) + host.id, serialized);
}
export function removeSavedHost(storage: Storage, registry: string, id: string) {
  if (!idPattern.test(id)) throw new Error("Invalid saved host.");
  storage.removeItem(savedHostPrefix(registry) + id);
}
