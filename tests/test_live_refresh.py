"""Opt-in acceptance against SIS using a fresh HTTP session and isolated snapshot."""
import asyncio
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from course_planner.jobs import Jobs, Refresh


@unittest.skipUnless(os.getenv("SIS_ACCEPT_PROFILE"), "需要指定 SIS_ACCEPT_PROFILE")
class LiveRefreshTests(unittest.IsolatedAsyncioTestCase):
    async def test_http_refresh(self):
        profile = Path(os.environ["SIS_ACCEPT_PROFILE"]).resolve()
        request = Refresh(term=os.environ["SIS_ACCEPT_TERM"], scope="all",
                          subjects=[os.environ["SIS_ACCEPT_SUBJECT"]])
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root / "browser.toml"
            config.write_text("headless = true\n")
            jobs = Jobs(root, root, profile, config)
            job = jobs.start(request)
            try:
                await asyncio.wait_for(asyncio.shield(jobs.task), timeout=300)
            finally:
                await jobs.cancel()
            self.assertEqual(job.status, "success", job.message)
            snapshot = json.loads((root / "current.json").read_text())
            self.assertEqual(snapshot["version"], job.id)
            self.assertEqual(snapshot["catalog"]["term"], request.term)
            self.assertEqual(snapshot["catalog"]["subjects"], request.subjects)
            self.assertTrue(snapshot["catalog"]["offerings"])
            self.assertTrue(snapshot["history"]["terms"])
