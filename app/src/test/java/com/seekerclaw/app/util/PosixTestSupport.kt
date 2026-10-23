package com.seekerclaw.app.util

import java.nio.file.AccessDeniedException
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions

/** Test-only POSIX permission helpers (Linux CI). Windows has no POSIX view: callers `assumeTrue`. */
internal object PosixTestSupport {

    fun setMode(p: Path, mode: String) {
        Files.setPosixFilePermissions(p, PosixFilePermissions.fromString(mode))
    }

    /**
     * True when this host enforces directory permissions on this process: a POSIX filesystem and
     * a user that is not root (root deletes inside an `r-x` directory anyway). Probed under
     * [scratch], so a container running as root skips the permission cases instead of failing them.
     */
    fun permissionsEnforced(scratch: Path): Boolean {
        if (!FileSystems.getDefault().supportedFileAttributeViews().contains("posix")) return false
        val d = Files.createDirectories(scratch.resolve("perm-probe"))
        val f = Files.write(d.resolve("f"), byteArrayOf(1))
        setMode(d, "r-x------")
        val enforced = try {
            Files.delete(f)
            false
        } catch (_: AccessDeniedException) {
            true
        }
        setMode(d, "rwx------")
        Files.deleteIfExists(f)
        Files.delete(d)
        return enforced
    }
}
