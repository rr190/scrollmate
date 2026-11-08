"""Websocket lifecycle and duplex protocol checks. No provider requests or recordings."""
import asyncio
import base64
import os
import unittest
from contextlib import asynccontextmanager
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from google.genai import types

from app import main, talk_live

ORIGIN = "chrome-extension://" + "a" * 32
HELLO = {"type": "start", "context": {"requestId": "session-1", "videoId": "reel-1", "title": "Cake", "personality": "chill"}}


class FakeLive:
    def __init__(self):
        self.messages = asyncio.Queue()
        self.audio = []
        self.answers = []
        self.closed = False
        self.tool = False

    async def send_realtime_input(self, *, audio):
        self.audio.append(audio)
        if self.tool:
            await self.messages.put(types.LiveServerMessage(tool_call=types.LiveServerToolCall(
                function_calls=[types.FunctionCall(id="tool-1", name="current_reel", args={})])))
            return
        if len(self.audio) == 2:
            await self.messages.put(types.LiveServerMessage(server_content=types.LiveServerContent(interrupted=True)))
        await self.messages.put(types.LiveServerMessage(server_content=types.LiveServerContent(
            input_transcription=types.Transcription(text="Hello"))))
        for word in ["Hi", " buddy!"]:
            await self.messages.put(types.LiveServerMessage(server_content=types.LiveServerContent(
                output_transcription=types.Transcription(text=word),
                model_turn=types.Content(parts=[types.Part(inline_data=types.Blob(data=b"\0\1" * 200, mime_type="audio/pcm;rate=24000"))]))))
        await self.messages.put(types.LiveServerMessage(server_content=types.LiveServerContent(turn_complete=True)))

    async def send_tool_response(self, *, function_responses):
        self.answers.extend(function_responses)
        await self.messages.put(types.LiveServerMessage(server_content=types.LiveServerContent(
            output_transcription=types.Transcription(text=function_responses[0].response["video_summary"]), turn_complete=True)))

    async def receive(self):
        while True:
            message = await self.messages.get()
            yield message
            if message.server_content and message.server_content.turn_complete:
                return


class LiveTalkTests(unittest.TestCase):
    def setUp(self):
        self.sessions = []
        self.tool = False

        @asynccontextmanager
        async def provider(_context):
            session = FakeLive(); session.tool = self.tool
            self.sessions.append(session)
            try:
                yield session
            finally:
                session.closed = True

        self.patches = [patch.object(talk_live, "connect_provider", provider),
                        patch.object(talk_live.config, "EXTENSION_ORIGIN", ""),
                        patch.dict(os.environ, {"GEMINI_API_KEY": "test-only"})]
        for item in self.patches:
            item.start(); self.addCleanup(item.stop)
        self.client = TestClient(main.app)

    def connect(self, origin=ORIGIN):
        return self.client.websocket_connect("/scrollmate/talk/live", headers={"origin": origin})

    def ready(self, ws):
        ws.send_json(HELLO)
        self.assertEqual(ws.receive_json(), {"type": "ready"})

    def read_turn(self, ws):
        messages = []
        while True:
            message = ws.receive_json(); messages.append(message)
            if message["type"] in {"complete", "error"}:
                return messages

    def test_streams_pcm_incremental_captions_and_interrupts_in_the_same_session(self):
        with patch.object(main.feed, "publish") as publish:
            with self.connect() as ws:
                self.ready(ws)
                ws.send_bytes(b"\x01\0" * 640)
                first = self.read_turn(ws)
                self.assertEqual([x["text"] for x in first if x["type"] == "caption" and x["role"] == "assistant"], ["Hi", "Hi buddy!"])
                audio = [x for x in first if x["type"] == "audio"]
                self.assertEqual(len(audio), 2)
                self.assertEqual(audio[0]["generation"], 1)
                self.assertEqual(len(base64.b64decode(audio[0]["data"])), 400)
                ws.send_bytes(b"\x02\0" * 640)
                second = self.read_turn(ws)
                self.assertEqual(second[0], {"type": "interrupt", "generation": 1})
                self.assertTrue(any(x["type"] == "audio" and x["generation"] == 2 for x in second))
                self.assertEqual(len(self.sessions), 1)
                self.assertEqual(self.sessions[0].audio[0].mime_type, "audio/pcm;rate=16000")
            publish.assert_not_called()
        self.assertTrue(self.sessions[0].closed)

    def test_reel_updates_are_read_as_tool_data_without_starting_an_extra_reply(self):
        self.tool = True
        with self.connect() as ws:
            self.ready(ws)
            ws.send_json({"type": "context", "context": {**HELLO["context"], "videoId": "reel-2", "videoSummary": "A dog carries a stick."}})
            ws.send_json({"type": "ping"})
            self.assertEqual(ws.receive_json(), {"type": "pong"})
            self.assertFalse(self.sessions[0].audio)
            ws.send_bytes(b"\0\0" * 640)
            turn = self.read_turn(ws)
            self.assertEqual(self.sessions[0].answers[0].response["video_id"], "reel-2")
            self.assertTrue(any(x.get("text") == "A dog carries a stick." for x in turn))

    def test_invalid_or_oversized_pcm_stops_and_releases_provider(self):
        for frame in [b"\0", b"\0" * (talk_live.MAX_FRAME_BYTES + 2)]:
            with self.connect() as ws:
                self.ready(ws); ws.send_bytes(frame)
                self.assertEqual(ws.receive_json()["type"], "error")
            self.assertTrue(self.sessions[-1].closed)

    def test_visible_and_selected_comments_update_inside_the_same_conversation(self):
        self.tool = True
        with self.connect() as ws:
            self.ready(ws)
            for selected, comments_open, visible in [
                ("The first comment", True, ["The first comment", "The second comment"]),
                ("The second comment", True, ["The second comment", "A newly loaded comment"]),
                ("The second comment", False, []),
            ]:
                ws.send_json({"type": "context", "context": {**HELLO["context"], "selectedComment": selected,
                              "commentsOpen": comments_open, "visibleComments": visible}})
                ws.send_bytes(b"\0\0" * 640); self.read_turn(ws)
                result = self.sessions[0].answers[-1].response
                self.assertEqual(result["selected_comment"], selected)
                self.assertEqual(result["comments_open"], comments_open)
                self.assertEqual(result["visible_comments"], visible)
            self.assertEqual(len(self.sessions), 1)

    def test_comment_context_limits_are_validated_before_opening_the_provider(self):
        for visible in [["comment"] * 7, ["x" * 501]]:
            with self.connect() as ws:
                ws.send_json({"type": "start", "context": {**HELLO["context"], "visibleComments": visible}})
                self.assertEqual(ws.receive_json()["type"], "error")
        self.assertFalse(self.sessions)

    def test_context_cannot_change_the_session_identity(self):
        with self.connect() as ws:
            self.ready(ws)
            ws.send_json({"type": "context", "context": {**HELLO["context"], "requestId": "other"}})
            self.assertEqual(ws.receive_json()["type"], "error")

    def test_web_pages_cannot_connect_using_the_backend_key(self):
        for origin in ["https://www.youtube.com", "http://localhost:3000", ""]:
            with self.assertRaises(WebSocketDisconnect) as error:
                with self.connect(origin):
                    pass
            self.assertEqual(error.exception.code, 1008)
        self.assertFalse(self.sessions)

    def test_missing_key_has_a_specific_recovery_message(self):
        with patch.dict(os.environ, {"GEMINI_API_KEY": ""}), self.connect() as ws:
            ws.send_json(HELLO)
            self.assertIn("GEMINI_API_KEY", ws.receive_json()["error"])
        self.assertFalse(self.sessions)

    def test_two_sessions_are_isolated_and_a_third_is_rejected(self):
        with self.connect() as first, self.connect() as second:
            self.ready(first); self.ready(second)
            with self.assertRaises(WebSocketDisconnect) as error:
                with self.connect():
                    pass
            self.assertEqual(error.exception.code, 1013)
            first.send_bytes(b"\x01\0" * 640); self.read_turn(first)
            self.assertEqual(len(self.sessions[0].audio), 1)
            self.assertEqual(len(self.sessions[1].audio), 0)
        self.assertTrue(all(session.closed for session in self.sessions))
        self.assertFalse(talk_live._connections)

    def test_live_configuration_enables_native_turn_detection_and_voice(self):
        cfg = talk_live.live_config(talk_live.LiveContext.model_validate(HELLO["context"]))
        self.assertFalse(cfg.realtime_input_config.automatic_activity_detection.disabled)
        self.assertEqual(cfg.realtime_input_config.activity_handling, "START_OF_ACTIVITY_INTERRUPTS")
        self.assertIsNotNone(cfg.input_audio_transcription)
        self.assertIsNotNone(cfg.output_audio_transcription)
        self.assertIn("current_reel", cfg.system_instruction)
        self.assertIn("English only", cfg.system_instruction)
        self.assertIn("selected_comment", cfg.system_instruction)
        self.assertIn("visible_comments", cfg.system_instruction)


if __name__ == "__main__":
    unittest.main()
