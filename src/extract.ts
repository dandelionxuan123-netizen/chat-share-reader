import { getCachedPage, setCachedPage } from "./cache.js";
import { assertAllowedUrl, fetchSharePage } from "./fetchPage.js";
import { parseChatGPT, parseChatGPTApiData } from "./parsers/chatgpt.js";
import {
  ShareError,
  type ChatTranscript,
  type ExtractOptions,
  type Platform,
} from "./types.js";

export function detectPlatform(url: URL): Platform {
  const host = url.hostname.toLowerCase().replace(/^www\\./, "");
  if (host === "chatgpt.com" || host === "chat.openai.com") return "chatgpt";
  if (host === "claude.ai") return "claude";
  throw new ShareError("unsupported_host", `No parser for host "${host}".`);
}

/**
 * ChatGPT public shares can expose ordinary JSON at /backend-api/share/{id}.
 * Prefer it to extracting version-dependent React Flight data from the HTML.
 * Only a validated share id is used; never fetch arbitrary caller-supplied URLs.
 */
export async function fetchShareJson(
  shareUrl: URL,
  fetcher: typeof fetch = fetch
): Promise<{ transcriptData: unknown | null; diagnostic: string }> {
  const match = /^\\/share\\/([0-9a-f-]{16,})\\/?$/i.exec(shareUrl.pathname);
  if (!match) return { transcriptData: null, diagnostic: "share_path_invalid" };
  const endpoint = `https://chatgpt.com/backend-api/share/${match[1]}`;
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { transcriptData: null, diagnostic: "share_json_network_failure" };
  }
  if (!response.ok) return { transcriptData: null, diagnostic: `share_json_http_${response.status}` };
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    return { transcriptData: null, diagnostic: "share_json_unexpected_content_type" };
  }
  try {
    return { transcriptData: await response.json(), diagnostic: "share_json_ok" };
  } catch {
    return { transcriptData: null, diagnostic: "share_json_invalid_json" };
  }
}

/**
 * Fetch and parse a public shared conversation into the normalized schema.
 * Prefer the public JSON endpoint, fall back to legacy HTML decoding.
 * An HTML parse failure is not proof that the link was revoked.
 */
export async function extractTranscript(
  rawUrl: string,
  options: ExtractOptions = {}
): Promise<ChatTranscript> {
  const url = assertAllowedUrl(rawUrl.trim());
  const platform = detectPlatform(url);

  if (platform === "claude") {
    throw new ShareError(
      "claude_not_supported",
      `Claude share links can't be read programmatically. Two independent ` +
        `blockers: Cloudflare answers every non-browser client with 403 ` +
        `(cf-mitigated: challenge), and the page is client-side rendered, so ` +
        `even the HTML behind the challenge contains only meta tags — no ` +
        `conversation. This is a platform limitation, not a bug in this tool, ` +
        `and no amount of retrying or header tweaking gets around it.\\n\\n` +
        `Use the browser bookmarklet instead: it runs on the share page you ` +
        `already have open and copies the transcript as Markdown + JSON in ` +
        `this tool's schema. See bookmarklet/README.md.`
    );
  }

  if (!/^\\/share\\/[0-9a-f-]{16,}\\/?$/i.test(url.pathname)) {
    throw new ShareError(
      "not_a_share_link",
      "Please provide a public ChatGPT /share/<id> link, not a private /c/ URL."
    );
  }

  const api = await fetchShareJson(url);
  let jsonParseError = "";
  if (api.transcriptData !== null) {
    try {
      return parseChatGPTApiData(api.transcriptData, url.toString(), options);
    } catch (err) {
      jsonParseError = err instanceof Error ? err.message : String(err);
    }
  }

  const href = url.toString();
  try {
    let html = await getCachedPage(href);
    if (html === null) {
      html = await fetchSharePage(url);
      await setCachedPage(href, html);
    }
    return parseChatGPT(html, href, options);
  } catch (htmlError) {
    const htmlMessage = htmlError instanceof Error ? htmlError.message : String(htmlError);
    throw new ShareError(
      "share_read_failed",
      `Public share could not be read. JSON endpoint: ${api.diagnostic}` +
        (jsonParseError ? ` (${jsonParseError})` : "") +
        `; HTML fallback: ${htmlMessage}. ` +
        "This does not prove that the share link is invalid. " +
        "Check whether the link opens in a signed-out browser, and whether " +
        "the server received a bot challenge or a changed response format."
    );
  }
}
