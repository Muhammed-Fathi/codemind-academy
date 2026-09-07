#!/usr/bin/env python3
"""Validate the Phase 2 knowledge model against the four committed curriculum PDFs.

Requires pypdf (kept out of the application dependency graph):
    python -m pip install pypdf

Run from the repository root:
    python3 scripts/validate-curriculum-knowledge.py

The validator deliberately validates only source/model integrity. It does not seed the
application database, create questions, generate exams, or call Kodgy.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

try:
    from pypdf import PdfReader
except ImportError as exc:  # pragma: no cover - exercised by a human command
    raise SystemExit(
        "pypdf is required for PDF validation. Install it outside the app dependency graph "
        "with: python3 -m pip install pypdf"
    ) from exc

ROOT = Path(__file__).resolve().parents[1]
MODEL_PATH = ROOT / "docs/curriculum/knowledge-model.json"


def normalize(value: str) -> str:
    """Normalize PDF text enough to ignore line wrapping and typography noise."""
    value = value.replace("’", "'").replace("–", "-").replace("—", "-")
    value = re.sub(r"\s+", " ", value)
    return value.strip().lower()


def compact(value: str) -> str:
    """A more tolerant form for Arabic extracted text and punctuation."""
    return re.sub(r"[^\w]+", "", value, flags=re.UNICODE).lower()


def page_texts(path: Path) -> list[str]:
    reader = PdfReader(str(path), strict=False)
    texts: list[str] = []
    for page in reader.pages:
        try:
            texts.append(page.extract_text() or "")
        except Exception:
            # A malformed cover stream must not prevent checking the remaining pages.
            texts.append("")
    return texts


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def main() -> int:
    model = json.loads(MODEL_PATH.read_text(encoding="utf-8"))
    errors: list[str] = []
    warnings: list[str] = []

    if model.get("schemaVersion") != "2.0.0":
        fail(errors, "model schemaVersion is not 2.0.0")
    if model.get("modelType") != "curriculum-knowledge-model":
        fail(errors, "modelType is not curriculum-knowledge-model")

    source_text: dict[str, list[str]] = {}
    for source in model["sources"]:
        path = ROOT / source["path"]
        if not path.exists():
            fail(errors, f"missing source: {source['path']}")
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != source["sha256"]:
            fail(errors, f"SHA-256 mismatch: {source['path']} (model {source['sha256']}, actual {digest})")
        texts = page_texts(path)
        source_text[source["sourceId"]] = texts
        if len(texts) != source["pdfPages"]:
            fail(errors, f"page count mismatch: {source['path']} (model {source['pdfPages']}, actual {len(texts)})")
        if source["locale"] == "en":
            contents = normalize(texts[source["contentsPdfPage"] - 1])
            if "contents" not in contents:
                fail(errors, f"English contents marker missing: {source['path']} page {source['contentsPdfPage']}")

    source_by_id = {source["sourceId"]: source for source in model["sources"]}
    all_lessons: list[dict[str, Any]] = []
    unit_ids: set[str] = set()
    part_ids: set[str] = set()
    lesson_ids: set[str] = set()
    objective_count = 0

    for part in model["parts"]:
        if part["id"] in part_ids:
            fail(errors, f"duplicate part id: {part['id']}")
        part_ids.add(part["id"])
        if part["code"] not in {"P1", "P2"}:
            fail(errors, f"unexpected part code: {part['code']}")
        english_source_id = next((sid for sid in part["sourceIds"] if source_by_id[sid]["locale"] == "en"), None)
        arabic_source_id = next((sid for sid in part["sourceIds"] if source_by_id[sid]["locale"] == "ar"), None)
        if not english_source_id or not arabic_source_id:
            fail(errors, f"part {part['id']} does not point to one English and one Arabic source")
            continue
        english_text = source_text.get(english_source_id, [])
        arabic_text = source_text.get(arabic_source_id, [])
        english_contents = normalize(english_text[source_by_id[english_source_id]["contentsPdfPage"] - 1]) if english_text else ""

        for unit in part["units"]:
            if unit["id"] in unit_ids:
                fail(errors, f"duplicate unit id: {unit['id']}")
            unit_ids.add(unit["id"])
            if normalize(unit["title"]) not in english_contents:
                fail(errors, f"unit title not found in English contents: {unit['title']}")
            for lesson in unit["lessons"]:
                all_lessons.append(lesson)
                if lesson["id"] in lesson_ids:
                    fail(errors, f"duplicate lesson id: {lesson['id']}")
                lesson_ids.add(lesson["id"])
                objective_count += len(lesson["objectives"])
                en = lesson["sourcePages"]["english"]
                ar = lesson["sourcePages"]["arabic"]
                if en["pdfPages"] != list(range(en["pdfPages"][0], en["pdfPages"][-1] + 1)):
                    fail(errors, f"non-contiguous English page range: {lesson['id']}")
                if ar["pdfPages"] != list(range(ar["pdfPages"][0], ar["pdfPages"][-1] + 1)):
                    fail(errors, f"non-contiguous Arabic page range: {lesson['id']}")
                en_range = " ".join(normalize(english_text[p - 1]) for p in en["pdfPages"]) if english_text else ""
                en_objective_page = normalize(english_text[en["objectivesPdfPage"] - 1]) if english_text else ""
                en_concept_page = normalize(english_text[en["conceptEvidencePdfPage"] - 1]) if english_text else ""
                if normalize(lesson["title"]) not in en_range:
                    fail(errors, f"lesson heading not found in English pages {lesson['id']}: {lesson['title']}")
                for objective in lesson["objectives"]:
                    if normalize(objective["textEn"]) not in en_objective_page:
                        fail(errors, f"objective not found on recorded English objective page: {lesson['id']} — {objective['textEn']}")
                # Lesson 1-2 uses explicit term definitions rather than a labelled Key Concepts box.
                evidence_range = " ".join(normalize(english_text[p - 1]) for p in en["pdfPages"]) if english_text else ""
                for concept_id in lesson["conceptIds"]:
                    concept = next((c for c in model["concepts"] if c["id"] == concept_id), None)
                    if not concept:
                        fail(errors, f"unknown concept reference {concept_id} in {lesson['id']}")
                        continue
                    label = normalize(concept["canonicalLabel"])
                    if label not in evidence_range:
                        # Some PDF text layers split punctuation in a way pypdf cannot preserve.
                        if compact(label) not in compact(evidence_range):
                            fail(errors, f"concept not found in recorded English lesson pages: {lesson['id']} — {concept['canonicalLabel']}")
                if lesson["id"] != "lesson-1-2" and "key concepts" not in en_concept_page:
                    fail(errors, f"Key Concepts marker missing on recorded page: {lesson['id']}")
                # Arabic extraction reverses some glyph runs, so validate the labelled blocks and ranges,
                # while the report records the human visual title/localization comparison separately.
                ar_objective_page = arabic_text[ar["objectivesPdfPage"] - 1] if arabic_text else ""
                ar_concept_page = arabic_text[ar["conceptEvidencePdfPage"] - 1] if arabic_text else ""
                if "ملعتلاف ادهأ" not in ar_objective_page and "ملعتلا ادهأ" not in ar_objective_page:
                    warnings.append(f"Arabic objective marker has extraction variation: {lesson['id']}")
                if "ةيساسلأ اميهافملا" not in ar_concept_page:
                    warnings.append(f"Arabic concepts marker has extraction variation: {lesson['id']}")

    counts = model["integrity"]["expectedCounts"]
    actual = {
        "parts": len(model["parts"]),
        "units": len(unit_ids),
        "lessons": len(all_lessons),
        "objectives": objective_count,
    }
    for key, expected in counts.items():
        if actual.get(key) != expected:
            fail(errors, f"count mismatch for {key}: model expected {expected}, calculated {actual.get(key)}")

    for relation in model["knowledgeRelations"]:
        if relation["from"] not in lesson_ids or relation["to"] not in lesson_ids:
            fail(errors, f"relation references an unknown lesson: {relation}")

    if warnings:
        print("WARNINGS:")
        for warning in warnings:
            print(f"  - {warning}")
    if errors:
        print("FAIL:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print("PASS: Phase 2 curriculum knowledge model is source-aligned.")
    print(f"  sources: {len(model['sources'])} PDFs; pages: " + ", ".join(f"{s['sourceId']}={s['pdfPages']}" for s in model['sources']))
    print(f"  hierarchy: {actual['parts']} parts / {actual['units']} units / {actual['lessons']} lessons")
    print(f"  objectives: {actual['objectives']}; concepts: {model['integrity']['computedCounts']['uniqueConcepts']} unique / {model['integrity']['computedCounts']['conceptOccurrences']} lesson occurrences")
    print("  validation: hashes, page counts, English contents/headings/objectives/concepts, Arabic block/page evidence, IDs and relations")
    return 0


if __name__ == "__main__":
    sys.exit(main())
