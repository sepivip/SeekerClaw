package com.seekerclaw.app.config

import java.nio.channels.FileChannel
import java.nio.file.Paths
import java.nio.file.StandardOpenOption

/**
 * A second JVM for [ModelSelectionLockTest]: holds an OS lock on the file named in args[0],
 * prints `LOCKED`, and keeps it until stdin reaches EOF. Models `:node` holding the model
 * selection lock while the main process tries to take it.
 */
object LockHolderMain {
    @JvmStatic
    fun main(args: Array<String>) {
        FileChannel.open(Paths.get(args[0]), StandardOpenOption.CREATE, StandardOpenOption.WRITE).use { ch ->
            ch.lock().use {
                println("LOCKED")
                System.out.flush()
                while (System.`in`.read() != -1) Unit
            }
        }
    }
}
