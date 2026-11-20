// PDF.js targets browsers; Node needs a few small shims for text extraction (no rendering).
if (!Promise.try) Promise.try = function (fn, ...a) { return new Promise(r => r(fn(...a))); };
if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class DOMMatrix {};
if (!Uint8Array.prototype.toHex) Uint8Array.prototype.toHex = function () { return Buffer.from(this).toString('hex'); };
