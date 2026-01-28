// 예: core-heart/src/api/wikiSummary.ts
import type { Request, Response } from "express";
import fetch from "node-fetch";

const WIKI_API_ENDPOINT = "https://ko.wikipedia.org/w/api.php";

export async function wikiSummaryHandler(req: Request, res: Response) {
  try {
    const q = (req.query.q as string | undefined)?.trim();
    if (!q) {
      return res.status(400).json({ error: "missing q" });
    }

    const title = q.replace(/\s+/g, "_");

    const url =
      `${WIKI_API_ENDPOINT}` +
      `?action=query` +
      `&prop=extracts` +
      `&exintro=1` +
      `&explaintext=1` +
      `&format=json` +
      `&titles=${encodeURIComponent(title)}`;

    const wikiRes = await fetch(url);
    if (!wikiRes.ok) {
      return res
        .status(502)
        .json({ error: "wiki_bad_status", status: wikiRes.status });
    }

    const data: any = await wikiRes.json();
    const pages = data?.query?.pages;
    const firstKey = pages ? Object.keys(pages)[0] : undefined;
    const page = firstKey ? pages[firstKey] : undefined;
    const extract: string = page?.extract || "";
    const pageTitle: string = page?.title || q;

    if (!extract) {
      return res.status(404).json({ error: "no_extract", title: pageTitle });
    }

    const pageUrl = `https://ko.wikipedia.org/wiki/${encodeURIComponent(
      pageTitle.replace(/\s+/g, "_")
    )}`;

    return res.json({
      title: pageTitle,
      summary: extract,
      url: pageUrl,
    });
  } catch (e) {
    console.error("[wikiSummaryHandler] error", e);
    return res.status(500).json({ error: "server_error" });
  }
}
