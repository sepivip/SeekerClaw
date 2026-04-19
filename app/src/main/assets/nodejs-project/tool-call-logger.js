// tool-call-logger.js — in-memory buffer for tool_call_log inserts.
// Flushes on 5s interval OR 100-row threshold (whichever first).
// Bypasses the hot path of tool execution; worst case on abrupt kill = 5s of log loss.
// On persistent flush failure, buffer is capped at 10× maxBufferSize; oldest rows
// dropped with WARN log (prevents unbounded growth when db is unusable).

class ToolCallLogger {
    constructor({ db, flushIntervalMs = 5000, maxBufferSize = 100, log = () => {} }) {
        this.db = db;
        this.buffer = [];
        this.flushIntervalMs = flushIntervalMs;
        this.maxBufferSize = maxBufferSize;
        this.MAX_BUFFER_HARD_CAP_MULTIPLIER = 10;
        this.log = log;
        this.flushing = false;
        this.stopped = false;
        this.timer = setInterval(() => { this.flushNow().catch(() => {}); }, flushIntervalMs);
        if (this.timer.unref) this.timer.unref();  // don't block Node exit on this timer
    }

    record(row) {
        if (this.stopped) return;
        this.buffer.push(row);
        const hardCap = this.maxBufferSize * this.MAX_BUFFER_HARD_CAP_MULTIPLIER;
        if (this.buffer.length > hardCap) {
            // Persistent flush failure (e.g. db closed / disk full) will accumulate
            // unboundedly via unshift on the error path. Drop oldest to prevent
            // memory leak. Honest tradeoff: we already accept 5s data loss on abrupt
            // kill; persistent-failure loss is the same tradeoff at a different scale.
            const drop = this.buffer.length - hardCap;
            this.buffer.splice(0, drop);
            this.log(`[ToolCallLogger] buffer hard-cap exceeded; dropped ${drop} oldest rows`, 'WARN');
        }
        if (this.buffer.length >= this.maxBufferSize) {
            // Fire-and-forget; batch flush on next tick.
            setImmediate(() => this.flushNow().catch(() => {}));
        }
    }

    async flushNow() {
        // Join an in-flight flush rather than returning immediately. This matters
        // for shutdown: database.js's gracefulShutdown awaits flushLoggerNow before
        // saveDatabase, and must not return while INSERTs are still in flight.
        while (this._activeFlush) {
            try { await this._activeFlush; } catch (_) {}
        }
        if (this.buffer.length === 0) return;
        const p = this._runFlush();
        this._activeFlush = p;
        try { await p; }
        finally {
            if (this._activeFlush === p) this._activeFlush = null;
        }
    }

    async _runFlush() {
        this.flushing = true;
        if (this.buffer.length === 0) { this.flushing = false; return; }
        const batch = this.buffer.splice(0, this.buffer.length);
        try {
            this.db.run('BEGIN TRANSACTION');
            const stmt = this.db.prepare(`INSERT INTO tool_call_log
                (turn_id, message_id, tool_name, triggered_by_skill, call_shape, result_status, error_kind, latency_ms, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const r of batch) {
                stmt.run([r.turn_id, r.message_id, r.tool_name, r.triggered_by_skill,
                          r.call_shape, r.result_status, r.error_kind, r.latency_ms, r.created_at]);
            }
            stmt.free();
            this.db.run('COMMIT');
            // Re-trigger ONLY on success: if buffer grew past threshold while we
            // were flushing, schedule another pass. On the failure path, we fall
            // through to the catch + finally — no re-trigger, letting the 5s
            // interval (or the next record() call) handle retry. This prevents
            // a CPU spin loop on persistent db failure.
            if (!this.stopped && this.buffer.length >= this.maxBufferSize) {
                setImmediate(() => this.flushNow().catch(() => {}));
            }
        } catch (e) {
            try { this.db.run('ROLLBACK'); } catch (_) {}
            this.log(`[ToolCallLogger] flush failed: ${e.message}`, 'ERROR');
            // Put the batch back at the head so we don't lose it silently
            this.buffer.unshift(...batch);
        } finally {
            this.flushing = false;
        }
    }

    async stop() {
        this.stopped = true;
        clearInterval(this.timer);
        // Final drain. If this throws (db already closed, etc.), swallow — we're
        // shutting down; there's nothing else to do with the rows.
        try { await this.flushNow(); } catch (_) {}
    }
}

module.exports = { ToolCallLogger };
