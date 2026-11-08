"""Session journal: what Mochi and the child went through together today. RAM only, text and labels only.

Gives the model real things to connect to ("you laughed at the other puppy too!") and keeps its lines varied:
- compact():  a short "today so far" block that goes with every comment request (~300 tokens)
- recall():   fuller detail, for the recall_history tool
- next_move(): which kind of line to write next (own_feeling / connect / question), rotated so it never repeats
"""
from __future__ import annotations

from collections import Counter, OrderedDict
from dataclasses import dataclass, field

MAX_SHORTS = 20
COMPACT_SHORTS = 8
MOVES = ("own_feeling", "invite", "connect", "question")
FEELING_WORDS = {
    "happy": "smiled", "laughing": "laughed", "surprised": "was surprised", "sad": "looked a bit sad",
    "scared": "looked a bit scared", "confused": "looked puzzled", "disgusted": "went 'eww'", "angry": "looked annoyed",
}


@dataclass
class Entry:
    video_id: str
    title: str = ""
    topic: str = "unknown"
    happening: str = ""
    outcome: str | None = None
    feelings: list[tuple[float | None, str]] = field(default_factory=list)  # (video second, label), no repeats in a row
    lines: list[str] = field(default_factory=list)  # what Mochi actually showed
    moves: list[str] = field(default_factory=list)
    seconds_watched: float = 0
    skipped: bool = False

    def feeling_labels(self) -> list[str]:
        return [f for _, f in self.feelings]


class Journal:
    def __init__(self) -> None:
        self.entries: OrderedDict[str, Entry] = OrderedDict()
        self.current: str | None = None
        self.move_history: list[str] = []  # moves of delivered lines, newest last
        self.proposed: OrderedDict[str, str] = OrderedDict()  # line text -> move it was written with

    # ---------- filling it ----------
    def _get(self, video_id: str) -> Entry:
        e = self.entries.get(video_id)
        if e is None:
            e = self.entries[video_id] = Entry(video_id)
            while len(self.entries) > MAX_SHORTS:
                self.entries.popitem(last=False)
        return e

    def start(self, video_id: str, title: str = "") -> None:
        e = self._get(video_id)
        e.title = title[:120] or e.title
        self.entries.move_to_end(video_id)
        self.current = video_id

    def update(self, video_id: str, topic: str = "", happening: str = "", outcome: str | None = None, title: str = "") -> None:
        e = self._get(video_id)
        if topic and topic != "unknown":
            e.topic = topic[:40]
        e.happening = happening[:200] or e.happening
        e.outcome = (outcome or "")[:120] or e.outcome
        e.title = title[:120] or e.title
        self.current = self.current or video_id

    def add_feeling(self, video_id: str | None, feeling: str | None, at: float | None = None) -> None:
        video_id = video_id or self.current
        if not video_id or not feeling or feeling not in FEELING_WORDS:
            return
        e = self._get(video_id)
        if not e.feelings or e.feelings[-1][1] != feeling:
            e.feelings = (e.feelings + [(at, feeling)])[-8:]

    def note_proposed(self, text: str, move: str | None) -> None:
        """Remember which move a line was written with, so a 'shown' event without one still counts."""
        if text and move in MOVES:
            self.proposed[text] = move
            while len(self.proposed) > 60:
                self.proposed.popitem(last=False)

    def add_line(self, video_id: str | None, text: str, move: str | None = None) -> None:
        video_id = video_id or self.current
        if not video_id or not text:
            return
        move = move or self.proposed.get(text)
        e = self._get(video_id)
        e.lines = (e.lines + [text[:160]])[-6:]
        if move in MOVES:
            e.moves.append(move)
            self.move_history = (self.move_history + [move])[-12:]

    def left(self, video_id: str, seconds_watched: float = 0, skipped: bool = False) -> None:
        if video_id in self.entries:
            e = self.entries[video_id]
            e.seconds_watched = max(e.seconds_watched, float(seconds_watched or 0))
            e.skipped = bool(skipped)

    def clear(self) -> None:
        self.entries.clear()
        self.current = None
        self.move_history = []
        self.proposed.clear()

    # ---------- reading it ----------
    def earlier(self, video_id: str) -> list[Entry]:
        return [e for vid, e in self.entries.items() if vid != video_id]

    def patterns(self, video_id: str | None = None) -> list[str]:
        """Plain facts computed in code (never guessed by the model)."""
        out: list[str] = []
        by_topic: Counter[tuple[str, str]] = Counter()
        for e in self.entries.values():
            for f in set(e.feeling_labels()):
                if e.topic != "unknown":
                    by_topic[(f, e.topic)] += 1
        for (f, topic), n in by_topic.most_common(3):
            if n >= 2:
                out.append(f"the child {FEELING_WORDS[f]} during {n} {topic} Shorts")
        firsts = [e.feeling_labels()[0] for e in self.entries.values() if e.feelings]
        if len(firsts) >= 3 and len(set(firsts[-3:])) == 1:
            out.append(f"the child {FEELING_WORDS[firsts[-1]]} in the last 3 Shorts in a row")
        skipped = sum(1 for e in list(self.entries.values())[-5:] if e.skipped)
        if skipped >= 3:
            out.append(f"the child skipped {skipped} of the last 5 Shorts quickly")
        return out

    def has_connectable(self, video_id: str) -> bool:
        if any(e.topic != "unknown" or e.feelings for e in self.earlier(video_id)):
            return True
        cur = self.entries.get(video_id)
        return bool(cur and len(cur.feelings) >= 2)

    def recent_lines(self, n: int = 8) -> list[str]:
        lines = [line for e in self.entries.values() for line in e.lines]
        return lines[-n:]

    def used_openings(self, n: int = 6) -> list[str]:
        """First two words of recent lines ("I'm curious", "Does the"): the next line must not start like these."""
        seen: list[str] = []
        for line in self.recent_lines(n):
            words = line.replace("—", " ").split()[:2]
            opening = " ".join(w.strip(",.!?;:") for w in words).strip()
            if opening and opening.lower() not in (s.lower() for s in seen):
                seen.append(opening)
        return seen

    def compact(self, video_id: str) -> str:
        rows = []
        for e in self.earlier(video_id)[-COMPACT_SHORTS:]:
            what = e.happening or e.title or e.topic
            felt = ", ".join(FEELING_WORDS[f] for f in e.feeling_labels()[:3]) or "no clear feeling"
            said = f' You said "{e.lines[-1]}".' if e.lines else ""
            skip = " (skipped)" if e.skipped else ""
            rows.append(f"- {e.topic}: {what[:90].rstrip('. ')}{skip}. Child {felt}.{said}")
        cur = self.entries.get(video_id)
        parts = ["Earlier Shorts today (oldest first):\n" + ("\n".join(rows) if rows else "- (none yet)")]
        pats = self.patterns(video_id)
        if pats:
            parts.append("Patterns: " + "; ".join(pats) + ".")
        if cur and cur.feelings:
            parts.append("This Short so far, the child: " + " -> ".join(FEELING_WORDS[f] for f in cur.feeling_labels()) + ".")
        return "\n".join(parts)

    def recall(self, topic: str | None = None, feeling: str | None = None, n: int = 5) -> list[dict]:
        n = max(1, min(int(n or 5), 8))
        found = []
        for e in reversed(list(self.entries.values())):
            if topic and topic.lower() not in (e.topic + " " + e.title + " " + e.happening).lower():
                continue
            if feeling and feeling not in e.feeling_labels():
                continue
            found.append({
                "topic": e.topic, "title": e.title, "happening": e.happening, "outcome": e.outcome,
                "child_felt": e.feeling_labels(), "mochi_said": e.lines, "skipped": e.skipped,
                "seconds_watched": round(e.seconds_watched),
            })
            if len(found) >= n:
                break
        return found

    # ---------- variety ----------
    def next_move(self, video_id: str, has_feeling: bool) -> str:
        """Least recently used of the moves that make sense now; never the same twice in a row,
        a question at most once in every 3 lines, 'connect' only with something real to connect to."""
        hist = self.move_history
        options = ["own_feeling", "invite"]
        if self.has_connectable(video_id):
            options.append("connect")
        if has_feeling and "question" not in hist[-2:]:
            options.append("question")
        if hist and len(options) > 1:
            options = [o for o in options if o != hist[-1]] or options

        def last_used(move: str) -> int:
            for i in range(len(hist) - 1, -1, -1):
                if hist[i] == move:
                    return i
            return -1

        return min(options, key=lambda m: (last_used(m), MOVES.index(m)))


journal = Journal()
