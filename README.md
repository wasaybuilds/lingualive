# LinguaLive

Peer-to-peer calls with live speech translation. Everyone speaks their own
language and hears their own.

No accounts, no API keys, no server bill. Speech recognition, translation and
speech synthesis all run in the browser, and the call itself is direct between
participants.

---

## How it works

```
  your mic ─▶ Web Speech API ─▶ text ──┐
                                       │  WebRTC data channel
                                       ▼
                        each listener translates locally
                                       │
                    their ear ◀── speechSynthesis ◀──┘
```

The important design choice is that **translation happens on the listener's
side**. Your browser transcribes only your own microphone and broadcasts plain
text. Every listener then translates that text into whatever language *they*
picked and speaks it with their own system voice.

That has three consequences worth knowing:

- **Cost stays at zero** no matter how many people join, because nobody pays
  per translation — each device does its own.
- **Everyone chooses independently.** Two people can be in the same call
  hearing different languages without agreeing on anything.
- **Nothing but text crosses the wire**, and audio goes directly peer-to-peer,
  so no server ever holds your conversation.

| Stage | Component | Cost | Typical latency |
| --- | --- | --- | --- |
| Speech → text | Web Speech API | free | 300–500 ms |
| Translation | Chrome on-device Translator | free | 50–150 ms |
| Text → speech | `speechSynthesis` | free | 50–100 ms |
| Transport | WebRTC (direct) | free | one hop |

End-to-end that lands around **0.8–1.5 s** behind the speaker, which is
comparable to a human interpreter.

## Requirements

- **Chrome or Edge 138+** on desktop. Speech recognition and the on-device
  translator are Chromium-only; Firefox and Safari will load the page but
  cannot transcribe.
- **HTTPS** (or `localhost`). Microphone access is refused otherwise.
- **Headphones.** Without them each side's speakers feed back into the other's
  microphone and the app transcribes its own output.

## Running locally

No build step and no dependencies — it is static files.

```bash
git clone https://github.com/wasaybuilds/lingualive.git
cd lingualive
python -m http.server 8000
```

Open <http://localhost:8000>. To test properly, open it in two separate browser
windows with different room participants, or send the invite link to someone
else.

## Deploying

### GitHub Pages

Already wired up. Push to `main`, then in the repository go to
**Settings → Pages → Build and deployment → Source: GitHub Actions**. The
included workflow publishes on every push.

### Anywhere else

It is a folder of static files. Netlify, Vercel, Cloudflare Pages and S3 all
work by dropping the directory in — no configuration needed.

## Using it

1. Both people open the site.
2. One picks a room code and joins; the invite-link button copies a URL with
   the code baked in.
3. Each person sets **I speak** to their own language. **Translate everything
   into** normally stays the same — it is what other people's words become.
4. Talk. Transcript and translation appear live; the translation is spoken
   aloud.

The **Original voice** slider controls how loudly you hear the untranslated
speaker underneath the translation. Interpreters normally keep a little of it,
around 15%, because tone and interruptions carry through even when words do not.

## Privacy

Audio is peer-to-peer and never recorded. Text stays local when Chrome's
on-device translator handles it.

Two caveats you should be honest with participants about:

- The **Web Speech API sends audio to Google's servers** for recognition. This
  is unavoidable with the free browser API; only a local Whisper build avoids
  it.
- If the on-device translator has no model for a language pair, the app falls
  back to **MyMemory's public API**, which sees the text. Configure a
  self-hosted LibreTranslate URL under *Advanced* to avoid this entirely:

  ```bash
  docker run -p 5000:5000 libretranslate/libretranslate
  ```

If you are handling anything sensitive, get explicit consent from everyone on
the call first. In the EU, voice is personal data under GDPR.

## Known limits

- **Verb-final languages lag.** German and Japanese put the verb at the end, so
  a sentence cannot be translated until it is finished. Human interpreters have
  the same problem; it is linguistic, not technical.
- **Cross-talk degrades it.** Each participant transcribes only their own mic,
  which helps, but two people talking at once still produces interleaved
  captions.
- **Free translation quality** is below DeepL or an LLM. Good for conversation;
  not something to rely on for legal or medical wording.
- **Strict firewalls** may block the direct connection. A free public TURN
  relay is configured as a fallback, but it is best-effort.
- **Mesh topology** means every participant connects to every other, which
  works well up to about four or five people and degrades past that.
- **Room codes are not secret.** Anyone with the code can join. Treat it like a
  meeting link, and pick a fresh code for each conversation.

## Project layout

```
index.html          markup for both the setup and call screens
css/styles.css      all styling
js/main.js          controller: wires everything together
js/rtc.js           WebRTC mesh over PeerJS
js/speech.js        continuous recognition with restart handling
js/translate.js     three-tier translation with fallback
js/tts.js           speech synthesis with backlog dropping
js/languages.js     language table
```

## Licence

MIT — see [LICENSE](LICENSE).
