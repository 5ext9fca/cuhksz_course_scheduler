"""Atomic publication, cancellation, profile handling and progress regressions."""
import asyncio
from contextlib import contextmanager
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from cuhksz_sis_scraper import Profile, ScheduleError

from course_planner.jobs import Jobs, Refresh
from course_planner.worker import refresh


class JobsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.jobs = Jobs(self.root, self.root)
        self.current = self.root / "current.json"
        self.current.write_text('{"old":true}')

    @contextmanager
    def child(self, script):
        spawn = asyncio.create_subprocess_exec

        def run(executable, module_flag, module, data, pending, request, profile_file, browser_file, **kwargs):
            return spawn(executable, "-c", script, pending, **kwargs)

        with patch("course_planner.jobs.asyncio.create_subprocess_exec", run):
            yield

    async def test_publish_and_failure(self):
        with self.child("import sys,pathlib; pathlib.Path(sys.argv[1]).write_text('{}')"):
            job = self.jobs.start(Refresh(term="2620"))
            with self.assertRaises(ValueError):
                self.jobs.start(Refresh(term="2610"))
            await self.jobs.task
        self.assertEqual(job.status, "success")
        self.assertEqual(self.current.read_text(), "{}")
        with self.child("import sys;sys.exit(1)"):
            job = self.jobs.start(Refresh(term="2620"))
            await self.jobs.task
        self.assertEqual(job.status, "failed")
        self.assertEqual(self.current.read_text(), "{}")

    async def test_cancel_keeps_published_snapshot_and_progress(self):
        with self.child("""
import json,time
print(json.dumps(dict(phase='catalog',message='ECE',completed=1,total=2)),flush=True)
time.sleep(60)
"""):
            job = self.jobs.start(Refresh(term="2620"))
            async with asyncio.timeout(5):
                while job.completed == 0:
                    await asyncio.sleep(.01)
            self.assertEqual(job.total, 2)
            await self.jobs.cancel()
        self.assertEqual(job.status, "cancelled")
        self.assertEqual(self.current.read_text(), '{"old":true}')
        self.assertFalse(list(self.root.glob("*.pending")))


class WorkerTests(unittest.TestCase):
    def test_scope_progress_and_paired_publication(self):
        profile = Profile("test-user", "test-password", "Original", 2024, "old")
        events = []
        def fetch_catalog(path, *, profile, term, subjects, on_status, restart, browser_file):
            self.assertEqual((profile.major, profile.cohort, profile.stream), ("ECE", 2025, "CE"))
            self.assertEqual(subjects, ["ECE"])
            self.assertTrue(restart)
            on_status("查询学科 ECE（1 个学科）")
            on_status("ECE  2 门课程，3 个教学班")
            return {"schema_version": 2, "term": term, "subjects": [], "offerings": []}

        req = Refresh(term="2620", scope="custom", major="ECE", stream="CE", cohort=2025,
                      subjects=[" ece ", "ECE"], restart=True)
        with TemporaryDirectory() as tmp, patch.object(Profile, "load", return_value=profile), \
             patch("course_planner.worker.emit", side_effect=lambda *a, **k: events.append((a,k))), \
             patch("course_planner.worker.export_catalog", side_effect=fetch_catalog), \
             patch("course_planner.worker.export_courses", return_value={"schema_version":2,"terms":[]}) as history:
            pending = Path(tmp) / "x.pending"
            refresh(Path(tmp), pending, req)
            self.assertEqual(json.loads(pending.read_text())["catalog"]["term"], "2620")
            self.assertEqual(events[2][1], {"completed":1,"total":1})
            self.assertNotIn("test-password", str(events))
            history.side_effect = ScheduleError("test")
            with self.assertRaises(ScheduleError):
                refresh(Path(tmp), Path(tmp)/"failed.pending", req)
            self.assertFalse((Path(tmp)/"failed.pending").exists())

    def test_explicit_files_shared_by_preview_and_both_exports(self):
        from course_planner.server import create_app
        from fastapi import HTTPException

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            profile = root / "personal.toml"
            browser = root / "chrome.toml"
            profile.write_text('username="example"\npassword="dummy"\nmajor="ECE"\ncohort=2025\n')
            app = create_app(root, root, profile_file=profile, browser_file=browser)
            preview = next(r.endpoint for r in app.routes if r.path == "/api/profile")
            self.assertEqual(preview(), {"major":"ECE", "cohort":2025, "stream":""})
            catalog = dict(schema_version=2, term="2620", subjects=[], offerings=[])
            with patch("course_planner.worker.export_catalog", return_value=catalog) as cat, \
                 patch("course_planner.worker.export_courses", return_value={"schema_version":2,"terms":[]}) as hist, \
                 patch("course_planner.worker.emit"):
                refresh(root, root/"job.pending", Refresh(term="2620"), str(profile), str(browser))
                for export in (cat, hist):
                    self.assertEqual(export.call_args.kwargs["profile"], Profile.load(profile))
                    self.assertEqual(export.call_args.kwargs["browser_file"], str(browser))
            for invalid in ('username="example"', 'term="2620"', 'cohort="2025"'):
                profile.write_text(invalid)
                with self.assertRaises(HTTPException):
                    preview()
            profile.unlink()
            with self.assertRaises(HTTPException):
                preview()
