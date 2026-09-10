// Continuous speech recognition on top of the Web Speech API.
//
// The API is free and fast but it was designed for short dictation, not for
// hour-long calls, so most of this file exists to paper over that. Chrome ends
// a session on its own after a stretch of silence and sometimes for no stated
// reason at all, which means the only way to stay listening is to restart on
// every `end` event. Restarts have to be rate-limited, though, or a permanent
// failure (a revoked mic permission, say) turns into a busy loop.

const Recognition =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

export const isSupported = () => Boolean(Recognition);

export class Listener extends EventTarget {
  /** @param {string} langTag BCP-47 tag, e.g. "en-US" */
  constructor(langTag) {
    super();
    this.langTag = langTag;
    this.recognition = null;
    this.wantRunning = false;
    this.restartDelay = 200;
    this.restartTimer = null;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #build() {
    const rec = new Recognition();
    rec.lang = this.langTag;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) {
          const finalText = text.trim();
          if (finalText) this.#emit('final', { text: finalText });
        } else {
          interim += text;
        }
      }
      if (interim.trim()) this.#emit('interim', { text: interim.trim() });
      // A successful result means the service is healthy; reset the backoff.
      this.restartDelay = 200;
    };

    rec.onerror = (event) => {
      const err = event.error;

      // Permission problems are terminal — retrying cannot fix them.
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        this.wantRunning = false;
        this.#emit('fatal', {
          error: err,
          message:
            'Microphone access was blocked. Allow the mic in your browser’s ' +
            'site settings, then rejoin.',
        });
        return;
      }

      // Silence is expected on a call; it is not worth surfacing.
      if (err === 'no-speech' || err === 'aborted') return;

      if (err === 'network') {
        // Back off so a flaky connection does not spin.
        this.restartDelay = Math.min(this.restartDelay * 2, 5000);
      }
      this.#emit('warning', { error: err });
    };

    rec.onend = () => {
      if (!this.wantRunning) {
        this.#emit('state', { running: false });
        return;
      }
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.#start(), this.restartDelay);
    };

    return rec;
  }

  #start() {
    if (!this.wantRunning) return;
    if (!this.recognition) this.recognition = this.#build();
    try {
      this.recognition.start();
      this.#emit('state', { running: true });
    } catch (err) {
      // `start()` throws InvalidStateError if the engine is already running,
      // which is harmless. Anything else deserves a retry.
      if (err?.name !== 'InvalidStateError') {
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => this.#start(), this.restartDelay);
      }
    }
  }

  start() {
    if (!isSupported()) {
      this.#emit('fatal', {
        error: 'unsupported',
        message:
          'This browser has no speech recognition. Use Chrome or Edge on ' +
          'desktop or Android.',
      });
      return;
    }
    this.wantRunning = true;
    this.restartDelay = 200;
    this.#start();
  }

  stop() {
    this.wantRunning = false;
    clearTimeout(this.restartTimer);
    try {
      this.recognition?.stop();
    } catch {
      /* already stopped */
    }
    this.recognition = null;
  }

  /** Switch languages mid-call by cycling the underlying engine. */
  setLanguage(langTag) {
    if (langTag === this.langTag) return;
    this.langTag = langTag;
    if (!this.wantRunning) return;
    const rec = this.recognition;
    this.recognition = null;
    try {
      // `onend` would otherwise restart the stale engine.
      if (rec) rec.onend = null;
      rec?.stop();
    } catch {
      /* already stopped */
    }
    this.#start();
  }
}
