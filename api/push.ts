// core-heart-web/api/push.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

function cors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function b64(input: string) {
  return Buffer.from(input, "utf8").toString("base64");
}

function isoDateKST(d = new Date()) {
  // 파일 경로 정리용: YYYY-MM-DD
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function safeId(s: string) {
  return (s || "unknown").toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 40);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || "main";

    if (!token || !owner || !repo) {
      return res.status(500).json({ ok: false, error: "Missing GitHub env vars" });
    }

    // 앱에서 보내는 payload는 자유롭게.
    // 최소: appId, roomId, text 정도만 있어도 저장되게 설계.
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const appId = safeId(body.appId || "harurua");
    const roomId = safeId(body.roomId || "talk");
    const now = Date.now();

    // 날짜 폴더로 쌓기 (폴더 폭발 방지)
    const date = isoDateKST();
    const rand = Math.random().toString(16).slice(2, 8);
    const filename = `${now}_${rand}.json`;
    const path = `inbox/${appId}/${date}/${roomId}/${filename}`;

    const payload = {
      savedAt: new Date().toISOString(),
      appId,
      roomId,
      // raw 영역: 그대로 저장
      ...body,
    };

    const putUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

    const ghResp = await fetch(putUrl, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `core-heart: inbox ${appId}/${roomId} ${date}`,
        content: b64(JSON.stringify(payload, null, 2)),
        branch,
      }),
    });

    if (!ghResp.ok) {
      const txt = await ghResp.text();
      return res.status(500).json({ ok: false, error: "GitHub PUT failed", detail: txt.slice(0, 500) });
    }

    return res.status(200).json({ ok: true, path });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
}
