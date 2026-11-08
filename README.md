# ScrollMate

A small cartoon friend that watches YouTube Shorts with you. It remembers the last three Shorts, notices funny connections between them, and decides **on its own** when a reaction is worth showing. Most of the time that means staying quiet.

Built for the incident.io track at WHACK 2026. The AI *proposes* reactions; a deterministic **reaction timing engine** decides whether and when to deliver them.

```
extension/   Chrome MV3 extension (TypeScript, React, Vite)
  src/shared/timing.ts     ← the timing engine (pure, also used by the eval)
  src/content/             character, radial ring, Shorts detection, frame capture, voice, demo
  src/background/          captureVisibleTab, backend calls, 3-Short memory
  src/stage/               offline demo stage page
backend/     FastAPI + LiteLLM + Instructor (/scrollmate/analyse, /scrollmate/react)
eval/        timing_eval.ts (naive vs ScrollMate) + rating_sheet.md
```

## Setup

### 1. Backend

```bash
cd backend
uv venv -p 3.12 .venv            # or: python -m venv .venv
uv pip install -p .venv -r requirements.txt
cp .env.example .env             # add ANTHROPIC_API_KEY (or any LiteLLM provider key + model)
.venv/Scripts/python -m uvicorn app.main:app --port 8000     # macOS/Linux: .venv/bin/python
```

Open **http://localhost:8000/ui** to test analyse/react without the extension: drop in frames, build the 3-Short memory, generate reactions, and see a request log.

The **Models** panel at the top switches providers instantly: **Mixed** (default), **Groq**, **OpenAI**, **Gemini** or **Gemini Live**, or a custom model for each slot.

**Gemini Live** (`backend/app/gemini_live.py`) is a vision lane for `/observe` only:
- **Sessions:** one persistent Live session per Short, which remembers earlier frames. A spare session is kept open for the next Short. Each frame returns through an `observe` tool call.
- **Speed:** about 1.0 s per frame (median), with a 2.5 s deadline per frame.
- **Fallback:** on a stall or an error, that frame falls back to the regular vision model.
- **Model strings:** `gemini-live/<model>`. **Speed test** times a 1-token request to every active model. A switch is held in memory: restarting the backend goes back to `backend/.env`, so put a choice you want to keep there. Presets whose API key is missing are locked.

The same page has a **Live from the extension** feed. While you scroll Shorts with ScrollMate active, the extension reports each step to `POST /scrollmate/events`, and the page streams it from `GET /scrollmate/feed`. You see one card per Short: frames captured, what the AI saw, the reactions it proposed, each timing decision (WAIT, SPEAK_NOW, …) and what was shown. The feed is RAM only (the last 200 events). The frame strip appears only with `SCROLLMATE_DEV_FEED_IMAGES=1`.

`GET http://localhost:8000/health` shows whether it is in **mock mode**. Mock mode turns on automatically when no key is set. It makes no LLM calls and gives text-only heuristic answers, so you can test the pipeline without a key.

Models are any LiteLLM string. The defaults use **Groq's free tier** (`GROQ_API_KEY`):

| Role | Model | Why |
|---|---|---|
| Vision (`SCROLLMATE_VISION_MODEL`) | `groq/qwen/qwen3.8-27b` | The only Groq model that accepts images |
| Reactions (`SCROLLMATE_TEXT_MODEL`) | `groq/openai/gpt-oss-20b` | Fast (~0.8 s), with its own rate-limit budget |
| Fallback (`SCROLLMATE_TEXT_FALLBACK_MODEL`) | `groq/openai/gpt-oss-120b` | Used when reactions fail or are rate limited |

Groq's free limits are **per model: 8k tokens/min and 1k requests/day**. An image costs a flat ~1.8k tokens whatever its resolution, so the background worker stitches each Short's 3 frames into **one strip image**. That's about 2.6k tokens per analysis, or roughly 3 fully analysed Shorts a minute. If vision fails or is rate limited, analysis retries text-only on the text model. That gives low confidence, so ScrollMate usually stays quiet for that Short. Groq models use Instructor's JSON mode: Groq's server-side tool-schema check rejects near-miss outputs that Pydantic would accept and retry. The other Groq chat model, `allam-2-7b`, doesn't support tool or JSON calling and isn't used.

### 2. Extension

```bash
cd extension
npm install
npm run setup:mediapipe  # one-time camera runtime and face-model setup
npm run build        # outputs extension/dist
```

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and choose `extension/dist`.
3. Optional: copy the extension ID into `backend/.env` as `SCROLLMATE_EXTENSION_ORIGIN=chrome-extension://<id>` to lock CORS to it. Without this setting, the backend accepts any `chrome-extension://` origin.

To use a backend somewhere other than `http://localhost:8000`, build with `VITE_BACKEND_URL=...` and add that host to `host_permissions` in `public/manifest.json`.

## Testing on real Shorts

1. Open `https://www.youtube.com/shorts/...`. The character appears asleep in the upper right of the video.
2. Click it to open the ring, then tap the character again to turn it on. Video reactions, comment reactions, voice, camera reactions and eye tracking turn on together. Camera access still needs browser permission and eye tracking needs a one-time calibration; use **Set up eyes** inside the ring to calibrate.
3. **Click the ScrollMate toolbar icon once per tab.** This grants `activeTab`, which `captureVisibleTab` needs. Without it, ScrollMate falls back to drawing the `<video>` to a canvas, then to title and captions only. The console reports the capture source.
4. Open DevTools and filter the console for `[ScrollMate]`. You'll see navigation, play, pause and loop events, frames (`via screen|canvas|text`), proposals, and each `DELIVER` with its reason.
5. Scroll normally. Reactions appear only at natural gaps: a loop, a pause, or the end of a Short. They are dropped when you scroll away, unless they are a cross-Short callback.

## Buddy ring

Click the floating character to expand a lavender ring around that same character. Choose **Personality** (Witty / Hype / Chill), **Reactions** (Rare / Balanced / Chatty), or one of six avatars. Tap the character in the centre to turn the buddy on or off; the ring closes automatically. Click outside, press Escape or use the small close button to close just the ring.

The ring is at most 320 px wide (previously 420 px); its calibration action sits above the character so it does not cover the avatar choices.

The buddy has one power switch. Video reactions, comment reactions, voice, camera and eye tracking stay enabled together while it is on. Turning it off stops speech, camera, gaze and pending reactions. Avatar and personality preferences are saved. There is no separate settings card, feature switch panel or three-step power sequence.

Camera access still needs browser permission. **Set up eyes** inside the ring opens the one-time gaze calibration. Camera frames are processed locally. Voice speaks only at quiet moments. Browser screen-capture permission requires a toolbar click; canvas/text fallbacks remain available. Near a screen edge, the buddy temporarily moves inward to fit its ring; closing restores its saved position.

Eye tracking assists timing without becoming a permanent mute switch. Uncalibrated gaze is ignored. An off-screen gaze estimate cannot mark a visible, forward-facing viewer as absent. Gaze alone may defer a reel comment for two seconds, then allow a silent bubble when the other timing rules permit it. Confirmed absence, laughter and deliberately hovering a comment still defer reel comments. Rare still filters lower-importance reactions; choose Balanced or Chatty for more frequent lines.

Gaze points guide the buddy's eyes and movement toward the comments. They expire after 1.5 seconds without fresh camera data; neither a stale position nor its attention zone should steer movement. The calibration model is saved locally, while raw movement coordinates stay transient. Only coarse attention-zone changes reach the optional backend debug feed. Use **Set up eyes** on the monitor and camera position you will actually use; recalibrate if the estimate drifts. Gaze alone is not evidence that someone liked a character or video.

If the vision model understands a reel but produces only a facial expression, the backend gives the text model one comment check using those existing observations. This adds no image upload and has a three-second deadline; it can still return nothing. Rare waits for the final observation and retains its importance threshold. Failed vision observations now return an explicit error, and the extension retries a later frame within its existing per-reel frame budget. Waking on an already-open reel also starts its title/context pipeline.

Verification: `npm.cmd run test:menu` checks master settings, and `npm.cmd run test:menu:browser` checks interaction and alignment at 1440 x 1000, 800 x 600 and 390 x 844, including reduced motion and every viewport corner. Browser checks stub camera/model requests; screenshots are saved in `.artifacts/orbit-menu-*.png`.

## Talk to buddy: realtime voice

Turn the buddy on and **tap its microphone**, on the avatar or in the ring. One continuous conversation opens: speak naturally, hear the cute Leda voice as audio arrives, and interrupt by speaking over it. Partial reply captions appear in the normal buddy bubble. Tap the microphone again, press Escape, put the buddy to sleep, leave Shorts or close the tab to stop capture and playback. Chrome may ask for microphone permission once in the extension setup tab. Keyboard activation, a 44px microphone target and live status/caption announcements remain available; there is no chat panel.

Replies and automatic reactions use English only, including when a reel or comment uses another language. To discuss comments, open YouTube's comments while Talk is active. Ask about the visible comments, or hover over a specific top-level comment for a moment and ask "What do you think of this comment?" The conversation receives up to six visible comments (500 characters each) and the exact hovered comment (up to 1200 characters). That selection remains available after its automatic reaction ends, even if it was already read or there is no room for the buddy to move. Visible comments refresh as the panel changes; swiping clears the selected comment. Finished voice captions give way to automatic reaction bubbles.

The pipeline adapts the streaming and cancellation architecture of [KoljaB/RealtimeVoiceChat](https://github.com/KoljaB/RealtimeVoiceChat), reviewed at revision `c1071e55e98b8027be348c18025db5600949c539`. Its [browser worklets](https://github.com/KoljaB/RealtimeVoiceChat/tree/c1071e55e98b8027be348c18025db5600949c539/code/static), [WebSocket server](https://github.com/KoljaB/RealtimeVoiceChat/blob/c1071e55e98b8027be348c18025db5600949c539/code/server.py) and [generation cancellation manager](https://github.com/KoljaB/RealtimeVoiceChat/blob/c1071e55e98b8027be348c18025db5600949c539/code/speech_pipeline_manager.py) informed this independent implementation. ScrollMate uses your existing Gemini key for native live speech, replacing the reference project's separate local RealtimeSTT, Ollama and RealtimeTTS stages. No upstream source is vendored and its local-model installation scripts are not part of ScrollMate.

- The shared offscreen page captures mono PCM16 at 16 kHz on an AudioWorklet, sending 40 ms binary frames over one WebSocket to `/scrollmate/talk/live`.
- The backend maintains one Gemini Live session per connection. A bounded input queue prevents an accumulating audio backlog. Gemini performs speech recognition and voice activity/turn detection while generating speech directly.
- Reply PCM at 24 kHz streams into a playback AudioWorklet. Captions update incrementally. Interruption clears buffered audio immediately; generation numbers reject stale chunks. The microphone stays open during playback so you can interrupt.
- Swiping and reading comments update context in the same session. A `current_reel` tool reads the latest notes without inserting an unsolicited spoken turn. Other frame analysis, comments, camera expressions, gaze and roaming remain active. Ambient reactions use silent bubbles during Talk; the reel is never paused or muted automatically.

Set `GEMINI_API_KEY` in `backend/.env`. The defaults are `SCROLLMATE_TALK_LIVE_MODEL=gemini-3.8-live` and `SCROLLMATE_TALK_VOICE=Leda`; both can be overridden. The native Live model must be available to your key. Talk no longer uses the separate TTS model or the 30-second record/upload loop. The HTTP `/scrollmate/talk` endpoint remains available for compatibility, including typed turns, and has its own `SCROLLMATE_TALK_MODEL` / `SCROLLMATE_TALK_VOICE_MODEL` overrides.

During an active session, microphone audio streams continuously through your backend to Gemini, including silence and sound from nearby speakers. Echo cancellation and noise suppression are requested; headphones help prevent reel audio being mistaken for you. Stop turns the microphone off and clears playback. Audio, captions and conversation history are not saved to disk or the public debug feed. Gemini maintains the active session's conversation context; it is discarded when the connection closes. Sessions are limited to ten minutes; a closed or failed connection shows a reconnect message instead of silently reopening capture.

Restart the backend after updating this code, reload ScrollMate at `chrome://extensions`, and refresh YouTube. The extension build includes `audio/voice-worklets.js`. `VITE_BACKEND_URL` controls the HTTP and derived WebSocket URL; HTTPS uses WSS. If `SCROLLMATE_EXTENSION_ORIGIN` is set, it must match your extension's origin. The WebSocket accepts extension origins only and limits concurrent connections.

Validation: backend `python -m unittest discover -s tests`; extension `npm.cmd run test:talk`, `npm.cmd run test:menu:browser`, `npm.cmd run test:comments:browser`, and `npm.cmd run test:talk:media` (build first). Browser media checks exercise actual PCM worklets and fake devices with a stubbed WebSocket provider, including audio capture during playback, interruption, shared-camera independence and cleanup. Real device permissions, acoustic echo and screen-reader behaviour still require a manual device check.

## Reactions to comments

On a real YouTube Short, open the ring and tap the character to turn it on (this enables comment reactions too), then open YouTube's comments yourself. Clicking outside the buddy closes its menu automatically. Rest the mouse on a visible top-level comment's text for a moment (0.25 s). Passing over comments, links, replies, or buttons does not trigger a request.

The buddy hops to a free lane beside the comments panel while the backend requests a text-only reaction from the selected text model. A purple outline identifies the selected comment. It reacts silently after arriving, or shows only an expression when no line is worth saying. Click its bubble to dismiss it and return home. Automatic visits preserve its saved, dragged position. If neither side has room, it stays home instead of covering the comments. Reduced-motion preferences disable travel animation.

There is no wait between comment visits: no cooldown and no countdown. The only thing it waits for is a reaction bubble still on screen; click it to dismiss it, or wait for it to fade. Each comment text is attempted once per Short (up to 100). A stationary hover retries as soon as the previous bubble is gone, with a short status under the buddy explaining the wait. Video reactions wait while the user is reading a comment, so repeated video bubbles cannot block selection indefinitely. The page console includes detection counts without comment text.

Scrolling, closing the panel, changing the comment's text/layout, navigating to another Short, opening buddy controls, dragging, disabling the feature, and switching personality cancel the visit. The background worker aborts that comment request, and the content script ignores late responses. The buddy returns home after its reaction.

`POST /scrollmate/comment` accepts `requestId`, `videoId`, `commentId`, `text` (max 1200 characters), optional `title`/`videoSummary`, `personality` and `frequency`. It returns the same request/comment identifiers, an optional emotion, and zero or one reaction bound to that exact selection. The endpoint reuses structured output and the conversational personality prompts, has a six-second generation deadline, and degrades to silence on failure. Mock mode gives a curious expression without calling a model. No extra vision call or humaniser service is needed.

The selected text and existing video notes are sent to the model provider only after a deliberate hover while the feature is on. Author metadata and the whole thread are not collected. For context, the extension keeps the last 5 comments it reacted to on the current Short, with its own replies, in memory only. That list goes with the next comment request and is wiped when you change Short. Raw comment text is not persisted or added to the backend's live feed. YouTube may change its comment DOM; the detector supports current `ytd-comment-view-model` and older `ytd-comment-renderer` elements and intentionally limits support to top-level comments on Shorts.

Local checks (no provider calls):

```powershell
# From backend/
.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_comments.py -v
# From extension/
npm.cmd run test:comments
npm.cmd run test:comments:browser  # installed Chrome/Edge, or set CHROME_PATH
```

The browser checks use a local fixture and stubbed model responses, in both normal and reduced-motion modes. They verify hover intent, placement, target changes, cancellation, navigation and preserving the home position. Real YouTube layouts and live reaction quality still need a manual check after reloading the extension.

## Demo mode (for the stage)

- **Offline demo stage:** in the popover, click **Open offline demo stage ↗**, or open `chrome-extension://<id>/stage.html`. It's a fake Shorts player with three cakes, so it needs neither YouTube nor Wi-Fi.
- The script: (1) a successful cake, (2) a burnt cake, (3) a professional mirror-glaze cake. ScrollMate stays silent on 1 and 2, because their reactions fall below the importance threshold for *Balanced*. It starts thinking during Short 3, **waits** while it plays, then delivers the callback at the end: *"We've just witnessed the rise, fall and redemption of the entire baking industry."*
- Press `]` or click **Next Short** to skip ahead. Click the phone to pause. Set frequency to **Chatty** to see Short 2's line delivered too. Personality changes the lines.
- Voice follows the buddy's power switch. The demo has no soundtrack, so it counts as a quiet moment.

## Evaluation

```bash
cd extension
npm run eval                       # 20-Short session (seed 7) + average over 100 sessions
npm run eval -- --frequency rare --seed 3
npm run eval -- --dump s.json      # save the session; replay later with --session s.json
```

Current output (balanced):

```
policy       delivered interruptions  stale duplicates  callbacks
Naive               23            10      2          1         12
ScrollMate          11             0      0          0          8
Average over 100 sessions of 20 Shorts: Naive 9.3 interruptions, ScrollMate 0.0
```

Both policies get exactly the same simulated reactions: frames at 10%, 50% and 85% of the first pass, 2.5–5 s of analysis latency, and occasional repeated lines from the LLM. "Interruption" means a reaction delivered while the video was playing, away from the start, the end and a just-finished loop. **Be honest about what this number is.** It shows the policy behaves as designed on scripted sessions. It does not show that people like it. For that, run `eval/rating_sheet.md` with 5 testers and put their % funny into the headline the script prints.

## How it works

- **Detection** (`content/shorts.ts`): `yt-navigate-finish`, `popstate`, polling `location.href` every 500 ms, and a `MutationObserver` that re-finds the active `<video>` by visible area. It never depends on a single selector. Loops are detected from the `currentTime` wrap-around, because Shorts use `<video loop>`.
- **Frames:** `captureVisibleTab` (ScrollMate hidden for two frames, cropped to the video rect, ≤512 px JPEG, at most 3 per Short with ≥600 ms between captures), then canvas, then text only.
- **Memory:** a 3-item ring buffer in the background worker, mirrored to `chrome.storage.session`. That storage lives in RAM, never on disk, and survives MV3 worker restarts. Analyses are cached by video ID on both sides.
- **Timing engine** (`shared/timing.ts`) rules, in order: disabled, duplicate, expired, below the importance threshold (Rare 0.75, Balanced 0.55, Chatty 0.4), stale (scrolled away, not a callback), per-Short cap, fast scrolling (≥3 Shorts in 6 s), cooldown (Rare 45 s, Balanced 20 s, Chatty 12 s), natural gap → `SPEAK_NOW`. Mid-playback is `WAIT`, or `SAVE_FOR_LATER` for callbacks. The one exception is a time-sensitive reaction with importance ≥ 0.9, which may show as a silent bubble if it isn't near a key moment. Voice is used only when it's known to be quiet (paused, muted, or the demo). Otherwise the bubble shows silently. The engine never touches playback or volume.
- **Live loop (real Shorts):**
  1. **On swipe:** title rules (`shared/moments.ts`, < 1 ms) give an instant non-specific face ("I tried…" → 🤔, "POV:" → 😂). `POST /scrollmate/swipe` then confirms it from the title (about 0.6 s).
  2. **Frame 1 at about 0.4 s:** `POST /scrollmate/observe` sends one frame plus the backend's running **belief** for that Short. It returns the updated belief, a face for this moment, `change` (none, minor or major), a `level` from 0 to 3, maybe one line, and `next_capture_at`.
  3. **Frames 2–3 at the predicted times:** kept at least 1.5 s after the previous frame and no later than 0.5 s before the end, with **at most 3 frames**. Each frame takes about 0.8–2 s (vision models raced).
  4. **Levels:** a deterministic cap stops low confidence from earning more than a face.
     - **Level 3** (a strong moment, only possible at confidence ≥ 0.75) may show **mid-video** as a short silent bubble. It goes through the timing engine's urgent path and still respects the cooldown and the one-bubble-per-Short limit.
     - **Level 2** lines wait for a pause.
  5. **Memory:** the final belief becomes the memory record once the Short ends, including any `running_joke`. Callbacks are used only when the pattern genuinely continues.
- **Timed emotions** (`shared/emotions.ts`): the vision model tags each moment it sees with an emotion (surprised, laughing, impressed, worried, cringe, love, sad). The backend pins each one to the real frame time and turns them into `cues` (`build_cues()` in `backend/app/main.py`). Cues only come from frames, never from title text alone, and cues closer than 1.2 s are merged. The `CueTrack` fires a cue when playback *crosses* its time, 0.3 s early so the face lands on the moment. The face holds for about 1.4–2.2 s, depending on intensity, then eases back. A face change never interrupts, so unlike speech it may happen mid-playback. On real Shorts the analysis arrives near the end of the first play, so faces sync on the loop. In the demo the cues are hand-timed, so they sync on the first play. Bubbles and speech take priority over faces. Faces take priority over "thinking".
- **Character: Mochi** (`content/Character.tsx` and `content/mochi/`). This is the same mascot as the Companio landing page (`scrollmateWeb/companio-landing/src/companion`): a gumdrop body with a sprout, plus its eyes, mouths, brows and effects.
  - **How it's ported:** `geometry.ts` and `faceParts.tsx` are copied unchanged. The landing page animates with the `motion` library, but the extension can't use an animation framework, so the per-emotion body motions, sprout sway, blinking, face swap and effects are plain CSS keyframes, generated in `mochi/moods.ts`.
  - **Moods → Mochi emotions:**
    - impressed → excited
    - amused (while a bubble shows) → happy
    - thinking and curious → curious
    - love → supportive
    - worried → concerned
    - laughing → amused
    - sleeping → sleepy
    - surprised → surprised
    - extra faces for idle, watching, speaking, cringe and sad
  - **Reduced motion:** turns the animations off.
- **Models and concurrency:**
  - **Vision:** OpenAI `gpt-5.6-terra`, with hidden reasoning off, about 2.5–4 s. Falls back to Groq Qwen, which still gets the image, then to text only.
  - **Text (reactions and captions):** `gpt-5.6-terra` and Groq `gpt-oss-20b` are **raced**. The first valid answer wins and the other request is cancelled: reactions take about 0.3–0.5 s, and an outage on either provider costs nothing (`race()` in `backend/app/llm.py`).
  - **Why text races on gpt-oss-20b, not Qwen:** Groq's token limits are per model, so racing on Qwen would starve its vision fallback.
  - **Warm-up:** models are pinged once at startup. This removes a cold start of about 5 s on the first Short.
- **Caption step** (`POST /scrollmate/caption`): new visible caption lines are batched (at most one request every 4 s per Short) and sent to the fast text race. That runs alongside frame analysis. The answer can change the face straight away, and its reaction joins the timing engine's queue like any other. Most lines are ordinary and return nothing. This only works when CC is on.
- **Backend:** every model output is validated by Pydantic through Instructor. Any failure, timeout or unsafe line becomes *no reaction*. Requests are rate limited per IP. The prompt explicitly requires a callback when remembered Shorts share a theme.

## React to me 📷 (opt-in webcam)

Mochi can react to **you**:
- **Mirroring:** it laughs along when you laugh, and looks surprised (or sad) with you.
- **Holding comments:** video comments are held while you're laughing or looking away. The timing engine adds `user_laughing` and `user_away` to its WAIT reasons.

**How it works:**
- Turn on **React to me 📷** in the character's settings. The first time, a ScrollMate tab opens and asks for camera access once.
- A hidden extension page (`chrome.offscreen`) runs **MediaPipe Face Landmarker** on-device at about 10 fps (`src/camera/offscreen.ts`).
- Its 52 blendshape scores and the head angle become a few labels (`src/shared/faceSignals.ts`): laughing, happy, surprised or sad, plus present and looking away.
- **Only those labels** go to the character. No frames are stored or sent anywhere, and nothing goes to the backend. A 📷 badge on the character shows when the camera is on.

**Setup:** `npm run setup:mediapipe` (once, in `extension/`) copies MediaPipe's wasm runtime and downloads `face_landmarker.task` into `public/mediapipe/`. That folder is git-ignored, about 30 MB. Then run `npm run build`.

**Tests:**
- `npm run test:face`: the expression and away rules.
- `node scripts/test-face-pipeline.mjs`: runs the built camera page in headless Chrome with a **fake camera** and checks that MediaPipe loads, runs at about 10 fps, and reports "not in view". The fake camera has no face, so real expressions still need a manual check with your webcam.

## Emotions and avatars

Click the character to choose an **avatar**:
- **Companio:** Mochi, the landing page's mascot, which is the default.
- **ScrollMate:** the original character with headphones.

Both draw every emotion. TypeScript enforces it, because each avatar's faces are typed `Record<Mood, …>`.

**Adding an emotion:**
1. `backend/app/emotions.py`: add the id, emoji, when the AI should use it, and which Mochi face it maps to. The prompts, validation, the Gemini Live tool and the `/ui` emoji all read this catalog.
2. `extension/src/shared/emotions.ts`: add the id to `EMOTION_IDS`.
3. Give it a look in `extension/src/content/mochi/moods.ts` (`LOOKS`) and a face in `extension/src/content/avatars/ScrollMateCharacter.tsx` (`FACES`). `npx tsc --noEmit` fails until both exist.
4. `python backend/scripts/check_emotions.py` confirms the backend, the extension and both avatars agree, and exits 1 if they don't.

## Privacy

- Off until the user turns it on. A green or grey dot shows the state. Turning it off cancels the queue, speech and in-flight requests immediately.
- Sent to the AI provider: up to 3 downscaled frames per Short, the title, the channel name, visible captions, and one-line notes about the last 3 Shorts.
- Never stored: frames, audio, transcripts.
- Permissions: `storage`, `activeTab`, and host access to `www.youtube.com` and `localhost:8000`.

## Known limitations (honest list)

- **`captureVisibleTab` needs `activeTab` or `<all_urls>`.** We chose the minimal `activeTab`, so the user has to click the toolbar icon once per tab. Before that, frames come from the canvas fallback, which works on YouTube today but could become tainted. After that, text only.
- **The content script matches all of `youtube.com/*`, not just `/shorts/*`.** YouTube is a SPA, so arriving at Shorts from the home page would never inject a Shorts-only script. It stays dormant and renders nothing outside `/shorts/`.
- **No audio analysis.** Without `tabCapture` we can't tell when someone is talking, so we assume they might be. That is why voice is off by default and only speaks when paused or muted. Audio capture and transcription remain a stretch goal.
- The timing engine runs in the content script, next to the playback signals. Memory and network calls live in the background worker.
- Callback quality depends on the model's themes. A Short skipped in under 4 s is remembered only as "skipped".
- YouTube DOM selectors for the title and channel will drift. Fallbacks include `document.title`.
- The live LLM path has been tested only up to the provider (with an invalid key, it degrades to silence correctly). Run it with a real key before the demo.

## Next steps

Opt-in `tabCapture` audio for real quiet-moment detection and transcripts; calibrate importance thresholds against the rating-sheet data; an options page to request `<all_urls>` instead of the toolbar click; record real sessions from the exported decision logs and replay them in the eval.
