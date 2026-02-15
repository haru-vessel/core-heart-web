// core-heart-web/api/pull.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

function cors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function ghGetJson(url: string, token: string) {
  const r = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
    },
  });
  if (!r.ok) throw new Error(`GitHub GET failed: ${r.status}`);
  return r.json();
}

function safeId(s: string) {
  return (s || "unknown").toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 40);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const token = process.env.GITHUB_TOKEN!;
    const owner = process.env.GITHUB_OWNER!;
    const repo = process.env.GITHUB_REPO!;
    const branch = process.env.GITHUB_BRANCH || "main";
    if (!token || !owner || !repo) return res.status(500).json({ ok: false, error: "Missing GitHub env vars" });

    const appId = safeId((req.query.appId as string) || "harurua");

    // 1) inbox/appId 아래에서 날짜 폴더 목록
    const listDatesUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${appId}?ref=${branch}`;
    const dates = await ghGetJson(listDatesUrl, token);

    // 폴더만 뽑아서 최신(이름 기준) 선택
    const dateDirs = (Array.isArray(dates) ? dates : [])
      .filter((x: any) => x.type === "dir")
      .map((x: any) => x.name)
      .sort(); // YYYY-MM-DD라면 정렬 끝이 최신

    if (dateDirs.length === 0) return res.status(200).json({ ok: true, items: [], micro: null });

    const latestDate = dateDirs[dateDirs.length - 1];

    // 2) 날짜 폴더 아래 room 목록 → 일단 가장 첫 room
    const roomsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${appId}/${latestDate}?ref=${branch}`;
    const rooms = await ghGetJson(roomsUrl, token);
    const roomDirs = (Array.isArray(rooms) ? rooms : []).filter((x: any) => x.type === "dir").map((x: any) => x.name).sort();
  if (roomDirs.length === 0) return res.status(200).json({ ok: true, items: [], micro: null });

 const latestRoom = roomDirs[roomDirs.length - 1];

    // 3) room 아래 파일 목록 → 최신 파일 1개
    const filesUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${appId}/${latestDate}/${latestRoom}?ref=${branch}`;
    const files = await ghGetJson(filesUrl, token);

    const fileItems = (Array.isArray(files) ? files : [])
      .filter((x: any) => x.type === "file" && x.name.endsWith(".json"))
      .map((x: any) => ({ name: x.name, download_url: x.download_url }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));

    if (fileItems.length === 0) return res.status(200).json({ ok: true, items: [], micro: null });

    const latest = fileItems[fileItems.length - 1];
    const raw = await fetch(latest.download_url).then(r => r.text());
    const item = JSON.parse(raw);

   return res.status(200).json({ ok: true, items: item ? [item] : [], micro: null });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
}
