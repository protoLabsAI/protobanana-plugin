"""Uploads use the media store and join the same history/lineage as renders."""
import asyncio

import httpx
import pytest

from test_history import PNG_1x1, _app
from test_history import env as history_env

env = history_env


def test_upload_history_and_edit_parent(env, monkeypatch):
    async def render(state):
        return PNG_1x1

    monkeypatch.setattr(env.mod.jobs, "_dispatch", render)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app(env.reg)),
                                    base_url="http://test") as client:
            response = await client.post("/api/plugins/protobanana/uploads?filename=phone.png",
                                         content=PNG_1x1, headers={"content-type": "image/png"})
            assert response.status_code == 200
            rec = response.json()
            assert rec["media_id"] == "fake-media-1"
            assert rec["parent_id"] is None
            assert rec["source"] == rec["op"] == "upload"
            assert rec["params"] == {"filename": "phone.png"}
            page = (await client.get("/api/plugins/protobanana/history")).json()
            assert page["records"] == [rec]
            assert env.mod.history.image_bytes(rec["media_id"]) == PNG_1x1
            assert env.reg.saved_media[0][2] == {
                "source": "upload", "op": "upload", "parent_id": None, "filename": "phone.png",
            }
            assert env.mod.jobs.recent() == []
            job = await client.post("/api/plugins/protobanana/jobs", json={
                "op": "edit", "parent_id": rec["media_id"],
                "params": {"image": rec["media_id"], "prompt": "blue"},
            })
            await env.mod.jobs._jobs[job.json()["job_id"]]["_task"]
            records = (await client.get("/api/plugins/protobanana/history")).json()["records"]
            assert records[0]["parent_id"] == rec["media_id"]
            assert records[0]["op"] == "edit"
    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["media", "history"])
def test_save_failure_is_reported(env, monkeypatch, failure):
    if failure == "media":
        def fail(*args):
            raise OSError("disk full")
        monkeypatch.setattr(env.reg, "save_media", fail)
    else:
        monkeypatch.setattr(env.mod.history, "_dir", None)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app(env.reg)),
                                    base_url="http://test") as client:
            response = await client.post("/api/plugins/protobanana/uploads", content=PNG_1x1,
                                         headers={"content-type": "image/png"})
            assert response.status_code == 500
    asyncio.run(scenario())


@pytest.mark.parametrize("mime,raw,status", [
    ("text/plain", b"hello", 415), ("image/png", b"", 400),
    ("image/png", b"x" * (20 * 1024 * 1024 + 1), 413),
])
def test_upload_validation(env, mime, raw, status):
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app(env.reg)),
                                    base_url="http://test") as client:
            response = await client.post("/api/plugins/protobanana/uploads", content=raw,
                                         headers={"content-type": mime})
            assert response.status_code == status
            assert env.mod.history.read()["records"] == []
    asyncio.run(scenario())
