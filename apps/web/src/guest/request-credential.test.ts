import { describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import { approvedAccessKey, createRequestCredential } from "./request-credential";

describe("client-held access approval credentials", () => {
  it("commits the access secret independently of the request polling credential", async () => {
    const credential = await createRequestCredential();
    const access = Buffer.from(credential.accessSecret, "base64url");
    const request = Buffer.from(credential.requestSecret, "base64url");
    expect(access).toHaveLength(32);
    expect(request).toHaveLength(32);
    expect(access.equals(request)).toBe(false);
    expect(credential.accessCommitment).toBe(createHash("sha256").update(access).digest("hex"));
    const grantId = "51e6b724-f7f7-4dd1-a74a-7140f86eaf3b";
    expect(approvedAccessKey(grantId, credential.accessSecret)).toBe(
      `hga1.${grantId}.${credential.accessSecret}`,
    );
  });

  it("cannot construct a token from malformed IDs or alternate secret encodings", async () => {
    const credential = await createRequestCredential();
    const id = "51e6b724-f7f7-4dd1-a74a-7140f86eaf3b";
    for (const invalid of ["", "../session", id.toUpperCase(), `${id}.injected`, `${id}\n`]) {
      expect(() => approvedAccessKey(invalid, credential.accessSecret)).toThrow(
        "Invalid approved access credential",
      );
    }
    for (const invalid of [
      "",
      "A".repeat(42),
      `${credential.accessSecret}=`,
      `${"A".repeat(42)}B`,
    ]) {
      expect(() => approvedAccessKey(id, invalid)).toThrow("Invalid approved access credential");
    }
  });
});
