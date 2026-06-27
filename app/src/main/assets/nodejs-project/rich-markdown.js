// rich-markdown.js — BAT-1050 P1A posture-A sanitizer.
//
// Posture A reproduces the classic pipeline's `html:false` anti-injection wall
// on the Rich Messages path. Agent markdown is sent to InputRichMessage.markdown,
// which Telegram's SERVER parses and which "can contain arbitrary HTML". Model
// output routinely echoes untrusted web_fetch / web_search / MCP / tool content,
// so before it reaches the Rich API this sanitizer:
//   1. protects code spans/fences (restored verbatim — a ```html block must
//      round-trip with its literal <tags>),
//   2. neuters markdown image syntax ![alt](url) -> alt (blocks remote fetch and
//      tg://emoji custom emoji),
//   3. drops link schemes outside a {https, mailto} allowlist (tg://, javascript:,
//      data:, relative, #anchor) -> their visible text,
//   4. escapes raw HTML angle brackets in the remaining prose (escape, never
//      strip: "5 < 10" -> "5 &lt; 10" renders literally; "<details>" -> literal).
//
// It does NOT build rich blocks — HTML-only constructs (<details>, <tg-*>,
// <sub>/<sup>, anchors, pull quotes) become literal text. The owned block
// builder (posture B / P1B) replaces this with allowlisted InputRichMessage.html.
//
// Known P1A limitations (acceptable for the flag-gated probe; tightened in P1B):
//   - link/image URLs may contain balanced single-level parens (e.g.
//     javascript:alert(1) -> still neutered, .../Foo_(disambiguation) -> kept);
//     only deeply NESTED parens still truncate (rare — author with the
//     <angle-bracket> URL form upstream if ever needed);
//   - indented (4-space) code blocks are not protected (fenced + inline only).

'use strict';

const ALLOWED_LINK_SCHEMES = new Set(['https', 'mailto']);

// NUL sentinel delimits stashed code placeholders. NUL cannot appear in normal
// agent text; we also strip any stray NUL from the input first. Built via
// fromCharCode so the source file stays pure ASCII.
const NUL = String.fromCharCode(0);
const RESTORE_RE = new RegExp(NUL + 'C(\\d+)' + NUL, 'g');

function schemeOf(url) {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(String(url).trim());
    return m ? m[1].toLowerCase() : null;
}

// Escape ONLY < and > (not &): this neutralizes every HTML tag (a tag requires
// '<') without rewriting '&' inside allowed-link URLs (which would break query
// strings). '5 < 10' -> '5 &lt; 10', which Telegram renders back to '5 < 10'.
function escapeAngles(s) {
    return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitizeRichMarkdown(input) {
    if (typeof input !== 'string' || input === '') return input;

    // Strip stray NUL so it can't collide with our placeholder sentinels.
    let s = String(input).split(NUL).join('');

    // 1. Stash fenced code blocks, then inline code, so their content is never
    //    escaped/neutered; restored verbatim at the end.
    const stash = [];
    const stashOne = (m) => NUL + 'C' + (stash.push(m) - 1) + NUL;
    s = s.replace(/```[\s\S]*?```/g, stashOne);   // fenced code blocks
    s = s.replace(/`[^`\n]+`/g, stashOne);        // inline code spans

    // 2. Neuter image syntax FIRST (![...]() contains [...]()): drop the URL,
    //    keep the alt text as plain prose — no remote fetch, no custom emoji.
    //    Also consume an optional quoted title/caption (Bot API 10.1 allows
    //    ![alt](url "caption")) so a titled image can't slip past.
    s = s.replace(/!\[([^\]]*)\]\((?:[^()\s]+|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g, '$1');

    // 3. Neuter links whose scheme is outside {https, mailto}: keep the link only
    //    if allowed, otherwise drop it to its visible text. The optional quoted
    //    title (Bot API 10.1: [text](url "title")) is matched but not captured,
    //    so a bad-scheme link with a title can't bypass the allowlist.
    s = s.replace(/\[([^\]]*)\]\(((?:[^()\s]+|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g, (full, text, url) => {
        const scheme = schemeOf(url);
        return scheme && ALLOWED_LINK_SCHEMES.has(scheme) ? full : text;
    });

    // 4. Escape raw HTML angle brackets in the remaining prose.
    s = escapeAngles(s);

    // 5. Restore code verbatim.
    s = s.replace(RESTORE_RE, (m, i) => stash[Number(i)]);

    return s;
}

module.exports = { sanitizeRichMarkdown, ALLOWED_LINK_SCHEMES };
