"""Local HTTP entry point. Only packaged UI assets and the published snapshot are served."""
import argparse
import os
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
import socket
import webbrowser

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from filelock import FileLock
from cuhksz_sis_scraper import Profile, ScheduleError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .jobs import Jobs, Refresh


def create_app(config_dir: Path, data_dir: Path, *, profile_file: Path | None = None,
               browser_file: Path | None = None):
    jobs = Jobs(config_dir.resolve(), data_dir.resolve(), profile_file, browser_file)
    current = jobs.data / "current.json"

    @asynccontextmanager
    async def lifespan(app):
        jobs.data.mkdir(mode=0o700, parents=True, exist_ok=True)
        with FileLock(jobs.data / "server.lock", timeout=0):
            try:
                yield
            finally:
                await jobs.cancel()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])

    @app.middleware("http")
    async def local_api(request: Request, call_next):
        if request.url.path.startswith("/api/"):
            if request.method not in ("GET", "HEAD"):
                origin = request.headers.get("origin")
                if (request.headers.get("x-planner-request") != "1"
                        or (origin and origin != str(request.base_url).rstrip("/"))):
                    return JSONResponse({"detail": "仅接受本地工作台请求"}, status_code=403)
            response = await call_next(request)
            response.headers["Cache-Control"] = "no-store"
            return response
        return await call_next(request)

    @app.get("/api/state")
    async def state():
        try:
            version = str(current.stat().st_mtime_ns)
        except FileNotFoundError:
            version = None
        return {"version": version, "job": asdict(jobs.job) if jobs.job else None}

    @app.get("/api/profile")
    def profile():
        path = jobs.profile_file or jobs.config / "profile.toml"
        try:
            p = Profile.load(path) if jobs.profile_file or path.exists() else Profile()
        except ScheduleError as exc:
            raise HTTPException(400, str(exc)) from exc
        return {"major": p.major, "stream": p.stream, "cohort": p.cohort}

    @app.get("/api/snapshot")
    def snapshot():
        try:
            return Response(current.read_bytes(), media_type="application/json")
        except FileNotFoundError:
            raise HTTPException(404, "尚未刷新") from None

    @app.post("/api/jobs", status_code=202)
    async def start(request: Refresh):
        try:
            return asdict(jobs.start(request))
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/jobs/{job_id}/cancel")
    async def cancel(job_id: str):
        job = jobs.job
        if not job or job.id != job_id:
            raise HTTPException(404, "任务不存在")
        await jobs.cancel()
        return asdict(job)

    app.mount("/", StaticFiles(directory=Path(__file__).with_name("static"), html=True))
    return app


def main():
    cwd = Path.cwd()
    parser = argparse.ArgumentParser(description="在本机打开港中深课程规划器")
    parser.add_argument("--config-dir", type=Path, default=cwd, help="scraper 配置目录")
    parser.add_argument("--profile", type=Path, help="指定用户配置文件")
    parser.add_argument("--browser-config", type=Path, help="指定浏览器配置文件")
    parser.add_argument("--data-dir", type=Path, default=cwd / ".planner", help="快照与断点目录")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true", help="仅启动服务")
    args = parser.parse_args()
    if not args.config_dir.is_dir():
        parser.error("配置目录不存在")
    if not 0 <= args.port <= 65535:
        parser.error("端口需在 0–65535 范围内")
    app = create_app(args.config_dir, args.data_dir, profile_file=args.profile, browser_file=args.browser_config)
    server = uvicorn.Server(uvicorn.Config(app, access_log=False, proxy_headers=False))
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        if os.name == "posix":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", args.port))
        except OSError as exc:
            parser.error(f"无法绑定端口：{exc}")
        url = f"http://127.0.0.1:{sock.getsockname()[1]}/"
        print(f"排课工作台 {url}", flush=True)
        sock.listen()
        if not args.no_open:
            webbrowser.open(url)
        server.run(sockets=[sock])
    if not server.started:
        raise SystemExit(1)
