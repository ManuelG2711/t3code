import { describe, expect, it } from "vite-plus/test";

import {
  applyPreviewUserAgentHeaders,
  createPreviewUserAgentOverride,
  installPreviewUserAgentFallback,
  normalizePreviewUserAgent,
} from "./PreviewBrowserIdentity.ts";

const PREVIEW_USER_AGENT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.207 Safari/537.36";

describe("PreviewBrowserIdentity", () => {
  it("rebuilds a Chrome-style user agent without Electron or app product tokens", () => {
    expect(
      normalizePreviewUserAgent(
        "Mozilla/5.0 AppleWebKit/537.36 T3 Code (Alpha)/0.0.27 Chrome/140.0.7339.207 Electron/41.5.0 Safari/537.36",
      ),
    ).toBe(PREVIEW_USER_AGENT);
  });

  it("leaves already clean Chrome user agents unchanged", () => {
    expect(normalizePreviewUserAgent(PREVIEW_USER_AGENT)).toBe(PREVIEW_USER_AGENT);
  });

  it("collapses whitespace left behind by removed tokens", () => {
    expect(
      normalizePreviewUserAgent(
        "Mozilla/5.0   t3code/0.0.27   Chrome/140.0.7339.207   Electron/41.5.0   Safari/537.36",
      ),
    ).toBe(PREVIEW_USER_AGENT);
  });

  it("sanitizes the Electron app user agent fallback", () => {
    const app = {
      userAgentFallback:
        "Mozilla/5.0 AppleWebKit/537.36 T3 Code (Alpha)/0.0.27 Chrome/140.0.7339.207 Electron/41.5.0 Safari/537.36",
    };

    expect(installPreviewUserAgentFallback(app)).toBe(PREVIEW_USER_AGENT);
    expect(app.userAgentFallback).toBe(PREVIEW_USER_AGENT);
  });

  it("creates Chrome-like UA client hint metadata", () => {
    const override = createPreviewUserAgentOverride(
      "Mozilla/5.0 AppleWebKit/537.36 T3 Code (Alpha)/0.0.27 Chrome/140.0.7339.207 Electron/41.5.0 Safari/537.36",
    );

    expect(override.userAgent).toBe(PREVIEW_USER_AGENT);
    expect(override.acceptLanguage).toBe("en-US,en;q=0.9");
    expect(override.platform).toBe("Win32");
    expect(override.userAgentMetadata.brands).toContainEqual({
      brand: "Google Chrome",
      version: "140",
    });
    expect(override.userAgentMetadata.fullVersionList).toContainEqual({
      brand: "Google Chrome",
      version: "140.0.7339.207",
    });
  });

  it("rewrites UA and client hint request headers", () => {
    expect(
      applyPreviewUserAgentHeaders(
        {
          "user-agent": "Mozilla/5.0 Electron/41.5.0",
          "sec-ch-ua": '"Electron";v="41"',
          accept: "text/html",
        },
        "Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.7339.207 Electron/41.5.0 Safari/537.36",
      ),
    ).toMatchObject({
      "User-Agent": PREVIEW_USER_AGENT,
      "sec-ch-ua": '"Google Chrome";v="140", "Chromium";v="140", "Not=A?Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      accept: "text/html",
    });
  });
});
