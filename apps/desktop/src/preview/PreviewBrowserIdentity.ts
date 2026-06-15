const ELECTRON_PRODUCT_PATTERN = /\s*Electron\/[\d.]+/g;
const T3CODE_PRODUCT_PATTERN = /\s*t3code\/[\d.]+/gi;
const T3CODE_APP_PRODUCT_PATTERN = /\s*T3 Code \([^)]+\)\/[\d.]+/gi;
const WHITESPACE_PATTERN = /\s+/g;
const CHROME_PRODUCT_PATTERN = /\bChrome\/([\d.]+)/;
const APPLE_WEBKIT_PRODUCT_PATTERN = /\bAppleWebKit\/([\d.]+)/;
const SAFARI_PRODUCT_PATTERN = /\bSafari\/([\d.]+)/;
const PLATFORM_COMMENT_PATTERN = /^Mozilla\/5\.0\s+(\([^)]*\))\s+/;

export const PREVIEW_BROWSER_IDENTITY_COMPATIBILITY_VERSION = "preview-browser-identity-v1";

interface PreviewUserAgentBrand {
  readonly brand: string;
  readonly version: string;
}

interface PreviewUserAgentMetadata {
  readonly brands: readonly PreviewUserAgentBrand[];
  readonly fullVersionList: readonly PreviewUserAgentBrand[];
  readonly fullVersion: string;
  readonly platform: string;
  readonly platformVersion: string;
  readonly architecture: string;
  readonly model: string;
  readonly mobile: boolean;
  readonly bitness: string;
  readonly wow64: boolean;
}

export interface PreviewUserAgentFallbackApp {
  userAgentFallback: string;
}

const CLIENT_HINT_HEADER_NAMES = new Set([
  "sec-ch-ua",
  "sec-ch-ua-full-version",
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-ch-ua-platform-version",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-model",
  "sec-ch-ua-wow64",
]);

export function normalizePreviewUserAgent(userAgent: string): string {
  const withoutAppTokens = userAgent
    .replace(ELECTRON_PRODUCT_PATTERN, "")
    .replace(T3CODE_PRODUCT_PATTERN, "")
    .replace(T3CODE_APP_PRODUCT_PATTERN, "")
    .replace(WHITESPACE_PATTERN, " ")
    .trim();

  const chromeVersion = CHROME_PRODUCT_PATTERN.exec(withoutAppTokens)?.[1];
  if (!chromeVersion) return withoutAppTokens;

  const platformComment = PLATFORM_COMMENT_PATTERN.exec(withoutAppTokens)?.[1];
  const webkitVersion = APPLE_WEBKIT_PRODUCT_PATTERN.exec(withoutAppTokens)?.[1] ?? "537.36";
  const safariVersion = SAFARI_PRODUCT_PATTERN.exec(withoutAppTokens)?.[1] ?? "537.36";
  return [
    "Mozilla/5.0",
    platformComment,
    `AppleWebKit/${webkitVersion}`,
    "(KHTML, like Gecko)",
    `Chrome/${chromeVersion}`,
    `Safari/${safariVersion}`,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

export function installPreviewUserAgentFallback(app: PreviewUserAgentFallbackApp): string {
  const userAgent = normalizePreviewUserAgent(app.userAgentFallback);
  app.userAgentFallback = userAgent;
  return userAgent;
}

function chromeVersion(userAgent: string): { readonly major: string; readonly full: string } {
  const match = /Chrome\/([\d.]+)/.exec(userAgent);
  const full = match?.[1] ?? "140.0.0.0";
  return { full, major: full.split(".")[0] ?? "140" };
}

function platformMetadata(
  userAgent: string,
): Pick<PreviewUserAgentMetadata, "architecture" | "bitness" | "platform" | "platformVersion"> {
  if (/Mac OS X/i.test(userAgent)) {
    return { architecture: "arm", bitness: "64", platform: "macOS", platformVersion: "15.0.0" };
  }
  if (/Linux/i.test(userAgent)) {
    return { architecture: "x86", bitness: "64", platform: "Linux", platformVersion: "" };
  }
  return { architecture: "x86", bitness: "64", platform: "Windows", platformVersion: "10.0.0" };
}

function previewBrands(userAgent: string): {
  readonly brands: readonly PreviewUserAgentBrand[];
  readonly fullVersionList: readonly PreviewUserAgentBrand[];
  readonly fullVersion: string;
} {
  const { full, major } = chromeVersion(userAgent);
  return {
    brands: [
      { brand: "Google Chrome", version: major },
      { brand: "Chromium", version: major },
      { brand: "Not=A?Brand", version: "24" },
    ],
    fullVersionList: [
      { brand: "Google Chrome", version: full },
      { brand: "Chromium", version: full },
      { brand: "Not=A?Brand", version: "24.0.0.0" },
    ],
    fullVersion: full,
  };
}

function createPreviewUserAgentMetadata(userAgent: string): PreviewUserAgentMetadata {
  const normalized = normalizePreviewUserAgent(userAgent);
  return {
    ...previewBrands(normalized),
    ...platformMetadata(normalized),
    model: "",
    mobile: false,
    wow64: false,
  };
}

function navigatorPlatform(metadata: PreviewUserAgentMetadata): string {
  switch (metadata.platform) {
    case "macOS":
      return "MacIntel";
    case "Linux":
      return "Linux x86_64";
    default:
      return "Win32";
  }
}

export function createPreviewUserAgentOverride(userAgent: string): {
  readonly userAgent: string;
  readonly acceptLanguage: string;
  readonly platform: string;
  readonly userAgentMetadata: PreviewUserAgentMetadata;
} {
  const normalized = normalizePreviewUserAgent(userAgent);
  const metadata = createPreviewUserAgentMetadata(normalized);
  return {
    acceptLanguage: "en-US,en;q=0.9",
    platform: navigatorPlatform(metadata),
    userAgent: normalized,
    userAgentMetadata: metadata,
  };
}

function quoteClientHint(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function formatBrands(brands: readonly PreviewUserAgentBrand[]): string {
  return brands
    .map((brand) => `${quoteClientHint(brand.brand)};v=${quoteClientHint(brand.version)}`)
    .join(", ");
}

export function applyPreviewUserAgentHeaders(
  requestHeaders: Record<string, string>,
  userAgent: string,
): Record<string, string> {
  const normalized = normalizePreviewUserAgent(userAgent);
  const metadata = createPreviewUserAgentMetadata(normalized);
  const next = { ...requestHeaders };
  for (const header of Object.keys(next)) {
    const normalizedHeader = header.toLowerCase();
    if (normalizedHeader === "user-agent" || CLIENT_HINT_HEADER_NAMES.has(normalizedHeader)) {
      delete next[header];
    }
  }
  next["User-Agent"] = normalized;
  next["sec-ch-ua"] = formatBrands(metadata.brands);
  next["sec-ch-ua-full-version"] = quoteClientHint(metadata.fullVersion);
  next["sec-ch-ua-full-version-list"] = formatBrands(metadata.fullVersionList);
  next["sec-ch-ua-mobile"] = "?0";
  next["sec-ch-ua-platform"] = quoteClientHint(metadata.platform);
  next["sec-ch-ua-platform-version"] = quoteClientHint(metadata.platformVersion);
  next["sec-ch-ua-arch"] = quoteClientHint(metadata.architecture);
  next["sec-ch-ua-bitness"] = quoteClientHint(metadata.bitness);
  next["sec-ch-ua-model"] = quoteClientHint(metadata.model);
  next["sec-ch-ua-wow64"] = "?0";
  return next;
}
