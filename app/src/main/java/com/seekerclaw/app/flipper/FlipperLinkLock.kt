package com.seekerclaw.app.flipper

import kotlinx.coroutines.sync.Mutex

/**
 * Guards the single GATT link to the enrolled Flipper.
 *
 * The firmware holds exactly one pending-command slot, so two concurrent RPC sequences corrupt
 * each other's correlation. Both callers must take this: the Settings enrollment scan and the
 * bridge press path.
 *
 * ### It does not span processes, and cannot
 *
 * Settings runs in the main process and the bridge in `:node`, so this `Mutex` only serialises
 * callers within one of them. That is not a gap this lock can close — a cross-process lock would
 * not help either, because **Android only permits one `BluetoothGatt` connection to a device per
 * process**, and the two processes would be contending for the peripheral itself rather than for
 * a shared handle.
 *
 * What actually prevents the collision is that enrollment is a foreground, user-driven action:
 * the user is holding the phone with Settings open, not simultaneously messaging the agent from
 * another device. If that assumption ever stops holding, the fix is a bridge-side "enrollment in
 * progress" flag in the enrollment store — which *is* cross-process — not a bigger lock.
 */
internal object FlipperLinkLock {
    val mutex = Mutex()
}
