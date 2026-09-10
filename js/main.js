// Application controller: wires the setup form, the call surface, and the
// four subsystems (recognition, translation, synthesis, transport) together.
//
// The data flow is deliberately one-directional and text-only:
//
//   my mic ─▶ recognition ─▶ broadcast {text, lang} ─▶ each peer
//                                                        │
//                       my ear ◀─ synthesis ◀─ translate ┘
//
// Nothing but plain text crosses the data channel. Each listener translates
// into whatever language *they* chose, which is what keeps the cost at zero
// regardless of how many people are in the room, and what lets two people
// disagree about the meeting language without anyone having to compromise.

import { LANGUAGES, byMt, speechTag, isRTL, displayName } from './languages.js';
import { Listener, isSupported as sttSupported } from './speech.js';
import * as tts from './tts.js';
import * as mt from './translate.js';
import { Room, randomCode, normaliseCode } from './rtc.js';

const PREFS_KEY = 'lingualive:prefs';
const INTERIM_THROTTLE_MS = 400;
const MAX_FEED_ITEMS = 120;

const $ = (id) => document.getElementById(id);

const el = {
  status: $('status'),
  setup: $('setup'),
  call: $('call'),
  form: $('join-form'),
  name: $('name'),
  room: $('room'),
  newRoom: $('new-room'),
  speakLang: $('speak-lang'),
  hearLang: $('hear-lang'),
  hearLangLive: $('hear-lang-live'),
  libreUrl: $('libre-url'),
  preflight: $('preflight'),
  join: $('join'),
  roomCode: $('room-code'),
  copyLink: $('copy-link'),
  leave: $('leave'),
  participants: $('participants'),
  feed: $('feed'),
  feedEmpty: $('feed-empty'),
  liveRow: $('live-row'),
  liveText: $('live-text'),
  mute: $('mute'),
  muteLabel: $('mute-label'),
  ttsToggle: $('tts-toggle'),
  ttsLabel: $('tts-label'),
  rate: $('rate'),
  duck: $('duck'),
  sinks: $('audio-sinks'),
};

const state = {
  room: null,
  listener: null,
  localStream: null,
  speakLang: 'en',
  hearLang: 'ur',
  displayName: 'Guest',
  hearTouched: false,
  muted: false,
  duck: 0.15,
  /** @type {Map<string, HTMLAudioElement>} */
  sinks: new Map(),
  /** @type {Map<string, string>} */
  names: new Map(),
  seen: new Set(),
  lastInterimSent: 0,
  liveTimer: null,
};

/* ── Status ──────────────────────────────────────────── */

function setStatus(text, tone = '') {
  el.status.textContent = text;
  if (tone) el.status.dataset.tone = tone;
  else delete el.status.dataset.tone;
}

/* ── Preferences ─────────────────────────────────────── */

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        name: el.name.value.trim(),
        speak: el.speakLang.value,
        hear: el.hearLang.value,
        libre: el.libreUrl.value.trim(),
        rate: el.rate.value,
        duck: el.duck.value,
      }),
    );
  } catch {
    /* private browsing; preferences simply will not persist */
  }
}

/* ── Setup screen ────────────────────────────────────── */

function fillLanguageSelects() {
  const options = LANGUAGES.map(
    (l) => `<option value="${l.mt}">${displayName(l.mt)}</option>`,
  ).join('');
  el.speakLang.innerHTML = options;
  el.hearLang.innerHTML = options;
  el.hearLangLive.innerHTML = options;
}

function check(tone, text) {
  const div = document.createElement('div');
  div.className = 'check';
  div.dataset.tone = tone;
  div.innerHTML = '<span class="dot"></span><span></span>';
  div.lastElementChild.textContent = text;
  return div;
}

/**
 * Tell the user what will and will not work *before* they join, rather than
 * letting them discover it mid-conversation.
 */
async function runPreflight() {
  const speak = el.speakLang.value;
  const hear = el.hearLang.value;
  const checks = [];

  if (!sttSupported()) {
    checks.push(
      check(
        'bad',
        'This browser cannot do speech recognition. Use Chrome or Edge — ' +
          'you can still join and read others, but nothing you say will be sent.',
      ),
    );
  } else {
    checks.push(check('good', `Recognising your speech as ${byMt(speak).name}.`));
  }

  // The pair that actually matters is (whatever the other person speaks) →
  // (your language), and that is unknowable until someone joins. So probe a
  // representative pair here just to establish that the engine works at all,
  // and check the real pair once a peer arrives.
  if (mt.hasBuiltIn()) {
    const probe = speak === hear ? (hear === 'en' ? 'es' : 'en') : speak;
    const availability = await mt.builtInAvailability(probe, hear);
    if (availability === 'available' || availability === 'downloading') {
      checks.push(check('good', 'On-device translation ready — fastest and fully private.'));
    } else if (availability === 'downloadable') {
      checks.push(
        check('warn', 'On-device language packs download on first use (one time, ~30s each).'),
      );
    } else {
      checks.push(
        check(
          'warn',
          `Chrome offers no on-device model into ${byMt(hear).name}. Falling back to a ` +
            'public translation service, which is slower and rate-limited.',
        ),
      );
    }
  } else {
    checks.push(
      check(
        'warn',
        'No built-in translator in this browser (needs Chrome 138+). Using a public ' +
          'fallback service — works, but slower and rate-limited.',
      ),
    );
  }

  if (!tts.isSupported()) {
    checks.push(check('bad', 'No speech synthesis here; you will get captions only.'));
  } else if (!tts.hasVoiceFor(hear)) {
    checks.push(
      check(
        'warn',
        `Your system has no ${byMt(hear).name} voice installed, so that language will ` +
          'be shown as captions but not spoken. Add it in Windows Settings → ' +
          'Time & language → Speech.',
      ),
    );
  } else {
    checks.push(check('good', `Will speak to you in ${byMt(hear).name}.`));
  }

  if (!window.isSecureContext) {
    checks.push(
      check('bad', 'Microphone access needs HTTPS. Open this page over https:// or on localhost.'),
    );
  }

  el.preflight.replaceChildren(...checks);
}

function initSetup() {
  fillLanguageSelects();

  const prefs = loadPrefs();
  const urlRoom = normaliseCode(new URLSearchParams(location.search).get('room') || '');

  el.name.value = prefs.name || '';
  el.speakLang.value = prefs.speak || 'en';
  // Output language tracks the spoken one until the user says otherwise;
  // wanting to hear a language you do not speak is the rare case.
  el.hearLang.value = prefs.hear || el.speakLang.value;
  state.hearTouched = Boolean(prefs.hear && prefs.hear !== prefs.speak);
  el.libreUrl.value = prefs.libre || '';
  el.rate.value = prefs.rate || 1.05;
  el.duck.value = prefs.duck ?? 0.15;
  el.room.value = urlRoom || randomCode();

  if (urlRoom) setStatus('Invite link detected — enter your name to join', 'good');

  el.newRoom.addEventListener('click', () => {
    el.room.value = randomCode();
  });

  el.speakLang.addEventListener('change', () => {
    if (!state.hearTouched) el.hearLang.value = el.speakLang.value;
    savePrefs();
    runPreflight();
  });
  el.hearLang.addEventListener('change', () => {
    state.hearTouched = true;
    el.hearLangLive.value = el.hearLang.value;
    savePrefs();
    runPreflight();
  });
  el.name.addEventListener('change', savePrefs);
  el.libreUrl.addEventListener('change', savePrefs);

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    join();
  });

  runPreflight();
}

/* ── Feed rendering ──────────────────────────────────── */

function renderUtterance({ who, self, original, translated, engine, lang }) {
  el.feedEmpty.hidden = true;

  const item = document.createElement('article');
  item.className = self ? 'utterance self' : 'utterance';

  const head = document.createElement('div');
  head.className = 'who';
  const name = document.createElement('span');
  name.textContent = who;
  const meta = document.createElement('span');
  meta.className = 'engine';
  if (engine) meta.dataset.engine = engine;
  meta.textContent =
    engine === 'failed'
      ? 'translation unavailable'
      : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  head.append(name, meta);

  const main = document.createElement('div');
  main.className = 'translated';
  main.textContent = translated;
  if (isRTL(lang)) main.dir = 'rtl';

  item.append(head, main);

  // Keep the source text visible; it is the only way a bilingual listener can
  // catch a mistranslation, and it matters when the wording is consequential.
  if (original && original !== translated) {
    const src = document.createElement('div');
    src.className = 'original';
    src.textContent = original;
    item.append(src);
  }

  el.feed.append(item);
  while (el.feed.children.length > MAX_FEED_ITEMS + 1) {
    // +1 accounts for the persistent empty-state node.
    const first = el.feed.children[1];
    if (!first) break;
    first.remove();
  }
  el.feed.scrollTop = el.feed.scrollHeight;
}

function showLive(text) {
  el.liveRow.hidden = false;
  el.liveText.textContent = text;
  clearTimeout(state.liveTimer);
  state.liveTimer = setTimeout(() => {
    el.liveRow.hidden = true;
  }, 2500);
}

function renderParticipants() {
  const chips = [
    `<span class="chip self">${escapeHtml(state.displayName)} (you)</span>`,
    ...[...state.names.values()].map(
      (n) => `<span class="chip">${escapeHtml(n)}</span>`,
    ),
  ];
  el.participants.innerHTML = chips.join('');
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/* ── Audio sinks ─────────────────────────────────────── */

function attachStream(peerId, stream) {
  let audio = state.sinks.get(peerId);
  if (!audio) {
    audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    el.sinks.append(audio);
    state.sinks.set(peerId, audio);
  }
  audio.srcObject = stream;
  audio.volume = state.duck;
  audio.play().catch(() => {
    setStatus('Click anywhere to enable audio playback', 'warn');
  });
}

function applyDuck() {
  state.sinks.forEach((audio) => {
    audio.volume = state.duck;
  });
}

/* ── Joining ─────────────────────────────────────────── */

async function join() {
  const name = el.name.value.trim();
  const code = normaliseCode(el.room.value);
  if (!name || !code) return;

  el.join.disabled = true;
  state.displayName = name;
  state.speakLang = el.speakLang.value;
  state.hearLang = el.hearLang.value;
  state.duck = Number(el.duck.value);
  mt.setLibreEndpoint(el.libreUrl.value);
  tts.setRate(Number(el.rate.value));
  savePrefs();

  try {
    setStatus('Requesting microphone…');
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch {
    setStatus('Microphone blocked — allow it and try again', 'bad');
    el.join.disabled = false;
    return;
  }

  state.room = new Room({
    code,
    displayName: name,
    localStream: state.localStream,
    meta: { speakLang: state.speakLang },
  });
  wireRoom(state.room);

  try {
    await state.room.join();
  } catch (err) {
    setStatus(err.message || 'Could not join the room', 'bad');
    el.join.disabled = false;
    return;
  }

  el.setup.hidden = true;
  el.call.hidden = false;
  el.roomCode.textContent = code;
  el.hearLangLive.value = state.hearLang;
  renderParticipants();
  startListening();
}

function wireRoom(room) {
  room.addEventListener('status', (e) => setStatus(e.detail.text));
  room.addEventListener('error', (e) => setStatus(e.detail.message, 'bad'));

  room.addEventListener('ready', (e) => {
    setStatus(
      e.detail.host
        ? 'Room open — share the invite link'
        : 'Connecting to the room…',
      'good',
    );
  });

  room.addEventListener('peer-join', (e) => {
    state.names.set(e.detail.peerId, e.detail.name);
    renderParticipants();
    setStatus(`${e.detail.name} joined`, 'good');

    // Now that their language is known, download the model before they speak
    // rather than making their first sentence wait for it.
    const theirLang = e.detail.meta?.speakLang;
    if (theirLang && theirLang !== state.hearLang && mt.hasBuiltIn()) {
      setStatus(`Preparing ${byMt(theirLang).name} → ${byMt(state.hearLang).name}…`);
      mt.prepare(theirLang, state.hearLang)
        .then((ok) =>
          setStatus(
            ok
              ? `Ready — translating ${byMt(theirLang).name} into ${byMt(state.hearLang).name}`
              : 'Using fallback translation service',
            ok ? 'good' : 'warn',
          ),
        )
        .catch(() => setStatus('Using fallback translation service', 'warn'));
    }
  });

  room.addEventListener('peer-leave', (e) => {
    state.names.delete(e.detail.peerId);
    const audio = state.sinks.get(e.detail.peerId);
    if (audio) {
      audio.srcObject = null;
      audio.remove();
      state.sinks.delete(e.detail.peerId);
    }
    renderParticipants();
    setStatus(`${e.detail.name} left`, 'warn');
  });

  room.addEventListener('stream', (e) => {
    attachStream(e.detail.peerId, e.detail.stream);
  });

  room.addEventListener('message', (e) => handleMessage(e.detail));
}

/* ── Speaking side ───────────────────────────────────── */

function startListening() {
  state.listener = new Listener(speechTag(state.speakLang));

  state.listener.addEventListener('final', (e) => {
    const text = e.detail.text;
    if (state.muted) return;

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    state.room?.broadcast({
      type: 'utterance',
      id,
      text,
      lang: state.speakLang,
      name: state.displayName,
    });

    // Your own words need no translation; showing them confirms the mic is
    // hearing you correctly, which is the fastest way to notice a bad setup.
    renderUtterance({
      who: 'You',
      self: true,
      original: '',
      translated: text,
      engine: '',
      lang: state.speakLang,
    });
  });

  state.listener.addEventListener('interim', (e) => {
    if (state.muted) return;
    const now = Date.now();
    if (now - state.lastInterimSent < INTERIM_THROTTLE_MS) return;
    state.lastInterimSent = now;
    state.room?.broadcast({
      type: 'interim',
      text: e.detail.text,
      lang: state.speakLang,
      name: state.displayName,
    });
  });

  state.listener.addEventListener('fatal', (e) => {
    setStatus(e.detail.message, 'bad');
  });

  state.listener.start();
}

/* ── Listening side ──────────────────────────────────── */

async function handleMessage({ data, name }) {
  if (data.type === 'interim') {
    // Interim text is translated only when the on-device engine is available:
    // it changes several times a second, which would exhaust a public API's
    // quota within a minute.
    if (mt.hasBuiltIn() && data.lang !== state.hearLang) {
      const { text } = await mt.translate(data.text, data.lang, state.hearLang);
      showLive(`${data.name || name}: ${text}`);
    } else {
      showLive(`${data.name || name}: ${data.text}`);
    }
    return;
  }

  if (data.type !== 'utterance') return;

  // A mesh delivers each message once per peer; ignore anything already seen.
  if (state.seen.has(data.id)) return;
  state.seen.add(data.id);
  if (state.seen.size > 500) state.seen.clear();

  const { text: translated, engine } = await mt.translate(
    data.text,
    data.lang,
    state.hearLang,
  );

  renderUtterance({
    who: data.name || name,
    self: false,
    original: data.text,
    translated,
    engine,
    lang: state.hearLang,
  });

  tts.speak(translated, state.hearLang);
}

/* ── Call controls ───────────────────────────────────── */

function initControls() {
  el.copyLink.addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(
      el.roomCode.textContent,
    )}`;
    try {
      await navigator.clipboard.writeText(url);
      el.copyLink.textContent = 'Copied';
      setTimeout(() => {
        el.copyLink.textContent = 'Copy invite link';
      }, 1600);
    } catch {
      window.prompt('Copy this invite link:', url);
    }
  });

  el.mute.addEventListener('click', () => {
    state.muted = !state.muted;
    state.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !state.muted;
    });
    el.mute.setAttribute('aria-pressed', String(!state.muted));
    el.mute.dataset.danger = String(state.muted);
    el.muteLabel.textContent = state.muted ? 'Muted' : 'Mute';
  });

  el.ttsToggle.addEventListener('click', () => {
    const on = el.ttsToggle.getAttribute('aria-pressed') === 'true';
    tts.setEnabled(!on);
    el.ttsToggle.setAttribute('aria-pressed', String(!on));
    el.ttsLabel.textContent = !on ? 'Voice on' : 'Voice off';
  });

  el.rate.addEventListener('input', () => {
    tts.setRate(Number(el.rate.value));
    savePrefs();
  });

  el.duck.addEventListener('input', () => {
    state.duck = Number(el.duck.value);
    applyDuck();
    savePrefs();
  });

  el.hearLangLive.addEventListener('change', async () => {
    state.hearLang = el.hearLangLive.value;
    el.hearLang.value = state.hearLang;
    tts.stop();
    savePrefs();
    setStatus(`Now hearing ${byMt(state.hearLang).name}`, 'good');
    if (!tts.hasVoiceFor(state.hearLang)) {
      setStatus(
        `No ${byMt(state.hearLang).name} voice installed — captions only`,
        'warn',
      );
    }
  });

  el.leave.addEventListener('click', leave);
  window.addEventListener('beforeunload', () => state.room?.leave());
}

function leave() {
  state.listener?.stop();
  tts.stop();
  state.room?.leave();
  state.localStream?.getTracks().forEach((t) => t.stop());
  state.sinks.forEach((a) => a.remove());
  state.sinks.clear();
  state.names.clear();
  state.room = null;
  el.call.hidden = true;
  el.setup.hidden = false;
  el.join.disabled = false;
  el.feed.replaceChildren(el.feedEmpty);
  el.feedEmpty.hidden = false;
  setStatus('Call ended');
}

/* ── Boot ────────────────────────────────────────────── */

initSetup();
initControls();
