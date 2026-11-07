# Build ScrollMate: a real-time AI companion for YouTube Shorts

You are a senior full-stack engineer experienced in Chrome extensions, multimodal AI and interactive frontend work. Build a working hackathon MVP called **ScrollMate** for the incident.io track at WHACK 2026.

The incident.io brief: *"Most AI is built to answer after the fact. You ask a question, wait, and get a response. But the world doesn't wait. Things happen in real time, and the most interesting moments are over before you could type a prompt about them."*

ScrollMate answers that brief. Shorts last seconds and nobody types a prompt while scrolling, so the AI has to notice, remember and decide on its own when a reaction is worth showing.

## 1. Product vision

ScrollMate is a small cartoon character that floats on YouTube Shorts and watches alongside the user, like a funny, observant friend who knows when to speak and when to stay quiet.

It must not produce constant commentary. It understands each Short, remembers the last three, finds funny connections between them, and reacts only when the reaction adds something.

Guiding principle: **"A friend who watches with you, remembers the funny moments, and never interrupts unnecessarily."**

The core technical feature is the **reaction timing engine** (section 8). The jokes are the surface; knowing *when* to deliver them is the product.

## 2. Frontend design

The visual reference is `scrollmate-reference.png` (in the same folder as this file): a cream, rounded creature with purple headphones floating over a Short.

### Character
- Original SVG or CSS character inspired by the reference: cream body, rounded ears, purple headphones, large expressive eyes, soft pastel colours. Don't depend on external image files.
- About 80–110 px wide on desktop, scaling with the viewport.
- Starts near the upper right of the video, clear of YouTube's own controls (the like, comment and share column on the right, the title and channel at the bottom).
- Draggable. Remember the position in `chrome.storage.local`.
- Gentle idle float.
- A small speech bubble appears only when reacting.
- No dashboard and no separate window.

### States
1. **Idle:** slow float, occasional blink.
2. **Watching:** attentive eyes.
3. **Thinking:** small thought indicator while analysis runs.
4. **Amused:** smile or giggle.
5. **Speaking:** mouth animation plus speech bubble.
6. **Sleeping:** when disabled or nothing has happened for a while.

Use CSS keyframes or light SVG animation. No animation framework. Respect `prefers-reduced-motion`.

### Controls
Clicking the character opens a compact popover with:
- AI on/off
- Voice on/off (**off by default**, see section 9)
- Personality: Witty, Hype, Chill
- Reaction frequency: Rare, Balanced, Chatty
- Clear session memory
- A short privacy note: what is sent to the AI and what is never stored

The character must never block scrolling or YouTube's controls. Render everything inside a **Shadow DOM** so YouTube's CSS can't affect it and ours can't affect YouTube. Use `pointer-events: none` on the wrapper and enable pointer events only on the character and popover.

## 3. Tech stack

**Extension**
- TypeScript, React, Vite
- Chrome Extension Manifest V3: content script, background service worker
- Plain CSS or Tailwind, scoped inside the Shadow DOM
- `chrome.storage.local` for preferences only
- Browser `speechSynthesis` for voice

**Backend**
- Python 3.12, FastAPI, Pydantic v2
- LiteLLM (any OpenAI-compatible vision and text model) and Instructor for validated structured output
- This matches the team's existing repo. If that repo is available, add ScrollMate's endpoints to it rather than starting a new server, and reuse its `structured()` LLM client.

Keep dependencies few. **Never put API keys in extension code.** The extension only talks to our backend.

## 4. YouTube Shorts integration

Support only `https://www.youtube.com/shorts/*`.

Detect:
- navigation to a new Short, and its video ID (from the URL)
- play, pause, resume, end, and loop of the current video
- current time and duration when available
- the user skipping to another Short, and how long they watched first

YouTube is a single-page app. Use URL checks, History API events (`yt-navigate-finish` where it fires, plus a fallback that polls `location.href`), a `MutationObserver` to find the active `<video>` element, and listeners on that element. Don't rely on one CSS selector. Debounce navigation and never process the same Short twice in a row.

## 5. Video understanding

A modular pipeline that tries to work out the main subject, what happens visually, what the creator says (when available), the key action or outcome, any surprising or funny moment, and links to the previous Shorts.

### Frames: use this order, with documented fallbacks
1. **Primary: `chrome.tabs.captureVisibleTab`** from the background worker. It screenshots what's on screen and doesn't depend on the video element allowing canvas reads.
   - Check the Chrome docs for the permission it needs (host permission for YouTube or `activeTab`) and request the minimum.
   - Chrome rate-limits this call to about two per second, so take at most three frames per Short: near the start, middle and end.
   - **Hide ScrollMate during the capture**, or crop the screenshot to the video's bounding rectangle, so the character doesn't appear in its own frames.
   - Downscale to about 512 px on the long side and send as JPEG.
2. **Fallback: draw the `<video>` element to a canvas.** This may fail with a security error. Catch it.
3. **Last resort: text only.** Use the title, channel name, and any captions visible on the page, and mark `understandingLevel` as `text_only`.

### Words
- Use captions or transcript text only if they're visible in the page. Don't assume they always exist.
- Don't scrape protected endpoints, bypass browser restrictions or download video.
- Audio capture with `chrome.tabCapture` plus transcription is a **stretch goal only**, behind an explicit user click.

### Analysis output (validated with Pydantic)
```json
{
  "videoId": "example",
  "topic": "baking",
  "summary": "A creator attempts to bake a cake.",
  "events": [{ "timestamp": 14, "description": "The cake collapses.", "confidence": 0.85 }],
  "outcome": "The baking attempt failed.",
  "mood": "funny",
  "understandingLevel": "visual_and_text",
  "confidence": 0.82
}
```
- Confidence values are model estimates, not calibrated probabilities. Say so in a code comment.
- Never invent events that weren't observed. If information is thin, prefer silence to a wrong reaction.

## 6. Short-term memory

- Keep only the **last three Shorts** in an in-memory ring buffer in the background worker.
- Each record: video ID, topic, one-line factual summary, key events, outcome, seconds watched, whether it was skipped, themes.
- A fourth Short evicts the oldest.
- Keep a separate small queue of pending reactions.
- No database and no vector store. Don't persist frames, video content or transcripts.

## 7. Comedy and personality

Reactions can respond to a surprising moment, notice irony, joke about an unexpected outcome, call back to an earlier Short, link themes across the last three, or make a light observation about viewing behaviour.

Example: Short 1, someone bakes a cake successfully. Short 2, someone burns one. Short 3, a professional decorates a stunning cake. Reaction: *"We've just witnessed the rise, fall and redemption of the entire baking industry."*

The cross-Short callback is the demo's best moment. Make sure the prompt asks for it explicitly when the last three Shorts share a theme.

### Personalities
- **Witty:** playful, observant, never mean
- **Hype:** excited, celebratory
- **Chill:** calm, subtle, speaks rarely

Reactions are one short sentence. Never joke about protected characteristics, tragedies, the people in the video's appearance, or sensitive personal information.

## 8. Reaction timing engine (the most important feature)

Generating a reaction and delivering it are separate steps. The LLM proposes; a deterministic state machine decides. The LLM never controls playback.

Each proposed reaction:
```json
{
  "text": "That escalated quickly.",
  "importance": 0.9,
  "targetVideoId": "example",
  "preferredTiming": "after_video",
  "expiresAfterSeconds": 12,
  "requiresQuietMoment": true
}
```

The planner chooses one of: `SPEAK_NOW`, `WAIT`, `SAVE_FOR_LATER`, `STAY_SILENT`.

It checks:
1. Is the video playing?
2. Is speech or loud audio detectable? If not, assume it might be, and be conservative.
3. Is the user scrolling fast (several Shorts in a few seconds)?
4. Has the user paused, or has the Short ended or looped?
5. Did ScrollMate react recently?
6. Is the reaction still about the Short on screen, and not expired?
7. Would it cover an important moment?

Rules:
- Default cooldown: 20 seconds (Rare: 45 s, Chatty: 12 s).
- Never pause the video or change its volume.
- Prefer natural gaps: the end of a Short, a loop, a pause.
- When the user scrolls, drop or defer reactions about the old Short. A callback reaction may be saved for later.
- No reliable quiet moment: show the bubble silently instead of speaking.
- Don't react to every Short, and never repeat a reaction.
- Disabling the companion cancels everything queued, immediately.

**Log every decision** (time, reaction, inputs, decision, reason) to an in-memory list that the evaluation in section 13 can export.

## 9. Voice

- Voice is **off by default**. The speech bubble is the main channel, because talking over a video with sound is hard to time well.
- When on: `speechSynthesis` with a queue, cancellation, no overlapping speech, and a mouth animation tied to the `start` and `end` events.
- Keep spoken lines short.

## 10. Backend

Endpoints:
- `POST /scrollmate/analyse`: frames (base64 JPEG) plus available text, returns the analysis model
- `POST /scrollmate/react`: the last three analyses plus personality and frequency, returns zero or more reaction candidates

Requirements:
- Validate every model response with Pydantic (via Instructor). On failure, return no reaction rather than an error.
- Credentials in `.env` only. Provide `.env.example`.
- Request timeouts, basic rate limiting, CORS restricted to the extension's origin, and a way to cancel or ignore results for a Short the user has already left.
- Cache analyses by video ID for the session.

## 11. Privacy and permissions

- The user turns ScrollMate on explicitly. Show a clear active or inactive state.
- Request the smallest set of permissions and host access, limited to YouTube Shorts.
- Stop all processing the moment it's disabled.
- Don't collect any other browsing data.
- Don't store screenshots, audio or transcripts.
- Explain in the popover exactly what is sent to the AI provider (up to three downscaled frames per Short, plus the title and visible captions).
- "Clear memory" empties the ring buffer, the queue and the decision log.

## 12. Demo mode (build this early, the pitch depends on it)

The stage demo must not depend on venue Wi-Fi or YouTube's layout on the day.

- A toggle in the popover, clearly labelled **DEMO** on the character while active.
- Three predefined Short observations: (1) a successful cake tutorial, (2) a failed cake, (3) a stunning professional cake.
- Simulated navigation between them on a timer or a key press.
- It must show ScrollMate: remembering the earlier Shorts, finding the connection, producing a relevant joke, **waiting** for the right moment (visibly: thinking, then the bubble at the end of Short 3), optionally speaking, then returning to idle.
- Provide both: canned reactions that work offline, and a "live LLM" variant using the same predefined observations.

## 13. Evaluation (so the pitch has a number)

Add a small script, `eval/timing_eval.py` or `.ts`, that replays recorded or scripted viewing sessions through two policies:
- **Naive:** deliver every reaction the moment it's generated.
- **ScrollMate:** the timing engine from section 8.

Report for each policy:
- reactions delivered
- reactions delivered while the video was mid-playback (interruptions)
- reactions about a Short no longer on screen (stale)
- duplicates

Also include `eval/rating_sheet.md`, a one-page form for 5 human testers to rate each reaction as funny, fine or annoying.

Target headline for the pitch, filled with real numbers: *"Reacting to everything interrupted the video N times in 20 Shorts. ScrollMate interrupted it M times, and testers rated X% of its reactions funny."*

## 14. Success criteria

1. The extension loads on YouTube Shorts.
2. The animated character appears on the page.
3. It detects navigation between Shorts.
4. It analyses whatever video information is accessible, with fallbacks.
5. It remembers the last three Shorts.
6. Reactions are specific to what was seen, not generic.
7. The timing engine works and logs its decisions.
8. It can speak without constantly interrupting.
9. The user can mute, disable, move it and clear memory.
10. Demo mode works offline.
11. The evaluation script runs and prints both policies' numbers.

## 15. Build order

Build in phases. After each phase, make sure it compiles and explain exactly how to test it.

1. Extension scaffold, Shadow DOM injection, animated character, dragging, popover.
2. Shorts navigation and playback detection, logged to the console.
3. **Demo mode with canned observations and reactions.** (Moved early so the pitch is safe from the start.)
4. Backend, frame capture with fallbacks, structured analysis, three-Short memory.
5. Reaction generation and personalities.
6. Timing engine, decision log, speech.
7. Evaluation script, privacy controls, error handling, polish.

Don't build a dashboard. Don't add a database. Use one model plus deterministic scheduling, not multiple agents. When a platform limit makes something unreliable, implement the documented fallback and say so in the README rather than pretending it works.

## 16. Deliverables

- Full source code
- `manifest.json`
- Backend service
- `.env.example`
- README: setup, loading the unpacked extension in Chrome Developer Mode (`chrome://extensions`, Developer mode on, "Load unpacked", choose the build folder), testing on real Shorts, using demo mode, running the evaluation, known limitations and next steps

Prioritise a working, enjoyable prototype over complexity.

**Start with Phase 1 now.**