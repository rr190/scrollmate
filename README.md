# ScrollMate (ESu)

A small cartoon buddy that **watches YouTube Shorts with a child** (aged 5–9), reacting in real time like a friend on the sofa. It's built for kids spending long, lonely hours in hospital.

Built at WHACK 2026 for the incident.io "real-time AI" brief.

> **The idea:** the AI *proposes* things to say; our own deterministic code decides **whether and when** to say them. We didn't build an AI that talks more. We built one that knows *when* to talk.

## What it does

| Feature | What the child sees |
|---|---|
| 🎬 **Reacts to Shorts** | Its face changes with the video, and it says a short line at a natural moment (a loop, a pause, the end), never over the action. |
| 💬 **Reacts to comments** | Hover over a comment and it hops beside it with its own take. It never posts anything. |
| 📷 **Notices your feelings** | It laughs along when you laugh and asks kindly when you look sad. The webcam is read **on the device**: no images leave the computer. |
| 🧠 **Remembers** | "You giggled at the puppy earlier!" It connects Shorts across the session. Memory lasts for the session only. |
| 🎙️ **Talk to it** | Tap the mic for a real-time voice chat. |
| 🐱 **Avatars** | Mochi, ScrollMate, cat, bunny, panda, shiba. Different looks, same personality. |

One click on the toolbar icon turns it completely on or off.

## How it works

```
 YouTube Short ──► frames, title, captions ──► AI (vision + text, two providers raced)
 Webcam ─► on-device face reading ─► "laughing"     │
                                                    ▼
                                   proposed line + how interesting it is
                                                    │
               session memory + kid-safety filter ──┤
                                                    ▼
             ┌────────── Deterministic timing engine (plain code) ──────────┐
             │ Speak now · Wait · Save for later · Stay silent                │
             │ e.g. wait while the video plays, the child laughs or swipes    │
             └────────────────────────────────────────────────────────────────┘
                                                    ▼
                                      ESu's face, bubble or voice
```

- **The AI understands** what's happening in the video and suggests a line.
- **The code decides:** dull, repeated, unsafe or out-of-date lines are dropped, and the rest wait for a good moment. Every decision is logged with its reason.
- **Measured:** in a scripted simulation, saying lines as soon as they arrive talked over the video **9.3** times per session; ScrollMate did it **0.1** times, while still remembering earlier Shorts.

## Run it

**Backend** (Python 3.12):

```bash
cd backend
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # macOS/Linux: .venv/bin/pip
cp .env.example .env            # add your API keys here (never in the extension)
.venv/Scripts/python -m uvicorn app.main:app --port 8000   # macOS/Linux: .venv/bin/python
```

With no keys, it runs in **mock mode** so you can still try the pipeline.

**Extension:**

```bash
cd extension
npm install
npm run setup:mediapipe         # one time: on-device face model
npm run build                   # outputs extension/dist
```

In `chrome://extensions`, turn on **Developer mode** and click **Load unpacked** → `extension/dist`. Then open any YouTube Short.

## Behind the scenes

| Page | What it shows |
|---|---|
| `localhost:8000/ui` | Live feed of what the AI saw, what it proposed, and each timing decision. Settings too: models, child's age, Demo mode, the "when to react" threshold. |
| `localhost:8000/ui/eval` | **Knowing when to talk**: the timing evaluation charts. |
| `localhost:8000/ui/face` | Webcam test for the on-device face reading. |

**Demo mode** (in `/ui`): makes sure every Short gets a comment and that a remembered line appears early. Use it on stage.

## Project layout

```
extension/   Chrome extension (TypeScript, React)
  src/shared/timing.ts   ← the timing engine
backend/     FastAPI + LiteLLM: AI calls, memory, safety, /ui
eval/        timing evaluation (npm run eval in extension/)
```

**Privacy:** the buddy is off until switched on. Webcam frames never leave the device. Comment text is never stored. The memory of Shorts and feelings lasts only for the session (only settings like avatar and on/off are saved).

**More detail:** [IMPLEMENTATION.md](IMPLEMENTATION.md) has the full technical notes: models, endpoints, tests, limitations.
