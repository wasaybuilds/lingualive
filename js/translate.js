// Translation with graceful degradation.
//
// Three backends, tried in order of speed:
//
//   1. Chrome's built-in Translator API. Runs fully on-device, costs nothing,
//      works offline once the language pack is downloaded, and is by far the
//      fastest option (~50-150ms). Chrome 138+ only.
//   2. A self-hosted LibreTranslate instance, if the user configured one.
//      Also free, also private, but adds a network hop.
//   3. MyMemory's public endpoint. Keyless and CORS-friendly, but rate-limited
//      and it sees your text, so it is strictly a last resort.
//
// Whichever backend answers first for a given language pair gets remembered,
// so we only pay the probing cost once.

const LOCAL_CACHE_LIMIT = 400;

const translators = new Map(); // "src>tgt" -> Promise<Translator>
const memo = new Map(); // "src>tgt|text" -> translated string
let libreEndpoint = '';

export const setLibreEndpoint = (url) => {
  libreEndpoint = (url || '').trim().replace(/\/+$/, '');
};

export const hasBuiltIn = () => typeof self !== 'undefined' && 'Translator' in self;

/**
 * Report whether the on-device model for a pair is ready, needs downloading,
 * or is simply not offered. Used to warn before a call rather than during one.
 * @returns {Promise<'available'|'downloadable'|'downloading'|'unavailable'>}
 */
export async function builtInAvailability(source, target) {
  if (!hasBuiltIn() || source === target) return 'unavailable';
  try {
    return await self.Translator.availability({
      sourceLanguage: source,
      targetLanguage: target,
    });
  } catch {
    return 'unavailable';
  }
}

/**
 * Warm up an on-device translator, downloading the language pack if needed.
 * Doing this before the call starts keeps the first sentence from stalling.
 * @param {(ratio:number)=>void} [onProgress] 0..1 download progress
 */
export async function prepare(source, target, onProgress) {
  if (!hasBuiltIn() || source === target) return false;
  const key = `${source}>${target}`;

  if (!translators.has(key)) {
    const created = self.Translator.create({
      sourceLanguage: source,
      targetLanguage: target,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          if (onProgress) onProgress(e.loaded ?? 0);
        });
      },
    }).catch((err) => {
      // Remove the rejected promise so a later attempt can retry cleanly.
      translators.delete(key);
      throw err;
    });
    translators.set(key, created);
  }

  try {
    await translators.get(key);
    return true;
  } catch {
    return false;
  }
}

async function viaBuiltIn(text, source, target) {
  const key = `${source}>${target}`;
  if (!translators.has(key)) {
    const ok = await prepare(source, target);
    if (!ok) return null;
  }
  try {
    const translator = await translators.get(key);
    return await translator.translate(text);
  } catch {
    return null;
  }
}

async function viaLibre(text, source, target) {
  if (!libreEndpoint) return null;
  try {
    const res = await fetch(`${libreEndpoint}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source, target, format: 'text' }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.translatedText || null;
  } catch {
    return null;
  }
}

async function viaMyMemory(text, source, target) {
  try {
    const url =
      'https://api.mymemory.translated.net/get' +
      `?q=${encodeURIComponent(text)}&langpair=${source}|${target}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const out = data?.responseData?.translatedText;
    // MyMemory signals quota exhaustion in the body with a 200 status.
    if (!out || /MYMEMORY WARNING/i.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}

/**
 * Translate a single utterance.
 * @returns {Promise<{text:string, engine:string}>}
 */
export async function translate(text, source, target) {
  const trimmed = (text || '').trim();
  if (!trimmed) return { text: '', engine: 'none' };
  if (source === target) return { text: trimmed, engine: 'passthrough' };

  const memoKey = `${source}>${target}|${trimmed}`;
  if (memo.has(memoKey)) return { text: memo.get(memoKey), engine: 'cache' };

  const attempts = [
    ['on-device', viaBuiltIn],
    ['libretranslate', viaLibre],
    ['mymemory', viaMyMemory],
  ];

  for (const [engine, fn] of attempts) {
    const out = await fn(trimmed, source, target);
    if (out) {
      if (memo.size > LOCAL_CACHE_LIMIT) memo.clear();
      memo.set(memoKey, out);
      return { text: out, engine };
    }
  }

  // Nothing worked. Show the original rather than dropping the message —
  // a listener seeing untranslated text is better served than seeing silence.
  return { text: trimmed, engine: 'failed' };
}
