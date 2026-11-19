"""Run a single SIS refresh outside the server's event loop."""
import asyncio
from dataclasses import dataclass
import json
import os
from pathlib import Path
import signal
import sys
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Refresh(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    term: str = Field(pattern=r"^[0-9]{4}$")
    scope: Literal["profile", "custom", "all"] = "profile"
    major: str = Field(default="", max_length=120)
    cohort: int | None = Field(default=None, ge=1000, le=9999, strict=True)
    stream: str = Field(default="", max_length=150)
    subjects: list[str] = Field(default_factory=list, max_length=100)
    restart: bool = False

    @model_validator(mode="after")
    def valid_scope(self):
        if self.scope == "custom" and not self.major:
            raise ValueError("请填写专业")
        if self.scope != "custom" and (self.major or self.stream or self.cohort is not None):
            raise ValueError("自定义专业字段仅适用于指定专业")
        self.subjects = list(dict.fromkeys(s.strip().upper() for s in self.subjects))
        if any(not s.isascii() or not s.isalpha() or len(s) > 12 for s in self.subjects):
            raise ValueError("学科需为英文字母")
        return self


@dataclass
class Job:
    id: str
    term: str
    status: str = "running"
    message: str = "正在启动 SIS 刷新"
    phase: str = "starting"
    completed: int = 0
    total: int | None = None


class Jobs:
    def __init__(self, config: Path, data: Path, profile_file: Path | None = None,
                 browser_file: Path | None = None):
        self.profile_file = profile_file.expanduser().resolve() if profile_file else None
        self.browser_file = browser_file.expanduser().resolve() if browser_file else None
        self.config = config
        self.data = data
        self.job: Job | None = None
        self.task: asyncio.Task | None = None
        self.process: asyncio.subprocess.Process | None = None

    @property
    def busy(self):
        return self.task is not None and not self.task.done()

    def start(self, request: Refresh) -> Job:
        if self.busy:
            raise ValueError("已有刷新任务正在运行")
        self.job = Job(uuid4().hex, request.term)
        self.task = asyncio.create_task(self.run(self.job, request))
        return self.job

    async def run(self, job: Job, request: Refresh):
        pending = self.data / f"{job.id}.pending"
        try:
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "course_planner.worker", str(self.data), str(pending),
                request.model_dump_json(), str(self.profile_file or ""), str(self.browser_file or ""),
                cwd=self.config,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                start_new_session=(os.name == "posix"),
            )
            self.process = proc
            if job.status == "cancelling":
                self.interrupt(proc)
            assert proc.stdout is not None
            async for line in proc.stdout:
                if job.status == "cancelling":
                    continue
                event = json.loads(line)
                job.message = event["message"]
                job.phase = event["phase"]
                job.completed = event.get("completed", 0)
                job.total = event.get("total")
            code = await proc.wait()
            if job.status == "cancelling":
                job.status, job.message = "cancelled", "刷新已取消"
            elif code == 0 and pending.is_file():
                os.replace(pending, self.data / "current.json")
                job.status, job.message = "success", "目录与修读记录已更新"
            else:
                job.status = "failed"
                if job.phase != "error":
                    job.message = "抓取进程退出。请核对 scraper 配置后重试。"
        except (OSError, ValueError, KeyError):
            job.status, job.message = "failed", "刷新进程或本地数据读写失败"
        finally:
            if self.process and self.process.returncode is None:
                self.force_stop(self.process)
                await self.process.wait()
            self.process = None
            pending.unlink(missing_ok=True)

    @staticmethod
    def interrupt(proc):
        if proc.returncode is None:
            try:
                if os.name == "posix":
                    proc.send_signal(signal.SIGINT)
                else:
                    proc.terminate()
            except ProcessLookupError:
                pass

    @staticmethod
    def force_stop(proc):
        try:
            if os.name == "posix":
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
        except ProcessLookupError:
            pass

    async def cancel(self):
        if not self.busy:
            return
        self.job.status, self.job.message = "cancelling", "正在关闭本次抓取"
        if self.process:
            self.interrupt(self.process)
        task = self.task
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=8)
        except TimeoutError:
            if self.process and self.process.returncode is None:
                self.force_stop(self.process)
            await task
