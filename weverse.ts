// Calls the API weverse.io's own web app uses. Public data needs no sign-in,
// only the web app's request signature (an HMAC of the path and a timestamp).

export const WEVERSE_APP_ID = "be4d79eb8fc7bd008ee82c8ec4ff6fd4";
export const WEVERSE_BASE_URL = "https://global.apis.naver.com/weverse/wevweb";
const WEVERSE_HMAC_KEY = "1b9cb6378d959b45714bec49971ade22e6e24e42";
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

export const WEVERSE_COMMON_QUERY = {
  appId: WEVERSE_APP_ID,
  language: "en",
  os: "WEB",
  platform: "WEB",
  wpf: "pc",
};

const createWeverseHash = async (pathname: string) => {
  const timestamp = Date.now();
  const salt = pathname.substring(0, Math.min(255, pathname.length)) + timestamp;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEVERSE_HMAC_KEY),
    { name: "HMAC", hash: { name: "SHA-1" } },
    false,
    ["sign", "verify"],
  );

  const hash = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(salt)),
      ),
    ),
  );

  return { wmsgpad: timestamp.toString(), wmd: hash };
};

const createWeverseUrl = async (
  pathname: string,
  query: Record<string, string>,
) => {
  const unsignedPath = `${pathname}?${new URLSearchParams(query).toString()}`;
  const signedParams = new URLSearchParams(await createWeverseHash(unsignedPath));
  return `${WEVERSE_BASE_URL}${unsignedPath}&${signedParams.toString()}`;
};

export const weverseFetch = async <T>(
  pathname: string,
  query: Record<string, string>,
) => {
  const response = await fetch(await createWeverseUrl(pathname, query), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Origin: "https://weverse.io",
      Referer: "https://weverse.io/",
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Weverse request failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as T;
};
