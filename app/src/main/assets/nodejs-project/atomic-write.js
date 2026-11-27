// atomic-write.js — BAT-1734. Replace a file's contents all-or-nothing.
//
// fs.writeFileSync(path) truncates the file first and then writes, so a full disk (ENOSPC) or a
// crash part-way through leaves the file short or empty. For MEMORY.md that is the agent's
// long-term memory gone. writeFileAtomicSync writes the new contents to a temp file next to the
// target, flushes it to disk, and renames it over the target. A rename within one directory is
// atomic on the filesystems Android uses (ext4, F2FS): readers see the old file or the new one,
// never a mix. On any failure the temp file is removed, the target is left exactly as it was, and
// the original error is rethrown so callers still report it.
//
// The temp file is opened with 'wx' (O_CREAT | O_EXCL) under a random name. O_EXCL refuses ANY
// existing entry, a symlink included, and never follows it, so a link planted at a temp name
// cannot redirect the write outside the workspace.
//
// Pure: fs, path and crypto only. Nothing runs at load.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Temp names: "<base>.<pid>.<8 hex>.tmp" in the target's own directory, so the rename never
// crosses a filesystem. The ".tmp" suffix keeps them out of every ".md" scan (memory indexer,
// daily-file listings).
function tempPathFor(filePath) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    return path.join(dir, `${base}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
}

/**
 * Write `data` to `filePath` atomically.
 * @param {string} filePath  target path; its directory must already exist
 * @param {string|Buffer} data
 * @param {string} [encoding='utf8']  used when `data` is a string
 * @throws the underlying fs error (ENOSPC, EACCES, EISDIR...) after cleaning up the temp file
 */
function writeFileAtomicSync(filePath, data, encoding = 'utf8') {
    const tmpPath = tempPathFor(filePath);
    let fd = null;
    let created = false;
    try {
        fd = fs.openSync(tmpPath, 'wx');
        created = true;
        fs.writeFileSync(fd, data, encoding);
        fs.fsyncSync(fd);
        // Clear the handle BEFORE closing: a close that throws has still released the fd, and
        // closing it again in the catch could close an fd number that was reused meanwhile.
        const f = fd;
        fd = null;
        fs.closeSync(f);
        fs.renameSync(tmpPath, filePath);
    } catch (e) {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (_) {}
        }
        // Only remove what this call created: if the 'wx' open failed (EEXIST), the entry at the
        // temp name is not ours.
        if (created) {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
        }
        throw e;
    }
}

module.exports = { writeFileAtomicSync, _tempPathFor: tempPathFor };
