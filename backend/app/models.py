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

Mood = Literal["funny", "wholesome", "impressive", "fail", "informative", "dramatic", "calm", "unclear"]
UnderstandingLevel = Literal["visual_and_text", "visual_only", "text_only", "none"]
Personality = Literal["witty", "hype", "chill"]
Frequency = Literal["rare", "balanced", "chatty"]
Timing = Literal["now", "after_video", "next_gap"]


class Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ---------- analysis ----------


class Event(Camel):
    timestamp: float | None = None
    description: str = Field(max_length=200)
    confidence: float = Field(ge=0, le=1)  # model estimate, not calibrated


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


class ReactRequest(Camel):
    memory: list[MemoryItem] = Field(default_factory=list, max_length=3)
    personality: Personality = "witty"
    frequency: Frequency = "balanced"
    current_video_id: str


class ReactionCandidate(Camel):
    text: str = Field(max_length=160)
    importance: float = Field(ge=0, le=1)  # model estimate, not calibrated
    target_video_id: str
    preferred_timing: Timing = "after_video"
    expires_after_seconds: int = 20
    requires_quiet_moment: bool = True
    is_callback: bool = False


class ReactResponse(Camel):
    reactions: list[ReactionCandidate] = Field(default_factory=list)


class LLMReaction(BaseModel):
    text: str = Field(description="ONE short sentence, max ~18 words, specific to what was observed.")
    importance: float = Field(ge=0, le=1, description="0.9+ great callback or genuinely surprising; 0.5-0.7 decent; <0.4 filler")
    is_callback: bool = Field(False, description="true if it connects the current Short to earlier remembered Shorts")
    preferred_timing: Timing = Field("after_video", description="'now' only if it must land during a specific moment; usually 'after_video'")
    requires_quiet_moment: bool = True


class LLMReactions(BaseModel):
    reactions: list[LLMReaction] = Field(default_factory=list, max_length=2, description="0-2 reactions. Empty is fine.")
