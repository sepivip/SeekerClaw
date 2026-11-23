package com.seekerclaw.app.util

import com.seekerclaw.app.bridge.UiForeground

/**
 * BAT-1724: is the agent's `:node` process alive, as MAIN sees it?
 *
 * MAIN shows the agent's status from `service_state`, which only a live `:node` (and MAIN's own
 * Stop) keeps current. A force-stop, a low-memory kill or an app update kills `:node` without any
 * write, so the file can say RUNNING forever. MAIN therefore believes a RUNNING/STARTING only while
 * the `:node` process that wrote it is alive ([effectiveStatus]).
 *
 * Negative evidence is trusted only when it is clearly a full answer: the list must contain MAIN's
 * own entry. A null, empty or partial list, an exception, or no context is [Unknown], and Unknown
 * never downgrades a status (keep-on-doubt). Seeing our own entry is a heuristic — it cannot prove
 * every theoretically partial OS list is detectable.
 */
sealed interface NodeLiveness {
    /** Exactly one `<pkg>:node` entry, with this (positive) pid. */
    data class Alive(val pid: Int) : NodeLiveness

    /** MAIN's own entry is present and there is no `<pkg>:node` entry. */
    object Absent : NodeLiveness

    /** No trustworthy answer: never downgrades a status. */
    object Unknown : NodeLiveness

    companion object {
        /**
         * Reads `ActivityManager.getRunningAppProcesses()` output for [pkg]. Exact process names,
         * positive pids only; list order is irrelevant (the OS does not specify it).
         */
        fun of(procs: List<UiForeground.Proc>?, pkg: String): NodeLiveness {
            if (procs.isNullOrEmpty() || pkg.isEmpty()) return Unknown
            if (procs.none { it.name == pkg }) return Unknown
            val nodeName = "$pkg:node"
            val nodes = procs.filter { it.name == nodeName }
            if (nodes.isEmpty()) return Absent
            val pids = nodes.map { it.pid }.toSet()
            // An entry without a valid pid, or two different pids, is not a clean answer.
            return if (pids.size == 1 && pids.first() > 0) Alive(pids.first()) else Unknown
        }
    }
}

/**
 * BAT-1724: the status MAIN shows for a raw `service_state` status [raw] written by the `:node`
 * process [ownerPid] (null for a file from an older build, which wrote no pid), given [live].
 *
 * - STOPPED and ERROR are shown as written (a real ERROR is kept).
 * - RUNNING / STARTING become STOPPED when no `:node` is alive, or when the live `:node` is a
 *   different process than the one that wrote the status (written by a dead `:node`).
 * - Anything Unknown is shown as written.
 */
internal fun effectiveStatus(raw: ServiceStatus, ownerPid: Int?, live: NodeLiveness): ServiceStatus {
    if (raw != ServiceStatus.RUNNING && raw != ServiceStatus.STARTING) return raw
    return when (live) {
        NodeLiveness.Absent -> ServiceStatus.STOPPED
        is NodeLiveness.Alive -> if (ownerPid != null && ownerPid != live.pid) ServiceStatus.STOPPED else raw
        NodeLiveness.Unknown -> raw
    }
}
