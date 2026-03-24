// core-heart-web/api/push.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

function cors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function safeId(s: string) {
  return (s || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .slice(0, 80);
}

async function ghPutJson(args: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  path: string;
  contentJson: any;
  message: string;
}) {
  const { owner, repo, branch, token, path, contentJson, message } = args;

  const content = Buffer.from(
    JSON.stringify(contentJson, null, 2),
    "utf8"
  ).toString("base64");

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content,
      branch,
    }),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(
      `GitHub PUT failed: ${res.status} ${JSON.stringify(data)}`
    );
  }

  return data;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const token = process.env.GITHUB_TOKEN!;
    const owner = process.env.GITHUB_OWNER!;
    const repo = process.env.GITHUB_REPO!;
    const branch = process.env.GITHUB_BRANCH || "main";

    if (!token || !owner || !repo) {
      return res.status(500).json({
        ok: false,
        error: "Missing GitHub env vars",
      });
    }

    const body = req.body ?? {};

    // ✅ 앱에서 최상위로 보낼 수도 있고 meta 안에 넣을 수도 있음
    const incomingAppId = String(body?.appId || body?.meta?.appId || "unknown");
    const incomingRoomId = String(
      body?.roomId || body?.meta?.roomId || "unknown"
    );
    const incomingReason = String(
      body?.reason || body?.meta?.reason || ""
    );

    const ALLOWED_APP_IDS = new Set(["harurua", "sallangi", "ttasseumi"]);
    const fixedAppId = ALLOWED_APP_IDS.has(safeId(incomingAppId))
      ? safeId(incomingAppId)
      : "harurua";

    let roomId = safeId(incomingRoomId || "unknown");

    // ✅ text는 최상위 우선, 없으면 meta 쪽 fallback
    const text = String(body?.text || body?.meta?.text || "").trim();

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "Missing text",
      });
    }

    // ✅ payload 크기 너무 크면 제한
    const rawBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    if (rawBytes > 200_000) {
      return res.status(413).json({
        ok: false,
        error: "Payload too large",
      });
    }

    // ✅ 디버깅 로그
    console.log("[push] incoming", {
      incomingAppId,
      incomingRoomId,
      incomingReason,
      fixedAppId,
      textPreview: text.slice(0, 80),
    });

    // ----------------------------------------------------
    // sallangi 제한 규칙
    // ----------------------------------------------------
    if (fixedAppId === "sallangi") {
  const allowedExactRooms = new Set([
  "talk",
  "match-queue",
]);

const allowedReasons = new Set([
  "stuck",
  "repeat3",
  "overheat",
  "seed_stuck",
  "join_match",
  "leave_match",
  "match_message",
]);

function isAllowedRoom(roomId: string) {
  if (allowedExactRooms.has(roomId)) return true;
  if (roomId.startsWith("match-")) return true;
  return false;
}

if (!isAllowedRoom(roomId)) {
  return res.status(400).json({
    ok: false,
    reason: "room not allowed",
  });
}

      if (!allowedReasons.has(incomingReason)) {
        console.log("[push] sallangi reason blocked", { incomingReason });
        return res.status(200).json({
          ok: true,
          skipped: true,
          reason: "talk-reason-not-allowed",
        });
      }
    }

    // ----------------------------------------------------
    // harurua 제한 규칙 (필요시 완화/확장 가능)
    // ----------------------------------------------------
    if (fixedAppId === "harurua") {
      // 방이 비정상이면 talk로 정리
      if (!roomId || roomId === "unknown") {
        roomId = "talk";
      }
    }

    // ----------------------------------------------------
    // 저장 경로
    // inbox/{appId}/{date}/{roomId}/{messageId}.json
    // ----------------------------------------------------
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const date = `${yyyy}-${mm}-${dd}`;

    const messageId = safeId(
      String(body?.messageId || body?.meta?.messageId || `msg-${Date.now()}`)
    );

    const savePath = `inbox/${fixedAppId}/${date}/${roomId}/${messageId}.json`;

    const payload = {
      ...body,

      originalAppId: body?.appId,
      originalRoomId: body?.roomId,
      originalReason: body?.reason,

      fixedAppId,
      roomId,
      reason: incomingReason || null,
      text,

      savedAt: new Date().toISOString(),
    };

    console.log("[core-heart push] url =", `https://api.github.com/repos/${owner}/${repo}/contents/${savePath}`);
    console.log("[core-heart push] payload =", {
      appId: fixedAppId,
      roomId,
      reason: incomingReason,
      text: text.slice(0, 120),
    });

    const putRes = await ghPutJson({
      owner,
      repo,
      branch,
      token,
      path: savePath,
      contentJson: payload,
      message: `save breath log: ${fixedAppId}/${roomId}/${messageId}`,
    });

    return res.status(200).json({
      ok: true,
      saved: true,
      path: savePath,
      sha: putRes?.content?.sha || null,
    });
  } catch (e: any) {
    console.log("[core-heart push] error =", e?.message || e);

    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
    });
  }
}