// Preserve fractional/exponent lexical tokens on signed surfaces. JS otherwise
// turns JSON 1.0 into integer 1 while Python rejects it under the v4 profile.
export class Fraction {
  constructor(value) {
    this.value = value;
  }
}

export function parse(raw, { ordinaryNumbers = false, limit = 65536, fail = () => { throw new SyntaxError("invalid_json"); } } = {}) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > limit)
    fail("invalid_json");
  let i = 0;
  const white = () => {
    while (" \t\r\n".includes(raw[i]) && i < raw.length) i++;
  };
  const str = () => {
    const start = i++;
    while (i < raw.length) {
      const c = raw[i++];
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') {
        let value;
        try {
          value = JSON.parse(raw.slice(start, i));
        } catch {
          fail("invalid_json");
        }
        for (const ch of value) {
          const cp = ch.codePointAt(0);
          if (cp >= 0xd800 && cp <= 0xdfff) fail("invalid_json");
        }
        return value;
      }
    }
    fail("invalid_json");
  };
  function value(depth = 0) {
    if (depth > 24) fail("invalid_json");
    white();
    if (raw[i] === '"') return str();
    if (raw[i] === "{") {
      i++;
      white();
      const out = Object.create(null);
      if (raw[i] === "}") {
        i++;
        return out;
      }
      for (;;) {
        white();
        if (raw[i] !== '"') fail("invalid_json");
        const key = str();
        white();
        if (Object.hasOwn(out, key) || raw[i++] !== ":") fail("invalid_json");
        out[key] = value(depth + 1);
        white();
        if (raw[i] === "}") {
          i++;
          return out;
        }
        if (raw[i++] !== ",") fail("invalid_json");
      }
    }
    if (raw[i] === "[") {
      i++;
      white();
      const out = [];
      if (raw[i] === "]") {
        i++;
        return out;
      }
      for (;;) {
        out.push(value(depth + 1));
        white();
        if (raw[i] === "]") {
          i++;
          return out;
        }
        if (raw[i++] !== ",") fail("invalid_json");
      }
    }
    for (const [text, v] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (raw.startsWith(text, i)) {
        i += text.length;
        return v;
      }
    }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      raw.slice(i),
    );
    if (!token) fail("invalid_json");
    i += token[0].length;
    const n = Number(token[0]);
    if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER)
      fail("invalid_json");
    return /[.eE]/.test(token[0]) && !ordinaryNumbers ? new Fraction(n) : n;
  }
  const out = value();
  white();
  if (i !== raw.length) fail("invalid_json");
  return out;
}

