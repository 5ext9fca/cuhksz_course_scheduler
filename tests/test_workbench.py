"""Exercise both data entry points and the lecture/tutorial rules through the real UI."""
from dataclasses import asdict
from cuhksz_sis_scraper import parse_requirements
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from playwright.sync_api import expect, sync_playwright


def section(number, label, day, choices=None, minimum=0):
    lecture = label.endswith("-LEC")
    result = dict(class_number=str(number), section=label, status="开放", session="正常",
                  kind="lecture" if lecture else "tutorial", component=label.split("-")[-1],
                  meetings=[{"days_and_times": f"星期{day} 09:00 - 10:00"}])
    if lecture:
        result["tutorial_selection"] = ({"status":"unknown"} if choices is None else
            dict(status="known", class_numbers=choices, min_select=minimum, max_select=int(bool(choices))))
    return result


def sample():
    return {"schema_version":2, "term":"2620", "subjects":["ECE"], "offerings":[{
        "course":dict(course_code="ECE 1234",title="教学班测试",enrollment_requirements=asdict(parse_requirements(""))),
        "plan_matches":[{"requirement":"必修","page":2}],
        "sections":[section(1,"L01-LEC","一",["10"],1),section(2,"L02-LEC","一",["11"]),
                    section(3,"L03-LEC","一"),section(4,"L04-LEC","一",[]),
                    section(10,"T01-TUT","二"),section(11,"T02-TUT","三")]
    }]}


@contextmanager
def server(root):
    proc = subprocess.Popen([sys.executable, "-c", "from course_planner.server import main; main()",
                             "--config-dir", str(root), "--data-dir", str(root), "--no-open", "--port", "0"],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        url = proc.stdout.readline().strip().split()[-1]
        yield url
    finally:
        proc.terminate()
        proc.wait(timeout=15)
        proc.stdout.close()


class WorkbenchTests(unittest.TestCase):
    def test_pairing_and_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp, server(Path(tmp)) as url, sync_playwright() as pw:
            browser = pw.chromium.launch(channel=os.getenv("SIS_TEST_CHANNEL","chrome"))
            page = browser.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url)
            expect(page.locator("#catalogCount")).to_have_text("尚未导入")
            self.assertEqual(page.request.post(url+"api/jobs", data={"term":"2620"}).status,403)
            self.assertEqual(page.request.post(url+"api/jobs", data={"term":"oops"},
                                                headers={"X-Planner-Request":"1"}).status,422)

            data = sample()
            history = {"schema_version":2,"terms":[{"courses":[dict(course_code="ece1234", status="已注册", grade="P")]}]}
            def upload(field, report):
                page.locator("#"+field).set_input_files(dict(name="input.json", mimeType="application/json",
                                                           buffer=json.dumps(report).encode()))
            upload("historyFile",history)
            upload("file",data)
            expect(page.locator(".course")).to_have_count(0)
            page.uncheck("#hidePassed")
            page.click(".course")
            count = page.locator("#result")
            expect(count).to_have_text("6 个可行方案")
            outcomes=set()
            for rank in range(1,7):
                if rank>1:
                    page.click("#next")
                expect(page.locator("#rank")).to_have_value(str(rank))
                outcomes.add(tuple(node.split(" · ")[-1] for node in
                                   page.locator(".details .detailitem strong").all_text_contents()))
            self.assertEqual(outcomes,{("L01-LEC","T01-TUT"),("L02-LEC","T02-TUT"),
                                       ("L02-LEC",),("L03-LEC","T01-TUT"),("L03-LEC","T02-TUT"),
                                       ("L04-LEC",)})
            page.click("#filters > summary")
            page.check("#verifiedOnly")
            expect(count).to_have_text("4 个可行方案")
            page.click("#pins summary")
            page.locator("#pins select").first.select_option("1")
            expect(count).to_have_text("1 个可行方案")
            self.assertEqual(page.locator("#pins select").last.locator("option").count(),2)
            page.locator("#pins select").last.select_option("10")
            page.locator("#pins select").first.select_option("2")
            expect(count).to_have_text("2 个可行方案")
            expect(page.locator("#pins select").last).to_have_value("")
            # The server loads exactly the same JSON after a refresh or restart.
            (Path(tmp)/"current.json").write_text(json.dumps({
                "updated_at":"2026-11-20T00:00:00Z","catalog":data,"history":history}))
            page.reload()
            expect(page.locator("#catalogMeta")).to_contain_text("SIS 同步目录")
            page.uncheck("#hidePassed")
            page.click(".course")
            expect(count).to_have_text("6 个可行方案")
            # Unrecognized class references must leave the usable catalog intact.
            data["offerings"][0]["sections"][0]["tutorial_selection"]["class_numbers"]=["404"]
            upload("file",data)
            expect(page.locator("#importError")).to_contain_text("引用")
            expect(count).to_have_text("6 个可行方案")
            for version in ({}, {"schema_version":1}):
                for field, old in (("file", {"courses":[]}), ("historyFile",{"terms":[]})):
                    upload(field, {**version, **old})
                    expect(page.locator("#importError")).to_contain_text("重新导出")
                    expect(count).to_have_text("6 个可行方案")
            self.assertEqual(errors,[])
            browser.close()

    def test_registration_requirements_follow_choices_and_history(self):
        with tempfile.TemporaryDirectory() as tmp, server(Path(tmp)) as url, sync_playwright() as pw:
            browser = pw.chromium.launch(channel=os.getenv("SIS_TEST_CHANNEL","chrome"))
            page = browser.new_page()
            page.goto(url)
            data = sample()
            main = data["offerings"][0]["course"]
            main["enrollment_requirements"] = asdict(parse_requirements("Pre-requisite: (MAT1001 or MAT1002) and CSC1001; Co-requisite: PHY1001; Exclusion: BIO1001"))
            data["offerings"].append(dict(course=dict(course_code="PHY 1001", title="Physics", enrollment_requirements=asdict(parse_requirements(""))),
                                        sections=[section(20,"L01-LEC","五")]))
            def upload(field, value):
                page.locator("#"+field).set_input_files(dict(name="input.json",mimeType="application/json",
                                                            buffer=json.dumps(value).encode()))
            def history(codes):
                upload("historyFile", {"schema_version":2,"terms":[{"courses":[dict(course_code=c,title=c,status="已注册",grade="P")
                                                            for c in codes]}]})
            upload("file",data)
            page.locator(".course").first.click()
            expect(page.locator("#eligibility")).to_contain_text("待核实")
            history(["MAT1002","CSC1001"])
            expect(page.locator("#result")).to_have_text("0 个可行方案")
            expect(page.locator("#eligibility")).to_contain_text("Co-requisite")
            page.locator(".course").last.click()
            expect(page.locator("#result")).to_have_text("6 个可行方案")
            history(["MAT1002","CSC1001","BIO1001"])
            expect(page.locator("#result")).to_have_text("0 个可行方案")
            expect(page.locator("#eligibility")).to_contain_text("Exclusion")
            browser.close()

    def test_scraper_v2_models(self):
        from dataclasses import asdict
        from cuhksz_sis_scraper import Course, Lecture, Meeting, Tutorial, TutorialSelection, parse_requirements
        from cuhksz_sis_scraper.models import validate_catalog
        lecture = Lecture("101", "L01", "讲演", [Meeting("星期一 09:00 - 10:00",None,None,None)],
                          tutorial_selection=TutorialSelection(1,1,["202"]))
        tutorials = [Tutorial(str(n), "T"+str(n), "指导教学", [Meeting("星期二 09:00 - 10:00",None,None,None)])
                     for n in (201,202)]
        course = Course("ACT 3011", "Accounting", parse_requirements("先修要求：CSC1001 及 (MAT1001 或 MAT1002)"))
        catalog = dict(schema_version=2,term="2620",subjects=["ACT"],offerings=[
            dict(course=asdict(course),sections=[asdict(s) for s in [lecture,*tutorials]])])
        validate_catalog(catalog)
        with tempfile.TemporaryDirectory() as tmp, server(Path(tmp)) as url, sync_playwright() as pw:
            browser=pw.chromium.launch(channel=os.getenv("SIS_TEST_CHANNEL","chrome"))
            page=browser.new_page()
            page.goto(url)
            def upload(field, value):
                page.locator("#"+field).set_input_files(dict(name="v2.json",mimeType="application/json",
                                                            buffer=json.dumps(value).encode()))
            upload("file",catalog)
            page.click(".course")
            def history(codes):
                upload("historyFile",dict(schema_version=2,terms=[dict(courses=[
                    dict(course_code=c,title=c,status="已注册",grade="P") for c in codes])]))
            history(["CSC1001"])
            expect(page.locator("#result")).to_have_text("0 个可行方案")
            history(["CSC1001","MAT1002"])
            expect(page.locator("#result")).to_have_text("1 个可行方案")
            expect(page.locator(".details")).to_contain_text("T202")
            browser.close()
