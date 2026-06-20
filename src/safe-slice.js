// String#slice() cuts at UTF-16 code-unit boundaries, not full characters --
// if the cut lands between a high and low surrogate (e.g. mid-emoji), it
// leaves an invalid lone surrogate dangling at the end of the string. That's
// invalid Unicode, and can corrupt JSON/UTF-8 serialization in less-robust
// parsers downstream (suspected cause of a recurring "Unterminated string"
// error from one specific upstream LLM provider).
function safeSlice(str, maxLen) {
  if (str.length <= maxLen) return str;
  let end = maxLen;
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // high surrogate -- back up
  return str.slice(0, end);
}

module.exports = { safeSlice };
