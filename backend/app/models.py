"""Pydantic v2 models.

API models use camelCase on the wire (the extension is TypeScript).
LLM-facing models are plain snake_case and kept small, so Instructor's schema is simple.

All `confidence` / `importance` numbers are the model's own estimates,
NOT calibrated probabilities. Treat them as rough rankings only.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from .emotions import EMOTION_IDS

Mood = Literal["funny", "wholesome", "impressive", "fail", "informative", "dramatic", "calm", "unclear"]
UnderstandingLevel = Literal["visual_and_text", "visual_only", "text_only", "none"]
Personality = Literal["witty", "hype", "chill"]
# How the CHILD watching seems to feel (a label from the on-device webcam model, never an image).
UserExpression = Literal["happy", "laughing", "surprised", "sad", "scared", "confused", "disgusted", "angry"]
Frequency = Literal["rare", "balanced", "chatty"]
Timing = Literal["now", "after_video", "next_gap"]
# How a friend watching beside you would *feel* at a moment (drives the character's face).
Emotion = Literal[EMOTION_IDS]  # the catalog in app/emotions.py is the single source of truth
# What kind of moment a Short is building towards (predicted from the title, confirmed by frames).
MomentType = Literal["attempt", "reveal", "pov", "surprise", "tutorial", "continuation", "reaction", "other"]
Change = Literal["none", "minor", "major"]


class Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ---------- analysis ----------


class Event(Camel):
    timestamp: float | None = None
    description: str = Field(max_length=200)
    confidence: float = Field(ge=0, le=1)  # model estimate, not calibrated
    emotion: Emotion | None = None


class EmotionCue(Camel):
    """A facial reaction for the character, timed to a moment in the video (seconds)."""

    t: float
    emotion: Emotion
    intensity: float = Field(ge=0, le=1)


class Analysis(Camel):
    video_id: str
    topic: str
    summary: str
    events: list[Event] = Field(default_factory=list, max_length=5)
    outcome: str | None = None
    mood: Mood = "unclear"
    themes: list[str] = Field(default_factory=list, max_length=5)
    understanding_level: UnderstandingLevel
    confidence: float = Field(ge=0, le=1)  # model estimate, not calibrated
    cues: list[EmotionCue] = Field(default_factory=list, max_length=4)


class AnalyseRequest(Camel):
    video_id: str = Field(max_length=64)
    frames: list[str] = Field(default_factory=list, max_length=3)  # base64 JPEG, never stored
    frame_times: list[float] = Field(default_factory=list, max_length=3)
    composite: bool = False  # one image = several frames side by side (saves image tokens)
    title: str = Field(default="", max_length=300)
    channel: str = Field(default="", max_length=120)
    captions: list[str] = Field(default_factory=list, max_length=30)


class LLMEvent(BaseModel):
    timestamp: float | None = Field(None, description="Approximate second in the video, from the frame times. null if unknown.")
    description: str = Field(description="Something actually visible or said. Never invented.")
    confidence: float = Field(ge=0, le=1)
    emotion: Emotion | None = Field(
        None, description="How a friend watching would react at this exact moment, or null if it is unremarkable."
    )


class LLMAnalysis(BaseModel):
    topic: str = Field(description="1-3 words, lowercase, e.g. 'baking', 'dog tricks'")
    summary: str = Field(description="One factual sentence about what happens.")
    events: list[LLMEvent] = Field(default_factory=list, max_length=4)
    outcome: str | None = Field(None, description="How it ends, if visible. null if unclear.")
    mood: Mood
    themes: list[str] = Field(default_factory=list, max_length=4, description="lowercase single words, e.g. cake, fail, dog")
    confidence: float = Field(ge=0, le=1, description="How sure you are about this understanding overall.")


# ---------- reactions ----------


class MemoryItem(Camel):
    video_id: str
    topic: str = "unknown"
    summary: str = ""
    events: list[Event] = Field(default_factory=list, max_length=5)
    outcome: str | None = None
    mood: str = "unclear"
    themes: list[str] = Field(default_factory=list)
    seconds_watched: float = 0
    skipped: bool = False
    running_joke: str | None = None


class ReactRequest(Camel):
    memory: list[MemoryItem] = Field(default_factory=list, max_length=3)
    personality: Personality = "witty"
    frequency: Frequency = "balanced"
    current_video_id: str
    viewer_feeling: UserExpression | None = None  # how the child seems to feel right now (label only)


class ReactionCandidate(Camel):
    text: str = Field(max_length=160)
    importance: float = Field(ge=0, le=1)  # model estimate, not calibrated
    target_video_id: str
    preferred_timing: Timing = "after_video"
    expires_after_seconds: int = 20
    requires_quiet_moment: bool = True
    is_callback: bool = False
    move: str | None = None  # own_feeling / connect / question (variety; recorded when the line is shown)


class ReactResponse(Camel):
    reactions: list[ReactionCandidate] = Field(default_factory=list)


class LLMReaction(BaseModel):
    text: str = Field(description="One brief conversational reaction, usually 2-10 words, max 15. Fragments are welcome; use observed facts only.")
    importance: float = Field(ge=0, le=1, description="0.9+ great callback or genuinely surprising; 0.5-0.7 decent; <0.4 filler")
    is_callback: bool = Field(False, description="true if it connects the current Short to earlier remembered Shorts")
    preferred_timing: Timing = Field("after_video", description="'now' only if it must land during a specific moment; usually 'after_video'")
    requires_quiet_moment: bool = True


class LLMReactions(BaseModel):
    reactions: list[LLMReaction] = Field(default_factory=list, max_length=2, description="0-2 reactions. Empty is fine.")


# ---------- captions (fast, text-only step) ----------


class CaptionRequest(Camel):
    video_id: str = Field(max_length=64)
    lines: list[str] = Field(min_length=1, max_length=12)  # NEW caption lines since the last step
    title: str = Field(default="", max_length=300)
    channel: str = Field(default="", max_length=120)
    current_time: float | None = None  # video seconds when the lines were read
    memory: list[MemoryItem] = Field(default_factory=list, max_length=3)
    personality: Personality = "witty"
    frequency: Frequency = "balanced"
    viewer_feeling: UserExpression | None = None  # how the child seems to feel right now (label only)


class CaptionResponse(Camel):
    emotion: Emotion | None = None  # face to show right now (silent, never interrupts)
    reactions: list[ReactionCandidate] = Field(default_factory=list)


class LLMCaptionReaction(BaseModel):
    emotion: Emotion | None = Field(None, description="How a friend would react to what was just SAID, or null if it is ordinary.")
    reaction: LLMReaction | None = Field(None, description="One line ONLY if the words are genuinely funny or surprising. Usually null.")


# ---------- hovered, visible comments (text only) ----------
class PreviousComment(Camel):
    """A comment ScrollMate already reacted to on this Short, and what it said (context for the next one)."""

    text: str = Field(max_length=300)
    reaction: str | None = Field(default=None, max_length=160)
    emotion: str | None = Field(default=None, max_length=20)


class CommentRequest(Camel):
    request_id: str = Field(min_length=1, max_length=100)
    video_id: str = Field(min_length=1, max_length=64)
    comment_id: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=1200)
    title: str = Field(default="", max_length=300)
    video_summary: str = Field(default="", max_length=600)
    # Earlier comments on THIS Short (oldest first) and ScrollMate's own replies. RAM only on both sides.
    previous_comments: list[PreviousComment] = Field(default_factory=list, max_length=5)
    personality: Personality = "witty"
    frequency: Frequency = "balanced"


class CommentReactionCandidate(ReactionCandidate):
    target_comment_id: str
    comment_request_id: str


class CommentResponse(Camel):
    request_id: str
    target_comment_id: str
    emotion: Emotion | None = None
    reactions: list[CommentReactionCandidate] = Field(default_factory=list, max_length=1)


class LLMCommentReaction(BaseModel):
    emotion: Emotion | None = Field(None, description="A considerate response to the comment, or null for ordinary or unclear text.")
    reaction: LLMReaction | None = Field(None, description="One brief response to the selected comment, or null. Never invent video events or attack a commenter.")


# ---------- feelings: Mochi kindly notices the child's expression (label only, never an image) ----------

class FeelingRequest(Camel):
    video_id: str = Field(min_length=1, max_length=64)
    expression: UserExpression
    title: str = Field(default="", max_length=300)
    video_summary: str = Field(default="", max_length=600)
    personality: Personality = "witty"


class FeelingResponse(Camel):
    line: str | None = None
    emotion: Emotion | None = None  # Mochi's face while it says the line
    source: Literal["ai", "fallback"] = "fallback"
    ms: int = 0
    move: str | None = None


class LLMFeelingLine(BaseModel):
    line: str | None = Field(None, description="One short, kind question or note to a child about how they seem to feel, or null.")
    emotion: Emotion | None = Field(None, description="Mochi's face while saying it: usually the same feeling, gentle for sad or scared.")


# ---------- swipe step: instant prediction from the title ----------


class SwipeRequest(Camel):
    video_id: str = Field(max_length=64)
    title: str = Field(default="", max_length=300)
    channel: str = Field(default="", max_length=120)
    memory: list[MemoryItem] = Field(default_factory=list, max_length=3)
    personality: Personality = "witty"
    frequency: Frequency = "balanced"


class LLMSwipe(BaseModel):
    moment_type: MomentType = Field(description="What kind of moment this Short is likely building towards, from the title alone")
    emotion: Emotion | None = Field(None, description="A NON-specific first reaction (curious, surprised...). null if the title says nothing")
    look_for: str = Field("", description="Under 12 words: what to watch for in the frames, e.g. 'whether the cake survives'")


class SwipeResponse(Camel):
    moment_type: MomentType = "other"
    emotion: Emotion | None = None
    level: int = 0  # 0 = nothing, 1 = face only (the swipe step never speaks)
    look_for: str = ""
    demo_mode: bool = False  # tells the extension to use its demo rules


# ---------- observe step: one frame at a time, evolving belief ----------


class Belief(Camel):
    """What ScrollMate currently thinks is happening in one Short. Text only, RAM only."""

    video_id: str
    title: str = ""
    moment_type: MomentType = "other"
    topic: str = "unknown"
    happening: str = ""
    expected_next: str = ""
    outcome: str | None = None
    mood: Mood = "unclear"
    themes: list[str] = Field(default_factory=list)
    events: list[Event] = Field(default_factory=list)
    emotion_arc: list[str] = Field(default_factory=list)
    running_joke: str | None = None
    confidence: float = 0.0  # model estimate, not calibrated
    frames_seen: int = 0
    version: int = 0
    comments_proposed: int = 0
    comment_checked: bool = False  # one text-only comment check per Short, RAM only


class ObserveRequest(Camel):
    video_id: str = Field(max_length=64)
    frame: str = ""  # one base64 JPEG (empty = text only); used for one call, never stored
    frame_time: float = 0
    duration: float = 0
    frame_index: int = Field(1, ge=1, le=12)
    max_frames: int = Field(12, ge=1, le=12)  # client's upper bound; the server's setting decides
    title: str = Field(default="", max_length=300)
    channel: str = Field(default="", max_length=120)
    captions: list[str] = Field(default_factory=list, max_length=20)
    memory: list[MemoryItem] = Field(default_factory=list, max_length=3)
    personality: Personality = "witty"
    frequency: Frequency = "balanced"
    viewer_feeling: UserExpression | None = None  # how the child seems to feel right now (label only)


class LLMObserve(BaseModel):
    seen_now: str = Field(description="5-15 words: what is visible in THIS frame. Never invented.")
    topic: str = Field(description="1-3 words, lowercase")
    happening: str = Field(description="One factual sentence: what is happening in the Short so far")
    expected_next: str = Field("", description="What will probably happen next, or empty")
    moment_type: MomentType
    outcome: str | None = Field(None, description="How it ends, only if already visible")
    mood: Mood
    themes: list[str] = Field(default_factory=list, max_length=4, description="lowercase single words")
    confidence: float = Field(ge=0, le=1, description="How sure you are about the whole picture")
    change: Change = Field(description="How much THIS frame changed your understanding vs the belief so far")
    emotion: Emotion | None = Field(None, description="How a friend reacts to THIS frame right now, or null")
    level: int = Field(0, ge=0, le=3, description="0 nothing, 1 face only, 2 short comment, 3 strong moment")
    line: str | None = Field(None, description="One brief conversational reaction, usually 2-10 words, max 15. Fragments are welcome; only if level >= 2 and worth saying")
    line_is_callback: bool = Field(False, description="true if the line links to earlier remembered Shorts")
    running_joke: str | None = Field(None, description="A short running joke across the remembered Shorts, if one genuinely exists")
    next_look_at: float | None = Field(None, description="Video second when the next interesting moment is likely, or null if you have seen enough")


class ObserveResponse(Camel):
    belief: Belief
    emotion: Emotion | None = None
    level: int = 0
    change: Change = "none"
    reactions: list[ReactionCandidate] = Field(default_factory=list)
    next_capture_at: float | None = None
    final: bool = False
    error: str | None = None
    max_frames: int = 3  # effective limit for this Short (from the /ui setting)
    demo_mode: bool = False  # tells the extension to use its demo rules
    record: MemoryItem  # what goes into the 3-Short memory if this Short ends now
