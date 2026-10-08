"""The post-interview 4-week plan: diagnosis, week layout, LLM enrichment, agent wiring."""
from __future__ import annotations

import copy
from unittest.mock import MagicMock, patch

import pytest

from app.agents.interview_plan import build_interview_plan, diagnose, outline
from tests.fixtures_interview import REPORT, evidence


def _plan(ev=None, llm=None, **kw):
    return build_interview_plan(ev or evidence(), "Improve interview readiness", llm=llm, log=lambda m: None, **kw)


def _all_tasks(plan):
    return [t for w in plan["weeklyPlan"] for d in w["days"] for t in d["tasks"]]


class FakeLLM:
    """Stands in for LLMClient; returns a canned answer per call."""

    def __init__(self, answers):
        self._answers = list(answers)
        self._provider = object()
        self.prompts: list[str] = []

    def _call_json(self, prompt, max_tokens=None, temperature=0.7):
        self.prompts.append(prompt)
        answer = self._answers.pop(0) if self._answers else {}
        if isinstance(answer, Exception):
            raise answer
        return copy.deepcopy(answer)


ENRICHED = {
    "objective": "By the end of week 1 you will explain clustered vs non-clustered indexes and tune a slow join.",
    "whyThisWeek": "Databases averaged 34/100 and you confused the two kinds of index in Q4.",
    "studyNotes": [
        {"topic": "Clustered index defines row order", "learn": ["B-tree leaf pages hold the rows.", "One physical order"],
         "tryThis": "Create a table with a primary key and inspect its physical order."},
        {"topic": "Only one clustered index per table", "learn": ["Why only one physical order exists"], "tryThis": ""},
    ],
    "practiceQuestions": [
        {"question": "Would a composite index on (status, created_at) help this query? See https://evil.example",
         "goodAnswerCovers": ["Leftmost prefix"]},
        {"question": "How would you confirm a query uses your new index?", "goodAnswerCovers": ["EXPLAIN ANALYZE", "Index scan vs seq scan"]},
    ],
    "measurableOutcome": "You can read an EXPLAIN plan and name the index it uses.",
}


# ── Diagnosis ─────────────────────────────────────────────────────────────────

class TestDiagnosis:
    def test_areas_are_ranked_weakest_first_with_their_evidence(self):
        d = diagnose(evidence())
        assert [a["name"] for a in d["areas"]] == ["Databases", "System Design", "Machine Learning"]
        db = d["areas"][0]
        assert db["score"] == 34  # mean of 38 and 30
        assert db["turns"][0]["turn"] == 4  # worst answer first
        assert "Reading the EXPLAIN plan" in db["missed"]

    def test_introduction_is_kept_apart_from_technical_topics(self):
        d = diagnose(evidence())
        assert d["intro"]["turn"] == 1
        assert all(a["name"] != "Introduction" for a in d["areas"])

    def test_measured_delivery_problems_become_issues_with_targets(self):
        issues = {i["key"]: i for i in diagnose(evidence())["delivery"]["issues"]}
        assert issues["fillers"]["baseline"] == 2.8 and issues["fillers"]["final"] == 1.0
        assert issues["pace_fast"]["baseline"] == 168 and issues["pace_fast"]["final"] == 150
        assert issues["pauses"]["baseline"] == 0.8
        assert issues["latency"]["baseline"] == 6.2
        assert "clarity" not in issues  # 71/100 is fine

    def test_clean_delivery_has_no_issues(self):
        report = copy.deepcopy(REPORT)
        report.update(averageWpm=135, totalFillerWords=2, fillerWordBreakdown={"um": 2}, longPauses=0,
                      averageResponseLatencySec=2.1, fluencyScore=85, clarityScore=88)
        assert diagnose(evidence(report))["delivery"]["issues"] == []

    def test_missing_metrics_do_not_break_the_diagnosis(self):
        report = {"overallScore": 40, "technicalScore": 35, "communicationScore": 55,
                  "turns": [{"turn": 1, "question": "Q?", "category": "Databases", "technicalScore": 35}]}
        d = diagnose(evidence(report, resume=None))
        assert d["areas"][0]["name"] == "Databases" and d["delivery"]["wpm"] is None


# ── Week layout ───────────────────────────────────────────────────────────────

class TestOutline:
    def test_weakest_topics_first_then_resume_projects_then_simulation(self):
        kinds = [(c["kind"], c.get("area", {}).get("name") if c.get("area") else None) for c in outline(diagnose(evidence()))]
        assert kinds == [("topic", "Databases"), ("topic", "System Design"), ("projects", None), ("simulation", None)]

    def test_without_a_resume_the_delivery_week_takes_the_slot(self):
        kinds = [c["kind"] for c in outline(diagnose(evidence(resume=None)))]
        assert kinds == ["topic", "topic", "delivery", "simulation"]

    def test_topics_that_do_not_fit_are_folded_into_the_last_topic_week(self):
        weeks = outline(diagnose(evidence()))
        assert [a["name"] for a in weeks[1]["also"]] == ["Machine Learning"]

    def test_a_strong_interview_gets_depth_weeks_not_gap_weeks(self):
        report = copy.deepcopy(REPORT)
        for t in report["turns"]:
            t["technicalScore"] = 88
            t["pointsMissed"] = []
        report.update(technicalScore=88, communicationScore=86, overallScore=87, averageWpm=135,
                      totalFillerWords=1, fillerWordBreakdown={"um": 1}, longPauses=0, averageResponseLatencySec=2.0,
                      fluencyScore=85, clarityScore=88)
        kinds = [c["kind"] for c in outline(diagnose(evidence(report, resume=None)))]
        assert "topic" not in kinds and kinds[-1] == "simulation"
        assert kinds.count("depth") >= 2

    def test_every_measured_delivery_problem_gets_a_drill(self):
        drills = {c["drill"]["key"] for c in outline(diagnose(evidence()))}
        assert drills == {"fillers", "pace_fast", "pauses", "latency"}

    def test_delivery_wins_a_tie_with_a_topic(self):
        report = copy.deepcopy(REPORT)
        report["communicationScore"] = 64  # same as System Design
        kinds = [c["kind"] for c in outline(diagnose(evidence(report, resume=None)))]
        assert kinds == ["topic", "delivery", "topic", "simulation"]


def _with_category(category, score=30, missed=("Identifies the specific problem addressed", "Describes their own role")):
    report = copy.deepcopy(REPORT)
    report["turns"].append({
        "turn": 6, "question": "What problem did your attendance tracker solve, and what did you build?",
        "difficulty": "MEDIUM", "category": category, "technicalScore": score, "communicationScore": 50,
        "overallScore": 36, "wpm": 160, "fillerCount": 2, "pauseCount": 0, "responseLatencySec": 4,
        "feedback": "Vague; no result.", "strengths": "", "weaknesses": "Vague; no result.",
        "pointsCovered": [], "pointsMissed": list(missed), "questionSource": "follow_up",
    })
    return report


class TestTopicStyles:
    def test_project_questions_join_the_resume_projects_week(self):
        weeks = outline(diagnose(evidence(_with_category("Project Details"))))
        projects = next(c for c in weeks if c["kind"] == "projects")
        assert [a["name"] for a in projects["areas"]] == ["Project Details"]
        assert all(c.get("area", {}) is None or c["area"]["name"] != "Project Details" for c in weeks if c.get("area"))
        plan = _plan(evidence(_with_category("Project Details")))
        week = next(w for w in plan["weeklyPlan"] if w["kind"] == "projects")
        assert any(q.get("from", "").startswith("Your interview, Q6") for q in week["practiceQuestions"])

    def test_project_questions_without_a_resume_get_story_practice_not_study_notes(self):
        plan = _plan(evidence(_with_category("Project Details"), resume=None))
        week = next(w for w in plan["weeklyPlan"] if w["focus"] == "Project Details")
        texts = " ".join(t["text"] for d in week["days"] for t in d["tasks"])
        assert week["title"] == "Make your project answers concrete"
        assert "Write a 6-line story" in texts and "Study “" not in texts
        assert any("as opposed to the team" in q["question"] for q in week["practiceQuestions"])
        assert not any("under heavy load" in q["question"] for q in week["practiceQuestions"])

    def test_behavioural_topics_use_star(self):
        plan = _plan(evidence(_with_category("Teamwork", missed=("Uses a specific example",)), resume=None))
        week = next(w for w in plan["weeklyPlan"] if w["focus"] == "Teamwork")
        texts = " ".join(t["text"] for d in week["days"] for t in d["tasks"])
        assert "STAR" in week["title"] and "four STAR stories" in texts

    def test_story_weeks_ask_the_llm_for_no_study_notes(self):
        llm = FakeLLM([ENRICHED] * 3)
        _plan(evidence(_with_category("Project Details", score=10), resume=None), llm=llm)
        story_prompt = next(p for p in llm.prompts if "Make your project answers concrete" in p)
        assert "return an empty studyNotes list" in story_prompt


def test_unanswered_topics_aim_for_at_least_fifty():
    report = copy.deepcopy(REPORT)
    for t in report["turns"][2:4]:
        t["technicalScore"] = 0
    plan = _plan(evidence(report))
    targets = {t["metric"]: t for t in plan["weeklyPlan"][0]["targets"]}
    assert targets["Databases answer score"] == {"metric": "Databases answer score", "baseline": "0/100", "target": "≥ 50/100"}


# ── The plan ──────────────────────────────────────────────────────────────────

class TestPlan:
    def test_four_full_weeks_of_daily_work(self):
        plan = _plan()
        assert plan["durationWeeks"] == 4 and [w["week"] for w in plan["weeklyPlan"]] == [1, 2, 3, 4]
        for w in plan["weeklyPlan"]:
            assert [d["day"] for d in w["days"]] == [1, 2, 3, 4, 5]
            assert all(d["tasks"] and d["minutes"] >= 30 for d in w["days"])
            assert w["targets"] and w["checkpoint"]["passIf"] and w["practiceQuestions"] and w["resources"]
            assert 4 <= w["estimatedHours"] <= 8
        assert plan["weeklyPlan"][-1]["kind"] == "simulation"

    def test_task_ids_are_unique_and_counted(self):
        plan = _plan()
        ids = [t["id"] for t in _all_tasks(plan)] + [w["checkpoint"]["id"] for w in plan["weeklyPlan"]]
        assert len(ids) == len(set(ids)) == plan["totalTasks"]
        assert ids[0] == "w1-d1-t1"

    def test_week_one_works_on_the_actual_missed_questions(self):
        w1 = _plan()["weeklyPlan"][0]
        assert w1["focus"] == "Databases" and w1["focusScore"] == 34
        texts = " ".join(t["text"] for d in w1["days"] for t in d["tasks"])
        assert "clustered and a non-clustered index" in texts
        assert "Reading the EXPLAIN plan" in texts
        from_interview = [q for q in w1["practiceQuestions"] if q.get("from")]
        assert from_interview[0]["from"] == "Your interview, Q4 — scored 30/100"
        assert "Clustered index defines row order" in from_interview[0]["goodAnswerCovers"]

    def test_targets_start_from_the_measured_baseline(self):
        plan = _plan()
        finals = {t["metric"]: t for t in plan["finalTargets"]}
        assert finals["Overall score"]["baseline"] == 58 and finals["Overall score"]["target"] == 73
        assert finals["Filler words per answer"]["target"] == 1.0
        w1_targets = {t["metric"]: t for t in plan["weeklyPlan"][0]["targets"]}
        assert w1_targets["Filler words per answer"]["target"] == "≤ 2.3 per answer"  # a quarter of the way
        assert plan["baseline"]["wpm"] == 168

    def test_summary_cites_the_interview(self):
        summary = _plan()["summary"]
        assert "overall 58/100" in summary and "Databases (34/100)" in summary
        assert "168 WPM" in summary and "“like”" in summary and "up 7 points" in summary

    def test_resume_projects_week_uses_the_real_projects(self):
        w3 = _plan()["weeklyPlan"][2]
        assert w3["kind"] == "projects"
        texts = " ".join(t["text"] for d in w3["days"] for t in d["tasks"])
        assert "Smart Parking Finder" in texts and "Resume Screening Tool" in texts

    def test_resources_are_https_and_relevant(self):
        web = [
            {"type": "WEB", "title": "Database index tutorial: clustered vs non-clustered", "url": "https://example.com/idx", "snippet": ""},
            {"type": "WEB", "title": "Leadership stories", "url": "https://example.com/lead", "snippet": ""},
            {"type": "WEB", "title": "Clustered index basics", "url": "http://insecure.example/idx", "snippet": ""},
        ]
        plan = _plan(web_resources=web)
        w1_urls = [r["url"] for r in plan["weeklyPlan"][0]["resources"]]
        assert "https://example.com/idx" in w1_urls
        assert "https://example.com/lead" not in w1_urls and "http://insecure.example/idx" not in w1_urls
        for w in plan["weeklyPlan"]:
            assert all(r["url"].startswith("https://") for r in w["resources"] if r.get("url"))
            assert any(r["type"] == "YOUTUBE_SEARCH" for r in w["resources"])

    def test_previous_plan_readers_still_find_their_fields(self):
        for w in _plan()["weeklyPlan"]:
            for field in ("objective", "focus", "skills", "whyThisSkill", "activities", "practiceExercises",
                          "applicationTask", "measurableOutcome", "estimatedHours", "progressCheck"):
                assert w[field], field


# ── LLM enrichment ────────────────────────────────────────────────────────────

class TestEnrichment:
    def test_valid_output_is_merged_and_interview_questions_stay(self):
        llm = FakeLLM([ENRICHED, ENRICHED, ENRICHED])
        plan = _plan(llm=llm)
        assert len(llm.prompts) == 3  # weeks 1-3; the simulation week needs no LLM
        assert "Q4 (30/100)" in llm.prompts[0] and "Reading the EXPLAIN plan" in llm.prompts[0]
        w1 = plan["weeklyPlan"][0]
        assert w1["objective"] == ENRICHED["objective"]
        day1 = [t["text"] for t in w1["days"][0]["tasks"]]
        assert any("cover: B-tree leaf pages hold the rows; One physical order" in t for t in day1)
        questions = [q["question"] for q in w1["practiceQuestions"]]
        assert questions[0] == "What is the difference between a clustered and a non-clustered index?"
        assert "How would you confirm a query uses your new index?" in questions
        assert not any("http" in q for q in questions)  # a question carrying a URL is dropped
        assert plan["generation_source"] == "LLM"

    def test_failures_fall_back_to_the_rules_week_by_week(self):
        llm = FakeLLM([RuntimeError("429 rate limit"), RuntimeError("400 bad JSON"), {"unexpected": "shape"}, ENRICHED])
        plan = _plan(llm=llm)
        assert len(llm.prompts) == 4  # week 1 tried twice, weeks 2 and 3 once
        assert plan["generation_source"] == "LLM_PARTIAL"
        w1, w2, w3 = plan["weeklyPlan"][:3]
        assert w1["objective"].startswith("By the end of week 1 you can answer every Databases question")
        assert w2["days"][0]["tasks"][1]["text"].startswith("Study “Push vs polling trade-off”: write a 5-line note")
        assert w3["objective"] == ENRICHED["objective"]

    def test_a_failed_call_is_retried_once(self):
        llm = FakeLLM([RuntimeError("busy"), ENRICHED, ENRICHED, ENRICHED])
        plan = _plan(llm=llm)
        assert plan["weeklyPlan"][0]["objective"] == ENRICHED["objective"]
        assert plan["generation_source"] == "LLM"

    def test_few_llm_questions_are_topped_up_with_follow_ups(self):
        answer = {**ENRICHED, "practiceQuestions": [{"question": "Only one?", "goodAnswerCovers": ["Yes"]}]}
        w1 = _plan(llm=FakeLLM([answer, ENRICHED, ENRICHED]))["weeklyPlan"][0]
        new = [q["question"] for q in w1["practiceQuestions"] if not q.get("from")]
        assert new[0] == "Only one?" and len(new) == 3

    def test_documents_are_not_matched_on_generic_words(self):
        docs = [{"id": "d1", "title": "Java Interview Fundamentals", "excerpt": "Common interview questions"}]
        plan = _plan(knowledge_docs=docs)
        assert not any(r.get("documentId") == "d1" for w in plan["weeklyPlan"] for r in w["resources"])

    def test_the_llm_search_query_drives_the_video_link(self):
        answer = {**ENRICHED, "searchQuery": "composite index leftmost prefix"}
        plan = _plan(llm=FakeLLM([answer, ENRICHED, ENRICHED]))
        video = next(r for r in plan["weeklyPlan"][0]["resources"] if r["type"] == "YOUTUBE_SEARCH")
        assert video["url"].endswith("search_query=composite+index+leftmost+prefix")

    def test_no_llm_still_gives_a_complete_plan(self):
        plan = _plan(llm=None)
        assert plan["generation_source"] == "EVIDENCE_RULES" and len(_all_tasks(plan)) >= 40

    def test_the_offline_mock_provider_is_never_called(self):
        from app.services.providers import MockProvider
        llm = MagicMock()
        llm._provider = MockProvider()
        _plan(llm=llm)
        llm._call_json.assert_not_called()


# ── Agent wiring ──────────────────────────────────────────────────────────────

def _loop_result(tool_results):
    from app.agents.state import AgentMetrics, TerminationReason
    result = MagicMock()
    result.tool_results = tool_results
    result.termination_reason = TerminationReason.NATURAL
    result.step_count = 2
    result.tool_call_count = len(tool_results)
    result.metrics = AgentMetrics()
    return result


class TestSpecialistWiring:
    def _run(self, tool_results, ev):
        from app.agents.specialist_agent import run_specialist_agent
        task = {"studentId": "s1", "goal": "Improve", "supervisorRunId": "sup-1",
                "triggeredByUserId": None, "interviewEvidence": ev}
        spec_def = {"id": "spec-1", "max_steps": 12, "max_tool_calls": 8, "timeout_seconds": 150}
        with (
            patch("app.agents.specialist_agent.run_agent_loop", return_value=_loop_result(tool_results)) as loop,
            patch("app.agents.specialist_agent.agent_repository") as repo,
            patch("app.agents.specialist_agent.get_llm_client", return_value=None),
            patch("app.agents.specialist_agent._generate_plan") as old_generator,
        ):
            repo.create_specialist_run.return_value = "spec-run-1"
            result = run_specialist_agent(task, spec_def)
        return result, loop, old_generator

    def test_interview_evidence_builds_the_interview_plan(self):
        result, loop, old_generator = self._run({
            "GetStudentPerformance": {"profile": {"overall_score": 58}},
            "GetSkillGapAnalysis": {"weakSkills": []},
            "SearchWebResources": {"webResources": []},
            "DraftLearningPlan": {"_ready_for_generation": True, "goal": "Improve"},
        }, evidence())
        assert result["draft_plan"]["kind"] == "INTERVIEW_PLAN"
        assert result["draft_plan"]["sourceAttemptId"] == "attempt-1"
        old_generator.assert_not_called()
        # The loop LLM is told the measured weak areas so its web search uses real topic names
        assert "Databases (34/100)" in loop.call_args.args[0].user_message

    def test_a_plan_is_built_even_when_the_loop_stopped_early(self):
        result, _, _ = self._run({"GetStudentPerformance": {"profile": {}}}, evidence())
        assert result["draft_plan"] and len(result["draft_plan"]["weeklyPlan"]) == 4

    def test_without_interview_evidence_the_original_path_runs(self):
        result, _, old_generator = self._run({
            "DraftLearningPlan": {"_ready_for_generation": True, "goal": "Improve"},
        }, None)
        old_generator.assert_called_once()


class TestEvidenceTool:
    def test_scope_is_enforced(self):
        from app.tools.base import ToolContext
        from app.tools.interview_evidence import GetInterviewEvidenceTool
        res = GetInterviewEvidenceTool().execute({"studentId": "other"}, ToolContext(student_id="s1", agent_run_id="r"))
        assert not res.success and res.error_code == "SCOPE_VIOLATION"

    def test_reads_the_latest_report_resume_and_history(self):
        from app.tools.base import ToolContext
        from app.tools.interview_evidence import GetInterviewEvidenceTool
        with patch("app.tools.interview_evidence.interview_repository") as repo:
            repo.get_latest_interview.return_value = {"attempt_id": "a1", "report_data": REPORT, "created_at": "2026-10-08"}
            repo.get_interview_history.return_value = [{"overall_score": 58}]
            repo.get_current_resume.return_value = {"projects": []}
            repo.get_student_context.return_value = {"name": "Arjun", "program_name": "CSE"}
            res = GetInterviewEvidenceTool().execute({"studentId": "s1"}, ToolContext(student_id="s1", agent_run_id="r"))
        assert res.success and res.data["attemptId"] == "a1" and res.data["student"]["program"] == "CSE"
        assert "overall=58" in res.context_summary

    def test_no_interview_is_a_clean_not_found(self):
        from app.tools.base import ToolContext
        from app.tools.interview_evidence import GetInterviewEvidenceTool
        with patch("app.tools.interview_evidence.interview_repository") as repo:
            repo.get_latest_interview.return_value = None
            res = GetInterviewEvidenceTool().execute({"studentId": "s1"}, ToolContext(student_id="s1", agent_run_id="r"))
        assert not res.success and res.error_code == "NOT_FOUND"


@pytest.mark.parametrize("weeks_field", ["weeklyPlan"])
def test_plan_passes_the_fixed_duration_contract(weeks_field):
    from app.agents.specialist_agent import _validate_learning_plan
    ok, reason = _validate_learning_plan(_plan(), 4)
    assert ok, reason
