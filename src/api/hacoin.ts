import type { Request, Response } from "express";
import fs from "fs";
import path from "path";

const CORE = process.env.CORE_HEART_DIR || process.cwd();
const LEDGER_PATH = path.join(CORE, "public", "ha-coin.json");


type HaCoinEvent = {
  id: string;
  at: string; // ISO
  type: "promote" | "penalty";
  delta: number; // + / -
  reason?: string;
  userId?: string;
  messageId?: string;
  inhaleId?: string;
  summary?: string;
};

type Ledger = { version: string; events: HaCoinEvent[] };

function safeReadLedger(): Ledger {
  try {
    const raw = fs.readFileSync(LEDGER_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.events)) return parsed as Ledger;
  } catch {}
  return { version: "hacoin-ledger-v1", events: [] };
}

function writeLedger(next: Ledger) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(next, null, 2), "utf-8");
}

function uid() {
  return "evt_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

export function getLedger(req: Request, res: Response) {
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 200), 2000));
  const ledger = safeReadLedger();
  const events = ledger.events.slice(-limit);
  res.json({ ...ledger, events });
}

export function postEvent(req: Request, res: Response) {
  const body = req.body || {};
  const delta = Number(body.delta ?? 0);

  if (!Number.isFinite(delta) || delta === 0) {
    return res.status(400).json({ ok: false, error: "delta must be non-zero number" });
  }

  const evt: HaCoinEvent = {
    id: uid(),
    at: new Date().toISOString(),
    type: delta > 0 ? "promote" : "penalty",
    delta,
    reason: String(body.reason ?? ""),
    userId: String(body.userId ?? ""),
    messageId: String(body.messageId ?? ""),
    inhaleId: String(body.inhaleId ?? ""),
    summary: String(body.summary ?? ""),
  };

  const ledger = safeReadLedger();
  ledger.events.push(evt);

  // 너무 커지면 오래된 것부터 자르기(예: 10,000개)
  if (ledger.events.length > 10000) {
    ledger.events = ledger.events.slice(-10000);
  }

  writeLedger(ledger);
  res.json({ ok: true, event: evt });
}
