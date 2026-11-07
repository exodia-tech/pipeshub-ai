"""Guards on the Mobart Ben synthetic project demo behind the vertical Build Packs.

The packs (sales, support, marketing, finance, HR) each ask golden questions kept
under `pack_questions`, apart from the chat landing's `questions`. These checks
catch the ways a pack's demo would quietly break: a question naming a record that
no longer exists, a "who can see this" lesson visible to the wrong persona or to
the installing admin, and a restricted fact that leaks into an open record.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

import app.connectors.sources.demo.connector as demo_connector
from app.connectors.sources.demo.harness.kb_harness import mentions

FIXTURE = Path(demo_connector.__file__).resolve().parent / "fixture" / "acme-corp.yaml"


@pytest.fixture(scope="module")
def fx() -> dict:
    return yaml.safe_load(FIXTURE.read_text(encoding="utf-8"))


def _group_of_record(fx: dict) -> dict[str, str]:
    """The connector's rule: a record's own group, else its container's; a thread takes its first message's."""
    containers = {c["id"]: c for c in fx["containers"]}
    groups = {r["id"]: r.get("group") or containers[r["container"]]["group"] for r in fx["records"]}
    for t in fx.get("threads", []):
        first = min((r for r in fx["records"] if r.get("thread") == t["id"]), key=lambda r: str(r["created"]))
        groups[t["id"]] = first.get("group") or containers[t["container"]]["group"]
    return groups


def _pack_questions(fx: dict) -> list[dict]:
    return [q for qs in fx.get("pack_questions", {}).values() for q in qs]


def test_pack_expectations_name_records_that_exist(fx: dict) -> None:
    known = {r["id"] for r in fx["records"]} | {t["id"] for t in fx.get("threads", [])}
    keys = ("must_cite", "must_cite_any_of", "must_cite_any_of_2", "stretch_cite_any_of", "must_not_cite", "restricted")
    missing = {q["id"]: sorted(x for k in keys for x in q.get(k, []) if x not in known) for q in _pack_questions(fx)}
    assert not {k: v for k, v in missing.items() if v}, missing
    ids = [q["id"] for q in _pack_questions(fx) + fx["questions"]]
    assert len(ids) == len(set(ids)), "question ids must be unique"


def test_each_pack_lesson_is_visible_to_exactly_its_reader(fx: dict) -> None:
    # Every pack has one "who can see this" question; the restricted record must be
    # readable by the persona that "cites" it, hidden from the other, and never
    # handed to the installing admin.
    people = {p["id"]: p for p in fx["people"]}
    groups = {g["id"]: g for g in fx["groups"]}
    group_of_record = _group_of_record(fx)
    lessons = [q for q in _pack_questions(fx) if q.get("restricted")]
    assert {q["id"] for q in lessons}, "the packs need their restricted questions"
    containers = {c["id"]: c for c in fx["containers"]}
    records = {r["id"]: r for r in fx["records"]}
    for q in lessons:
        (group,) = {group_of_record[x] for x in q["restricted"]}
        assert not groups[group].get("installer_joins"), f"{q['id']}: the installer must not see {group}"
        # A record also inherits its container's readers, so a record-level group
        # inside a wider folder restricts nothing: the folder must be the group's own.
        for x in q["restricted"]:
            assert containers[records[x]["container"]]["group"] == group, f"{q['id']}: {x} sits in a wider folder"
        for persona, expect in q["personas"].items():
            member = group in people[persona].get("groups", [])
            assert member == (expect == "cites"), f"{q['id']}: {persona} ({expect}) membership of {group}"


def test_pack_restricted_facts_come_only_from_restricted_records(fx: dict) -> None:
    group_of_record = _group_of_record(fx)
    for q in (q for q in _pack_questions(fx) if q.get("restricted")):
        (group,) = {group_of_record[x] for x in q["restricted"]}
        facts = q.get("restricted_facts", [])
        assert facts, f"{q['id']} needs facts that catch a leak in the answer text"
        inside = " ".join(r["body"] for r in fx["records"] if r["id"] in q["restricted"]).lower()
        outside = " ".join(r["body"] for r in fx["records"] if group_of_record[r["id"]] != group).lower()
        assert [f for f in facts if not mentions(inside, f)] == [], q["id"]
        assert [f for f in facts if mentions(outside, f)] == [], q["id"]


def test_every_team_reader_group_is_open_to_the_installer(fx: dict) -> None:
    # Team folders carry the shared content the admin who adds the demo should see;
    # only the folders behind a "who can see this" lesson stay closed.
    groups = {g["id"]: g for g in fx["groups"]}
    lesson_groups = {"pricing-committee"} | {
        _group_of_record(fx)[x] for q in _pack_questions(fx) for x in q.get("restricted", [])
    }
    closed = sorted(c["id"] for c in fx["containers"] if c["group"] not in lesson_groups and not groups[c["group"]].get("installer_joins"))
    assert closed == [], closed


def test_no_open_folder_holds_a_restricted_record(fx: dict) -> None:
    # The leak this guards: a restricted record placed in a team folder is readable
    # by everyone who can read the folder.
    containers = {c["id"]: c for c in fx["containers"]}
    leaks = sorted(r["id"] for r in fx["records"] if r.get("group") and r["group"] != containers[r["container"]]["group"])
    assert leaks == [], leaks



def test_mobart_questions_follow_source_facts_and_project_boundaries(fx: dict) -> None:
    records = {r["id"]: r for r in fx["records"]}
    questions = {q["id"]: q for q in fx["questions"]}
    assert {"mobart-001-d01", "mobart-001-d08"} <= set(questions["q1"]["must_cite"])
    assert "mobart-001-d02" in questions["q2"]["must_cite"]
    assert "restricted" not in questions["q2"]
    assert questions["q2"]["personas"] == {"alice": "cites", "bob": "cites"}
    assert {"mobart-001-d03", "mobart-001-d04"} <= set(questions["q3"]["must_cite"])
    assert {"mobart-001-d05", "mobart-001-d06", "mobart-001-d17"} <= set(questions["q4"]["must_cite"])
    assert "mobart-002-d07" in questions["q5"]["must_cite"]
    assert "MB-DEMO-002" in records["mobart-002-d07"]["body"]
    assert "non riguarda Villa Aurora, MB-DEMO-001" in records["mobart-002-d07"]["body"]
    assert "giulia non approva l'opzione" in records["mobart-001-d05"]["body"].lower()
    assert "non disponibili" in records["mobart-001-d06"]["body"].lower()


def test_original_quote_is_public_and_restricted_question_uses_only_demo_tag(fx: dict) -> None:
    records = {r["id"]: r for r in fx["records"]}
    containers = {c["id"]: c for c in fx["containers"]}
    quote = records["mobart-001-d02"]
    assert quote.get("group", containers[quote["container"]]["group"]) == "engineering-readers"
    assert "€18.000" in quote["body"]
    q = next(q for q in fx["questions"] if q["id"] == "q6")
    assert q["restricted"] == ["drive-pricing-2026"]
    assert q["restricted_facts"] == ["VA-INT-7"]
    assert q["personas"] == {"alice": "none", "bob": "cites"}
    restricted = records["drive-pricing-2026"]
    assert restricted["group"] == "pricing-committee"
    assert "VA-INT-7" in restricted["body"]
    assert "€" not in restricted["body"]


def test_legacy_connector_slots_are_distinct_simulated_mobart_context(fx: dict) -> None:
    legacy = [r for r in fx["records"] if not r["id"].startswith("mobart-") and r["id"] != "drive-pricing-2026"]
    assert len({r["title"] for r in legacy}) == len(legacy)
    assert len({r["body"] for r in legacy}) > len(legacy) * 0.9
    assert all("simulat" in r["body"].lower() or "inventat" in r["body"].lower() for r in legacy)
    assert all("Villa Aurora" in r["title"] for r in legacy)


def test_simulated_threads_follow_document_chronology(fx: dict) -> None:
    threads = {t["id"]: t for t in fx["threads"]}
    for thread_id, thread in threads.items():
        messages = sorted(
            (r for r in fx["records"] if r.get("thread") == thread_id),
            key=lambda r: str(r["created"]),
        )
        assert messages
        dates = [r["created"] for r in messages]
        assert dates == sorted(dates), thread_id
        assert all("simulat" in r["title"].lower() for r in messages)
        assert "Villa Aurora" in thread["title"]


def test_fixture_has_no_old_customer_story_or_fake_revision_price(fx: dict) -> None:
    visible_parts = []
    for record in fx["records"]:
        visible_parts.extend((record.get("title", ""), record.get("body", "")))
    for container in fx["containers"]:
        visible_parts.append(container.get("name", ""))
    for thread in fx["threads"]:
        visible_parts.append(thread.get("title", ""))
    for question in fx["questions"] + [q for qs in fx["pack_questions"].values() for q in qs]:
        visible_parts.append(question.get("ask", ""))
        for key in ("answer_must_mention", "answer_must_state", "answer_must_not_state"):
            visible_parts.extend(question.get(key, []))
    visible = " ".join(visible_parts).lower()
    for old_name in ("northwind", "contoso", "fabrikam", "stripe", "acme insights"):
        assert old_name not in visible
    q4 = next(q for q in fx["questions"] if q["id"] == "q4")
    assert any("preventivo revisionato" in x.lower() for x in q4["answer_must_state"])
    assert any("€18.000" in x for x in q4["answer_must_not_state"])