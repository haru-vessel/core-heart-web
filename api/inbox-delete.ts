import type { VercelRequest, VercelResponse } from "@vercel/node";

function cors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-admin-key");
}

async function ghJson(url: string, token: string, init?: RequestInit) {
  const r = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(init?.headers || {}),
    },
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${data?.message || text}`);
  return data;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    // ✅ 보호키 (아무나 삭제 못 하게)
    const adminKey = process.env.ADMIN_KEY || "";
    const gotKey = String(req.headers["x-admin-key"] || "");
    if (!adminKey || gotKey !== adminKey) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const token = process.env.GITHUB_TOKEN!;
    const owner = process.env.GITHUB_OWNER!;
    const repo = process.env.GITHUB_REPO!;
    const branch = process.env.GITHUB_BRANCH || "main";
    if (!token || !owner || !repo) {
      return res.status(500).json({ ok: false, error: "Missing GitHub env vars" });
    }

    const { path } = (req.body || {}) as { path?: string };
    if (!path || !String(path).startsWith("inbox/")) {
      return res.status(400).json({ ok: false, error: "Bad path" });
    }

    // 1) sha 구하기 (삭제하려면 sha 필요)
    const metaUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
    const meta = await ghJson(metaUrl, token);
    const sha = meta?.sha;
    if (!sha) return res.status(404).json({ ok: false, error: "File not found" });

    // 2) 삭제(커밋 생성)
    const delUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    await ghJson(delUrl, token, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Delete inbox item: ${path}`,
        sha,
        branch,
      }),
    });

    return res.status(200).json({ ok: true, path });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
}