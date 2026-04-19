// tool-call-logger.js — in-memory buffer for tool_call_log inserts.
// Flushes on 5s interval OR 100-row threshold (whichever first).
// Bypasses the hot path of tool execution; worst case on abrupt kill = 5s of log loss.

class ToolCallLogger {
    constructor({ db, flushIntervalMs = 5000, maxBufferSize = 100, log = () => {} }) {
        this.db = db;
        this.buffer = [];
        this.flushIntervalMs = flushIntervalMs;
        this.maxBufferSize = maxBufferSize;
        this.log = log;
        this.flushing = false;
        this.stopped = false;
        this.timer = setInterval(() => { this.flushNow().catch(() => {}); }, flushIntervalMs);
        if (this.timer.unref) this.timer.unref();  // don't block Node exit on this timer
    }

    record(row) {
        if (this.stopped) return;
        this.buffer.push(row);
        if (this.buffer.length >= this.maxBufferSize) {
            // Fire-and-forget; batch flush on next tick.
            setImmediate(() => this.flushNow().catch(() => {}));
        }
    }

    async flushNow() {
        if (this.flushing) return;
        if (this.buffer.length === 0) return;
        this.flushing = true;
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
        } catch (e) {
            try { this.db.run('ROLLBACK'); } catch (_) {}
            this.log(`[ToolCallLogger] flush failed: ${e.message}`, 'ERROR');
            // Put the batch back at the head so we don't lose it silently
            this.buffer.unshift(...batch);
        } finally {
            this.flushing = false;
        }
    }

    stop() {
        this.stopped = true;
        clearInterval(this.timer);
    }
}

module.exports = { ToolCallLogger };
