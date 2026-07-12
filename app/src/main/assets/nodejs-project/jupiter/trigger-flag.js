'use strict';

// BAT-1148 (delivers BAT-1091): resolve the Jupiter Trigger V2 feature flag.
//
// V2 is the DEFAULT order path; V1 stays in the tree as a kill-switch fallback
// (removal tracked in BAT-1146). Kept as a pure, side-effect-free module so the
// precedence rules can be unit-tested in isolation — config.js itself is not
// cleanly requireable in a test (heavy load-time side effects).
//
// Precedence: env > config > default(ON). The env override wins so support can
// force every install back to V1 without a rebuild (env is plumbed Kotlin →
// Node → process.env via Settings → Env Vars).

// Tri-state boolean normalizer. Distinguishes an explicit true/false from an
// "unspecified" value (undefined), so a default-ON flag is never silently
// forced off by a plain truthy coerce (which would turn the string "false" and
// an unset value into the same `false`). Case-insensitive; trims whitespace.
function triBool(v) {
    if (v === true || v === false) return v;
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'true' || s === '1') return true;
        if (s === 'false' || s === '0') return false;
    }
    return undefined; // unspecified → caller's default applies
}

// Resolve the effective flag. `envValue` is the raw process.env string (or
// undefined); `configValue` is whatever the loaded config carried (bool,
// string, or undefined). Returns a strict boolean so handlers branch on
// `=== true` without truthy-coercing.
function resolveUseTriggerV2({ configValue, envValue } = {}) {
    return triBool(envValue) ?? triBool(configValue) ?? true;
}

module.exports = { triBool, resolveUseTriggerV2 };
