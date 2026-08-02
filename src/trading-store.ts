import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  decimalAbs,
  decimalAdd,
  decimalCompare,
  decimalDivide,
  decimalMax,
  decimalMultiply,
  decimalSubtract,
} from "./decimal.js";

export interface TradingState {
  currentPosition: "NONE" | "LONG";
  entryOrderId?: string;
  entryPrice?: string;
  quantity?: string;
  ocoOrderListId?: string;
  stopPrice?: string;
  takeProfitPrice?: string;
  initialRiskUsdt?: string;
  entryTime?: number;
  lastExitTime?: number;
  dailyStartEquity?: string;
  dailyRealizedPnl: string;
  consecutiveLosses: number;
  pausedUntil?: number;
  lastCycleId?: string;
}

export interface JournalRecord {
  timestamp?: number;
  cycleId: string;
  strategyId: string;
  action: string;
  symbol: string;
  decision: string;
  reason: string;
  signalValues?: Record<string, string | number | boolean | null>;
  accountEquity?: string;
  quantity?: string;
  entryPrice?: string;
  stopPrice?: string;
  targetPrice?: string;
  orderIds?: Record<string, string | number>;
  fees?: string;
  realizedPnl?: string;
  realizedR?: string;
  error?: string;
}

const DEFAULT_STATE: TradingState = {
  currentPosition: "NONE",
  dailyRealizedPnl: "0",
  consecutiveLosses: 0,
};

export class TradingStore {
  private readonly db: Database.Database;

  constructor(path = "data/trading.db") {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trading_state (
        strategy_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cycle_locks (
        strategy_id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL,
        locked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cycle_history (
        strategy_id TEXT NOT NULL,
        cycle_id TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        PRIMARY KEY (strategy_id, cycle_id)
      );
      CREATE TABLE IF NOT EXISTS client_order_ids (
        client_order_id TEXT PRIMARY KEY,
        strategy_id TEXT,
        cycle_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trading_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strategy_id TEXT NOT NULL,
        cycle_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        action TEXT NOT NULL,
        realized_pnl TEXT,
        realized_r TEXT,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_strategy_time ON trading_journal(strategy_id, timestamp);
    `);
  }

  close(): void { this.db.close(); }

  getState(strategyId: string): TradingState {
    const row = this.db.prepare("SELECT state_json FROM trading_state WHERE strategy_id = ?").get(strategyId) as { state_json?: string } | undefined;
    return row?.state_json ? { ...DEFAULT_STATE, ...JSON.parse(row.state_json) as TradingState } : { ...DEFAULT_STATE };
  }

  updateState(strategyId: string, updates: Partial<TradingState>): TradingState {
    const permitted = new Set<keyof TradingState>([
      "currentPosition", "entryOrderId", "entryPrice", "quantity", "ocoOrderListId", "stopPrice", "takeProfitPrice",
      "initialRiskUsdt", "entryTime", "lastExitTime", "dailyStartEquity", "dailyRealizedPnl", "consecutiveLosses", "pausedUntil", "lastCycleId",
    ]);
    for (const key of Object.keys(updates)) if (!permitted.has(key as keyof TradingState)) throw new Error(`Unsupported trading state field: ${key}.`);
    const transaction = this.db.transaction(() => {
      const next = { ...this.getState(strategyId), ...updates };
      if (next.currentPosition !== "NONE" && next.currentPosition !== "LONG") throw new Error("currentPosition must be NONE or LONG.");
      if (!Number.isInteger(next.consecutiveLosses) || next.consecutiveLosses < 0) throw new Error("consecutiveLosses must be a non-negative integer.");
      this.db.prepare(`INSERT INTO trading_state(strategy_id, state_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(strategy_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
        .run(strategyId, JSON.stringify(next), Date.now());
      return next;
    });
    return transaction();
  }

  beginCycle(strategyId: string, cycleId: string, now = Date.now()): void {
    const transaction = this.db.transaction(() => {
      const history = this.db.prepare("SELECT cycle_id FROM cycle_history WHERE strategy_id = ? AND cycle_id = ?").get(strategyId, cycleId);
      if (history) throw new Error(`Duplicate cycle ID ${cycleId} for strategy ${strategyId}.`);
      const lock = this.db.prepare("SELECT cycle_id, locked_at FROM cycle_locks WHERE strategy_id = ?").get(strategyId) as { cycle_id: string; locked_at: number } | undefined;
      if (lock && now - lock.locked_at >= 20 * 60 * 1000) {
        this.db.prepare("DELETE FROM cycle_locks WHERE strategy_id = ?").run(strategyId);
        this.db.prepare("UPDATE cycle_history SET status = 'STALE', ended_at = ? WHERE strategy_id = ? AND cycle_id = ?").run(now, strategyId, lock.cycle_id);
      } else if (lock) {
        throw new Error(`Trading cycle ${lock.cycle_id} is already active for strategy ${strategyId}.`);
      }
      this.db.prepare("INSERT INTO cycle_locks(strategy_id, cycle_id, locked_at) VALUES (?, ?, ?)").run(strategyId, cycleId, now);
      this.db.prepare("INSERT INTO cycle_history(strategy_id, cycle_id, status, started_at) VALUES (?, ?, 'ACTIVE', ?)").run(strategyId, cycleId, now);
    });
    transaction();
  }

  endCycle(strategyId: string, cycleId: string, status: string, summary: string, now = Date.now()): void {
    const transaction = this.db.transaction(() => {
      const lock = this.db.prepare("SELECT cycle_id FROM cycle_locks WHERE strategy_id = ?").get(strategyId) as { cycle_id: string } | undefined;
      if (!lock || lock.cycle_id !== cycleId) throw new Error(`No active matching cycle ${cycleId} for strategy ${strategyId}.`);
      this.db.prepare("UPDATE cycle_history SET status = ?, summary = ?, ended_at = ? WHERE strategy_id = ? AND cycle_id = ?")
        .run(status, summary, now, strategyId, cycleId);
      this.db.prepare("DELETE FROM cycle_locks WHERE strategy_id = ?").run(strategyId);
    });
    transaction();
  }

  claimClientOrderId(clientOrderId: string, strategyId?: string, cycleId?: string): void {
    try {
      this.db.prepare("INSERT INTO client_order_ids(client_order_id, strategy_id, cycle_id, created_at) VALUES (?, ?, ?, ?)")
        .run(clientOrderId, strategyId ?? null, cycleId ?? null, Date.now());
    } catch {
      throw new Error(`Duplicate client order ID ${clientOrderId}. Reconcile its Binance status before attempting another order.`);
    }
  }

  appendJournal(record: JournalRecord): number {
    const timestamp = record.timestamp ?? Date.now();
    const result = this.db.prepare(`INSERT INTO trading_journal(strategy_id, cycle_id, timestamp, action, realized_pnl, realized_r, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      record.strategyId, record.cycleId, timestamp, record.action,
      record.realizedPnl ?? null, record.realizedR ?? null, JSON.stringify({ ...record, timestamp }),
    );
    return Number(result.lastInsertRowid);
  }

  recentJournal(strategyId: string, limit = 50): JournalRecord[] {
    return (this.db.prepare("SELECT record_json FROM trading_journal WHERE strategy_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?").all(strategyId, limit) as { record_json: string }[])
      .map((row) => JSON.parse(row.record_json) as JournalRecord);
  }

  performanceSummary(strategyId: string, startTime?: number, endTime?: number) {
    const rows = this.db.prepare(`SELECT action, realized_pnl, realized_r, timestamp FROM trading_journal
      WHERE strategy_id = ? AND (? IS NULL OR timestamp >= ?) AND (? IS NULL OR timestamp <= ?) ORDER BY timestamp, id`)
      .all(strategyId, startTime ?? null, startTime ?? null, endTime ?? null, endTime ?? null) as { action: string; realized_pnl: string | null; realized_r: string | null }[];
    const completed = rows.filter((row) => row.realized_pnl !== null);
    const profits = completed.map((row) => row.realized_pnl!).filter((pnl) => decimalCompare(pnl, "0") > 0);
    const losses = completed.map((row) => row.realized_pnl!).filter((pnl) => decimalCompare(pnl, "0") < 0);
    const sum = (values: string[]) => values.reduce((total, value) => decimalAdd(total, value), "0");
    const grossProfit = sum(profits);
    const grossLoss = decimalAbs(sum(losses));
    const net = sum(completed.map((row) => row.realized_pnl!));
    let equity = "0";
    let peak = "0";
    let maxDrawdown = "0";
    let currentLosses = 0;
    let maxLosses = 0;
    for (const row of completed) {
      const pnl = row.realized_pnl!;
      equity = decimalAdd(equity, pnl);
      peak = decimalMax(peak, equity);
      const drawdown = decimalSubtract(peak, equity);
      if (decimalCompare(drawdown, maxDrawdown) > 0) maxDrawdown = drawdown;
      if (decimalCompare(pnl, "0") < 0) { currentLosses += 1; maxLosses = Math.max(maxLosses, currentLosses); } else currentLosses = 0;
    }
    const realizedRs = completed.flatMap((row) => row.realized_r ? [row.realized_r] : []);
    return {
      completedTrades: completed.length,
      winningTrades: profits.length,
      losingTrades: losses.length,
      winRate: completed.length ? decimalMultiply(String(profits.length), decimalDivide("100", String(completed.length))) : "0",
      grossProfit,
      grossLoss,
      netRealizedPnl: net,
      profitFactor: decimalCompare(grossLoss, "0") === 0 ? null : decimalDivide(grossProfit, grossLoss),
      averageR: realizedRs.length ? decimalDivide(sum(realizedRs), String(realizedRs.length)) : "0",
      maximumRealizedDrawdown: maxDrawdown,
      consecutiveLosses: currentLosses,
      maximumConsecutiveLosses: maxLosses,
      rejectedOrderCount: rows.filter((row) => row.action === "ORDER_REJECTED").length,
      emergencyExitCount: rows.filter((row) => row.action === "EMERGENCY_EXIT").length,
    };
  }
}
