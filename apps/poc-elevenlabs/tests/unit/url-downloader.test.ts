import { describe, expect, it } from "vitest";
import { isPublicAddress, resolvePublicAddress } from "../../src/url-downloader.js";

describe("URL download network policy", () => {
  it("blocks private, loopback, link-local, documentation, and mapped addresses", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "192.0.2.10",
      "::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    await expect(resolvePublicAddress("127.0.0.1")).rejects.toMatchObject({
      code: "VIDEO_URL_PRIVATE_ADDRESS",
    });
  });

  it("allows ordinary public addresses", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
});
