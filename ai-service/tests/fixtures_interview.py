"""A realistic stored interview report (performance.assessment_reports.report_data)."""
from __future__ import annotations

import copy


def _turn(n, question, category, score, missed, covered, note, difficulty="MEDIUM", source="follow_up",
          wpm=168, fillers=3, pauses=1, latency=6.0):
    return {
        "turn": n, "question": question, "difficulty": difficulty, "category": category,
        "technicalScore": score, "communicationScore": 66, "overallScore": round(score * 0.7 + 66 * 0.3),
        "wpm": wpm, "fillerCount": fillers, "pauseCount": pauses, "responseLatencySec": latency,
        "feedback": note, "strengths": "Clear opening sentence." if score >= 70 else "",
        "weaknesses": note, "pointsCovered": covered, "pointsMissed": missed, "questionSource": source,
    }


REPORT = {
    "id": "attempt-1", "date": "2026-10-08", "sessionType": "MOCK_INTERVIEW",
    "overallScore": 58, "technicalScore": 52, "communicationScore": 66,
    "fluencyScore": 64, "clarityScore": 71, "averageWpm": 168, "paceLabel": "Fast",
    "totalFillerWords": 14, "fillerWordBreakdown": {"like": 7, "um": 5, "you know": 2},
    "skillBreakdown": [], "actionableNextSteps": [], "tabSwitches": 0, "isFlagged": False,
    "questionsAnswered": 5, "questionsPlanned": 6, "longPauses": 4, "averageResponseLatencySec": 6.2,
    "scoringMethod": [],
    "turns": [
        _turn(1, "Tell me about yourself and the project you are proudest of.", "Introduction", 70,
              [], ["Background", "A project"], "Rushed; no concrete result mentioned.", difficulty="EASY", source="resume"),
        _turn(2, "In your Smart Parking Finder, how do slot updates reach the map, and why that design?", "System Design", 64,
              ["Push vs polling trade-off"], ["Sensor readings stored in MongoDB", "React map polls the API"],
              "Did not justify polling or discuss server push.", source="resume"),
        _turn(3, "How would you speed up a slow report query that joins two large tables?", "Databases", 38,
              ["Composite index on the filter columns", "Reading the EXPLAIN plan", "Filtering before joining"],
              ["Adding an index"], "Only said 'add an index' without saying which or how to verify.", wpm=176, fillers=5),
        _turn(4, "What is the difference between a clustered and a non-clustered index?", "Databases", 30,
              ["Clustered index defines row order", "Only one clustered index per table", "Non-clustered stores pointers"],
              [], "Confused the two kinds of index.", difficulty="EASY", fillers=4, pauses=2),
        _turn(5, "How does your resume screening tool rank resumes?", "Machine Learning", 72,
              ["Limitations of TF-IDF"], ["TF-IDF vectors", "Cosine similarity"],
              "Good explanation; missed the limitation of keyword matching.", source="resume"),
    ],
}

RESUME = {
    "summary": "Final-year CSE student.",
    "skills": {"languages": ["JavaScript", "Python"], "frameworks": ["React", "Django"],
               "databases": ["MongoDB", "PostgreSQL"], "tools": ["Git"]},
    "projects": [
        {"title": "Smart Parking Finder", "techStack": ["React", "Node.js", "MongoDB"],
         "description": "Live map of free parking slots from IoT sensors."},
        {"title": "Resume Screening Tool", "techStack": ["Django", "PostgreSQL", "scikit-learn"],
         "description": "Ranks resumes against a job description with TF-IDF."},
    ],
    "experience": [], "education": [], "certifications": [], "links": {},
}


def evidence(report=None, resume=RESUME, history=None):
    return {
        "attemptId": "attempt-1",
        "completedAt": "2026-10-08T10:00:00+00:00",
        "report": copy.deepcopy(report or REPORT),
        "history": history if history is not None else [{"overall_score": 58}, {"overall_score": 51}],
        "resume": copy.deepcopy(resume) if resume else None,
        "student": {"name": "Arjun", "program": "B.Tech CSE"},
    }
