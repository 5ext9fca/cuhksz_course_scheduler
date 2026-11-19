"""Child process with the scraper's own config directory as its working directory."""
from dataclasses import replace
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import sys

from playwright.sync_api import Error as BrowserError
from cuhksz_sis_scraper import Profile, ScheduleError, export_catalog, export_courses, save_courses

from cuhksz_sis_scraper.models import validate_catalog

from .jobs import Refresh


def emit(phase, message, **details):
    print(json.dumps(dict(phase=phase, message=message, **details), ensure_ascii=False), flush=True)


def refresh(data: Path, pending: Path, request: Refresh, profile_file: str | None = None,
            browser_file: str | None = None):
    profile = Profile.load(profile_file)
    if request.scope == "all":
        profile = replace(profile, major="", stream="", cohort=None)
    elif request.scope == "custom":
        profile = replace(profile, major=request.major, stream=request.stream, cohort=request.cohort)
    # Stable checkpoint per query/account; never include usernames in file names.
    identity = [profile.username, str(Path.cwd()), profile.major, profile.cohort, profile.stream,
                request.term, sorted(request.subjects)]
    key = sha256(json.dumps(identity).encode()).hexdigest()
    staging = data / "work" / key
    staging.mkdir(mode=0o700, parents=True, exist_ok=True)
    completed = set()
    total = None

    def catalog_status(message):
        nonlocal total
        start = re.fullmatch(r"查询学科 ([A-Z]+)（(\d+) 个学科）", message)
        if start:
            total = int(start[2])
        done = re.match(r"^([A-Z]+)\s+(?:已从断点恢复|\d+ 门课程)", message)
        if done:
            completed.add(done[1])
        emit("catalog", message, completed=len(completed), total=total)

    emit("catalog", "正在准备专业修读计划和开课目录")
    catalog = export_catalog(staging / "catalog.json", profile=profile, term=request.term,
                             subjects=request.subjects or None, restart=request.restart, browser_file=browser_file,
                             on_status=catalog_status)
    emit("history", "正在读取个人修读记录")
    history = export_courses(staging / "completed.json", profile=profile, browser_file=browser_file,
                             on_status=lambda msg: emit("history", msg))
    validate_catalog(catalog)
    if (catalog.get("term") != request.term or history.get("schema_version") != 2
            or not isinstance(history.get("terms"), list)):
        raise ScheduleError("scraper 返回了不完整的目录或修读记录")
    save_courses(dict(version=pending.stem, updated_at=datetime.now(timezone.utc).isoformat(),
                      catalog=catalog, history=history), pending)
    # Keep only checkpoints on failure. Successful data now lives in the snapshot.
    (staging / "catalog.json").unlink(missing_ok=True)
    (staging / "completed.json").unlink(missing_ok=True)


def main():
    try:
        refresh(Path(sys.argv[1]), Path(sys.argv[2]), Refresh.model_validate_json(sys.argv[3]),
                sys.argv[4] or None, sys.argv[5] or None)
    except KeyboardInterrupt:
        sys.exit(130)
    except ScheduleError as exc:
        emit("error", str(exc))
        sys.exit(1)
    except BrowserError as exc:
        text = str(exc)
        operation = re.match(r"[A-Za-z]+\.[a-z_]+", text)
        step = operation.group() if operation else "Playwright"
        if "ProcessSingleton" in text or "SingletonLock" in text:
            message = "浏览器配置正被其他进程占用。请在另一次 SIS 查询结束后重试。"
        elif "closed" in text.lower():
            message = "浏览器或 SIS 页面已关闭。请确认项目 Chrome 窗口可用后重试。"
        else:
            message = "请检查学校页面和浏览器配置后重试。"
        emit("error", f"{step}：{message}")
        sys.exit(1)
    except Exception as exc:
        emit("error", f"刷新失败（{type(exc).__name__}）。请检查浏览器配置、学校连接和本地数据目录。")
        sys.exit(1)


if __name__ == "__main__":
    main()
