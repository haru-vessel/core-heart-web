// core-heart-web/api/review-list.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

function cors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
}

async function ghGetJson(url: string, token: string) {
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!r.ok) throw new Error(`GitHub GET failed: ${r.status}`);
  return r.json();
}

function safeId(s: string) {
  return (s || "unknown").toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 40);
}

function requireAdmin(req: VercelRequest, res: VercelResponse): boolean {
  const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();
  // ✅ ADMIN_KEY가 비어있으면 잠금 해제(원하면 false로 바꿔서 강제 잠금 가능)
  if (!ADMIN_KEY) return true;

  const incoming = String(req.headers["x-admin-key"] || "").trim();
  if (!incoming || incoming !== ADMIN_KEY) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

/**
 * GET /api/review-list?appId=sallangi&roomPrefix=story-&limit=200
 *
 * - appId: 기본 sallangi (추후 ttasseumi도 가능)
 * - roomPrefix: 기본 story-
 * - limit: 최대 200
 *
 * ✅ 큰 파일(사진 포함)을 고려해서 "내용(content)"은 읽지 않고
 * GitHub contents 목록에서 내려주는 size/path/download_url만으로 목록을 만든다.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  // ✅ 관리자 키 없으면 목록도 못 봄
  if (!requireAdmin(req, res)) return;

  try {
    const token = process.env.GITHUB_TOKEN!;
    const owner = process.env.GITHUB_OWNER!;
    const repo = process.env.GITHUB_REPO!;
    const branch = process.env.GITHUB_BRANCH || "main";
    if (!token || !owner || !repo) {
      return res.status(500).json({ ok: false, error: "Missing GitHub env vars" });
    }

    const appId = safeId(String(req.query.appId || "sallangi"));
    const roomPrefix = String(req.query.roomPrefix || "story-").trim();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 100)));

    // 허용 앱 고정(원하면 늘리자)
    const ALLOWED_APP_IDS = new Set(["harurua", "sallangi", "ttasseumi"]);
    const fixedAppId = ALLOWED_APP_IDS.has(appId) ? appId : "sallangi";

    // 1) 날짜 폴더 목록
    const listDatesUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${fixedAppId}?ref=${branch}`;
    const dates = await ghGetJson(listDatesUrl, token);

    const dateDirs = (Array.isArray(dates) ? dates : [])
      .filter((x: any) => x.type === "dir")
      .map((x: any) => x.name)
      .sort(); // YYYY-MM-DD면 sort 끝이 최신

    const items: any[] = [];

    // 최신 날짜부터 훑기
    for (let di = dateDirs.length - 1; di >= 0; di--) {
      const date = dateDirs[di];

      // 2) 날짜 아래 room 목록
      const roomsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${fixedAppId}/${date}?ref=${branch}`;
      let rooms: any[] = [];
      try {
        rooms = await ghGetJson(roomsUrl, token);
      } catch {
        continue;
      }

      const roomDirs = (Array.isArray(rooms) ? rooms : [])
        .filter((x: any) => x.type === "dir")
        .map((x: any) => x.name)
        .filter((name: string) => name.startsWith(roomPrefix))
        .sort();

      // room도 최신 느낌으로 뒤에서부터
      for (let ri = roomDirs.length - 1; ri >= 0; ri--) {
        const room = roomDirs[ri];

        // 3) room 아래 파일 목록
        const filesUrl = `https://api.github.com/repos/${owner}/${repo}/contents/inbox/${fixedAppId}/${date}/${room}?ref=${branch}`;
        let files: any[] = [];
        try {
          files = await ghGetJson(filesUrl, token);
        } catch {
          continue;
        }

        // JSON만(필요하면 jpg/png도 포함시키는 옵션도 나중에 가능)
        const jsonFiles = (Array.isArray(files) ? files : [])
          .filter((x: any) => x.type === "file" && typeof x.name === "string" && x.name.endsWith(".json"))
          .map((x: any) => ({
            name: x.name,
            size: Number(x.size || 0),
            download_url: x.download_url,
          }))
          .sort((a: any, b: any) => a.name.localeCompare(b.name));

        // 최신 파일부터 items에 push
        for (let fi = jsonFiles.length - 1; fi >= 0; fi--) {
          const f = jsonFiles[fi];
          const path = `inbox/${fixedAppId}/${date}/${room}/${f.name}`;

          items.push({
            appId: fixedAppId,
            date,
            room,
            name: f.name,
            size: f.size,
            path, // ✅ 삭제에 필요
            url: f.download_url,
          });

          if (items.length >= limit) break;
        }

        if (items.length >= limit) break;
      }

      if (items.length >= limit) break;
    }

    return res.status(200).json({
      ok: true,
      appId: fixedAppId,
      roomPrefix,
      updatedAt: new Date().toISOString(),
      items,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
}