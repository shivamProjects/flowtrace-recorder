/**
 * setup.js — fills the gaps between jsdom and a real browser.
 *
 * jsdom does not implement the CSS object, and both the legacy monolith and the
 * new escape helpers call CSS.escape. Rather than branch the code under test on
 * whether it is running in a test, provide the real thing.
 *
 * This is the CSSOM serialisation algorithm from the spec
 * (https://drafts.csswg.org/cssom/#serialize-an-identifier).
 */
if (typeof globalThis.CSS === 'undefined') globalThis.CSS = {};

if (typeof globalThis.CSS.escape !== 'function') {
  globalThis.CSS.escape = function escape(value) {
    const str = String(value);
    const length = str.length;
    let result = '';
    let index = -1;
    const firstCodeUnit = str.charCodeAt(0);

    while (++index < length) {
      const codeUnit = str.charCodeAt(index);

      // NULL becomes the replacement character rather than terminating.
      if (codeUnit === 0x0000) {
        result += '�';
        continue;
      }

      if (
        // control characters and DEL
        (codeUnit >= 0x0001 && codeUnit <= 0x001f) || codeUnit === 0x007f ||
        // a leading digit
        (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
        // a digit following a leading hyphen
        (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
      ) {
        result += `\\${codeUnit.toString(16)} `;
        continue;
      }

      // a lone leading hyphen
      if (index === 0 && length === 1 && codeUnit === 0x002d) {
        result += `\\${str.charAt(index)}`;
        continue;
      }

      // characters that need no escaping
      if (
        codeUnit >= 0x0080 ||
        codeUnit === 0x002d || codeUnit === 0x005f ||
        (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
        (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
        (codeUnit >= 0x0061 && codeUnit <= 0x007a)
      ) {
        result += str.charAt(index);
        continue;
      }

      result += `\\${str.charAt(index)}`;
    }
    return result;
  };
}
