// Spoken output via the browser's built-in speech synthesiser.
//
// The dominant failure mode in a live call is not bad audio, it is *backlog*.
// If the speaker talks faster than synthesis can keep up, a naive queue drifts
// further and further behind until the translation is answering a question
// from thirty seconds ago. So the queue here is deliberately shallow: past a
// couple of pending utterances we drop the oldest, on the principle that being
// current matters more than being complete.

import { speechTag } from './languages.js';

const MAX_PENDING = 2;

let enabled = true;
let rate = 1.05;
let voices = [];
const queue = [];
let speaking = false;

function loadVoices() {
  voices = window.speechSynthesis?.getVoices() ?? [];
}

if (typeof window !== 'undefined' && window.speechSynthesis) {
  loadVoices();
  // Chrome populates the voice list asynchronously after page load.
  window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
}

export const isSupported = () =>
  typeof window !== 'undefined' && 'speechSynthesis' in window;

export const setEnabled = (value) => {
  enabled = value;
  if (!value) stop();
};

export const setRate = (value) => {
  rate = Math.min(2, Math.max(0.5, Number(value) || 1));
};

export const getRate = () => rate;

/** Best available voice for a language, preferring a local (offline) one. */
function pickVoice(mt) {
  if (!voices.length) loadVoices();
  const tag = speechTag(mt).toLowerCase();
  const base = mt.toLowerCase();

  const candidates = voices.filter((v) => {
    const lang = (v.lang || '').toLowerCase().replace('_', '-');
    return lang === tag || lang.split('-')[0] === base;
  });
  if (!candidates.length) return null;

  // Exact region match beats a base-language match; local beats network.
  const score = (v) => {
    const lang = (v.lang || '').toLowerCase().replace('_', '-');
    return (lang === tag ? 2 : 0) + (v.localService ? 1 : 0);
  };
  return candidates.sort((a, b) => score(b) - score(a))[0];
}

/** True when the browser ships no voice at all for this language. */
export const hasVoiceFor = (mt) => Boolean(pickVoice(mt));

function drain() {
  if (speaking || !queue.length || !enabled) return;

  const item = queue.shift();
  const utter = new SpeechSynthesisUtterance(item.text);
  const voice = pickVoice(item.lang);
  if (voice) utter.voice = voice;
  utter.lang = speechTag(item.lang);
  utter.rate = rate;

  speaking = true;
  const done = () => {
    speaking = false;
    drain();
  };
  utter.onend = done;
  utter.onerror = done;

  try {
    window.speechSynthesis.speak(utter);
  } catch {
    done();
  }
}

/** Queue an utterance, discarding stale backlog to stay near real time. */
export function speak(text, lang) {
  if (!enabled || !isSupported()) return;
  const trimmed = (text || '').trim();
  if (!trimmed) return;

  queue.push({ text: trimmed, lang });
  while (queue.length > MAX_PENDING) queue.shift();
  drain();
}

/** Cut off current speech and clear the backlog. */
export function stop() {
  queue.length = 0;
  speaking = false;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* nothing useful to do */
  }
}
