"""Unit and API tests for the marks-based assignment answer generator."""

from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from docx import Document
from fastapi.testclient import TestClient
from google.genai import errors as genai_errors
from PIL import Image
import pymupdf as fitz

from app.assignment.cache import AssignmentAnswerCache
from app.assignment.file_ingest import extract_assignment_input
from app.assignment.generator import call_with_exponential_backoff, generate_single_answer
from app.assignment.length_validator import (
    calculate_word_range,
    count_explanation_words,
    estimate_handwritten_lines,
)
from app.assignment.models import AssignmentQuestion, ExportRequest, GeneratedAnswerItem, StudentProfile
from app.assignment.presets import get_preset, load_preset_catalog
from app.assignment.question_parser import (
    RawParsedQuestion,
    detect_marks_in_text,
    normalize_parsed_questions,
)
from app.main import app

client = TestClient(app)


def _fake_response(text: str, prompt_tok: int = 50, out_tok: int = 80):
    return SimpleNamespace(
        text=text,
        usage_metadata=SimpleNamespace(
            prompt_token_count=prompt_tok,
            candidates_token_count=out_tok,
            thoughts_token_count=0,
            total_token_count=prompt_tok + out_tok,
        ),
    )


def _make_fake_client(responses: list[object]):
    recorded_calls: list[dict] = []
    queue = list(responses)

    def _generate_content(*, model, contents, config=None):
        recorded_calls.append({"model": model, "contents": contents, "config": config})
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    fake = SimpleNamespace(models=SimpleNamespace(generate_content=_generate_content))
    return fake, recorded_calls


# ---------------------------------------------------------------------------
# 1. Marks detection regex & question normalization
# ---------------------------------------------------------------------------


def test_marks_detection_regex_patterns():
    assert detect_marks_in_text("Explain virtual memory cleanly. (5)").total == 5
    assert detect_marks_in_text("Compare TCP and UDP [10 marks]").total == 10
    assert detect_marks_in_text("Write a short note on normalization 5M").total == 5
    assert detect_marks_in_text("Design a 4-bit counter. Marks: 12").total == 12
    assert detect_marks_in_text("Marks - 7 Explain deadlocks in detail.").total == 7

    compound = detect_marks_in_text("(a) Define paging (b) Explain thrashing (2+3)")
    assert compound.is_compound is True
    assert compound.parts == [2.0, 3.0]
    assert compound.total == 5.0

    # Leading question number must not be confused with marks
    no_marks = detect_marks_in_text("(1) Explain operating system services")
    assert no_marks.total is None


def test_compound_question_split_and_sum_rules():
    split_q = RawParsedQuestion(
        number="1",
        part="",
        text="(a) Define mutex (b) Compare mutex with semaphore (2+3)",
        marks=None,
        type="compare",
        confidence=0.92,
    )
    summed_q = RawParsedQuestion(
        number="2",
        part="",
        text="Discuss ACID properties with suitable database transaction examples (4+6)",
        marks=None,
        type="explain",
        confidence=0.9,
    )
    missing_q = RawParsedQuestion(
        number="3",
        part="",
        text="What is polymorphism?",
        marks=None,
        type="define",
        confidence=0.95,
    )

    normalized = normalize_parsed_questions([split_q, summed_q, missing_q])
    assert len(normalized) == 4
    assert (normalized[0].id, normalized[0].part, normalized[0].marks) == ("Q1a", "a", 2.0)
    assert (normalized[1].id, normalized[1].part, normalized[1].marks) == ("Q1b", "b", 3.0)
    assert (normalized[2].id, normalized[2].marks) == ("Q2", 10.0)
    assert normalized[3].marks is None
    assert normalized[3].needs_review is True


# ---------------------------------------------------------------------------
# 2. Word-range calculation & explicit overrides
# ---------------------------------------------------------------------------


def test_word_range_default_formula_and_overrides():
    r2 = calculate_word_range(2)
    assert (r2.min_words, r2.max_words, r2.target_words) == (60, 80, 70)

    r7 = calculate_word_range(7)
    assert (r7.min_words, r7.max_words, r7.target_words) == (210, 280, 245)

    r11 = calculate_word_range(11)
    assert (r11.min_words, r11.max_words, r11.target_words) == (330, 440, 385)

    overrides = {"7": [210, 250], "11": [350, 420]}
    o7 = calculate_word_range(7, explicit_overrides=overrides)
    assert (o7.min_words, o7.max_words, o7.target_words) == (210, 250, 230)

    o11 = calculate_word_range(11, explicit_overrides=overrides)
    assert (o11.min_words, o11.max_words, o11.target_words) == (350, 420, 385)

    assert estimate_handwritten_lines(110) == 10


# ---------------------------------------------------------------------------
# 3. Word counter with code and formula exclusion
# ---------------------------------------------------------------------------


def test_word_counter_excludes_code_and_formulas():
    code_answer = (
        "Binary search splits a sorted array in half at every step to locate a target value quickly.\n"
        "def binary_search(arr, target):\n"
        "    lo, hi = 0, len(arr) - 1\n"
        "    while lo <= hi:\n"
        "        mid = (lo + hi) // 2\n"
        "        if arr[mid] == target:\n"
        "            return mid\n"
        "    return -1\n"
        "This algorithm maintains logarithmic time complexity across large datasets."
    )
    expl_code, total_code = count_explanation_words(code_answer, "code")
    assert expl_code < total_code
    assert expl_code == 26  # 17 words in first sentence + 9 words in closing sentence

    fenced_code = (
        "Sorting orders items ascending.\n"
        "```python\narr.sort()\n```\n"
        "Time complexity is quadratic worst case."
    )
    expl_fenced, total_fenced = count_explanation_words(fenced_code, "code")
    assert expl_fenced == 10
    assert total_fenced > expl_fenced

    numerical_answer = (
        "We apply Newton's second law to determine the net force acting on the moving body.\n"
        "F = m * a\n"
        "F = 12 * 4 = 48 N\n"
        "Hence the accelerating object experiences forty eight newtons of net force."
    )
    expl_num, total_num = count_explanation_words(numerical_answer, "numerical")
    assert expl_num < total_num
    assert expl_num == 26  # 15 + 11 explanation words

    plain_expl, plain_total = count_explanation_words(numerical_answer, "explain")
    assert plain_expl == plain_total


# ---------------------------------------------------------------------------
# 4. Retry logic, closest fallback, HTTP 429 backoff, and cache hits
# ---------------------------------------------------------------------------


def test_word_count_retry_succeeds_on_second_attempt(tmp_path):
    preset = get_preset("btech-cse")
    q = AssignmentQuestion(id="Q1", number="1", text="Define paging.", marks=1, type="define")
    # Default 1 mark -> [30, 40], target 35
    too_short = " ".join(["paging"] * 12)  # 12 words -> out of [30, 40]
    right_size = " ".join(["memory"] * 35)  # 35 words -> inside [30, 40]

    fake_client, calls = _make_fake_client([_fake_response(too_short), _fake_response(right_size)])
    cache = AssignmentAnswerCache(cache_dir=tmp_path)

    item, usage = generate_single_answer(
        question=q,
        preset=preset,
        cache=cache,
        client=fake_client,
        sleep_fn=lambda _: None,
    )
    assert len(calls) == 2
    assert "Your previous answer had 12 words. Rewrite it to about 35 words (allowed 30-40)" in calls[1]["contents"]
    assert item.attempts == 2
    assert item.length_warning is False
    assert item.explanation_word_count == 35
    assert item.cached is False
    assert usage.api_calls == 2

    # Second call should hit cache with zero Gemini calls
    cached_client, cached_calls = _make_fake_client([])
    item2, usage2 = generate_single_answer(
        question=q,
        preset=preset,
        cache=cache,
        client=cached_client,
    )
    assert len(cached_calls) == 0
    assert item2.cached is True
    assert usage2.cache_hits == 1


def test_word_count_retry_picks_closest_and_flags_warning(tmp_path):
    preset = get_preset("btech-cse")
    q = AssignmentQuestion(id="Q2", number="2", text="Explain normalization.", marks=2, type="explain")
    # 2 marks -> [60, 80]
    attempt1 = " ".join(["alpha"] * 45)  # distance 15
    attempt2 = " ".join(["beta"] * 54)   # distance 6 (closer)

    fake_client, calls = _make_fake_client([_fake_response(attempt1), _fake_response(attempt2)])
    cache = AssignmentAnswerCache(cache_dir=tmp_path)

    item, _ = generate_single_answer(
        question=q,
        preset=preset,
        cache=cache,
        client=fake_client,
        sleep_fn=lambda _: None,
    )
    assert len(calls) == 2
    assert item.attempts == 2
    assert item.length_warning is True
    assert item.explanation_word_count == 54


def test_http_429_exponential_backoff():
    delays: list[float] = []
    attempts = {"n": 0}

    def _flaky_call():
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise genai_errors.APIError(429, {"error": {"message": "Rate limit"}}, None)
        return "ok"

    res = call_with_exponential_backoff(
        _flaky_call, max_tries=4, base_delay_sec=1.0, sleep_fn=delays.append
    )
    assert res == "ok"
    assert attempts["n"] == 3
    assert delays == [1.0, 2.0]


# ---------------------------------------------------------------------------
# 5. Presets catalog, file ingest, and PDF/DOCX export API tests
# ---------------------------------------------------------------------------


def test_presets_catalog_contains_all_sections_and_custom():
    catalog = load_preset_catalog()
    expected_sections = {
        "B.Tech",
        "Commerce",
        "Management",
        "Computer Applications",
        "Design",
        "Science",
        "Arts and Humanities",
        "Law",
        "Other",
    }
    assert set(catalog.sections) == expected_sections
    course_names = {p.course_name for p in catalog.presets}
    for required in (
        "B.Tech CSE",
        "B.Tech Civil",
        "B.Com",
        "MBA",
        "BCA",
        "B.Des",
        "B.Sc",
        "BA",
        "BA LLB",
        "Pharmacy (B.Pharm)",
        "Custom",
    ):
        assert required in course_names

    api_res = client.get("/api/assignments/presets")
    assert api_res.status_code == 200
    assert len(api_res.json()["presets"]) == len(catalog.presets)


def test_file_ingest_selectable_pdf_and_scanned_pdf(tmp_path):
    # Selectable PDF
    sel_pdf = tmp_path / "selectable.pdf"
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text(
        (72, 72),
        "Q1. Explain virtual memory with page fault handling in operating systems. (5 Marks)",
        fontsize=12,
    )
    doc.save(sel_pdf)
    doc.close()

    extracted_sel = extract_assignment_input(sel_pdf, ".pdf", "selectable.pdf")
    assert extracted_sel.extraction_method == "pymupdf_text"
    assert "virtual memory" in extracted_sel.text

    # Image-only scanned PDF -> rasterized multimodal
    img_buf = BytesIO()
    Image.new("RGB", (400, 200), color="white").save(img_buf, format="PNG")
    scanned_pdf = tmp_path / "scanned.pdf"
    doc2 = fitz.open()
    p2 = doc2.new_page()
    p2.insert_image(p2.rect, stream=img_buf.getvalue())
    doc2.save(scanned_pdf)
    doc2.close()

    extracted_scan = extract_assignment_input(scanned_pdf, ".pdf", "scanned.pdf")
    assert extracted_scan.extraction_method == "pymupdf_multimodal"
    assert len(extracted_scan.image_parts) == 1
    assert extracted_scan.image_parts[0][1] == "image/png"


def test_export_pdf_and_docx_include_student_header():
    payload = ExportRequest(
        title="OS Assignment 1",
        course_name="B.Tech CSE",
        subject_hint="Operating Systems",
        profile=StudentProfile(name="Aditi Sharma", roll_no="CS2104"),
        items=[
            GeneratedAnswerItem(
                question_id="Q1",
                number="1",
                part="",
                question_text="What is paging?",
                marks=2,
                type="define",
                answer="Paging is a memory management scheme that stores processes in fixed-size frames.",
                explanation_word_count=13,
                total_word_count=13,
                min_words=60,
                max_words=80,
                target_words=70,
                estimated_lines=2,
                length_warning=True,
                attempts=2,
                cached=False,
            )
        ],
    ).model_dump()

    pdf_res = client.post("/api/assignments/export/pdf", json=payload)
    assert pdf_res.status_code == 200
    assert pdf_res.content.startswith(b"%PDF-")
    with fitz.open(stream=pdf_res.content, filetype="pdf") as pdf:
        page_text = pdf[0].get_text()
        assert "Submitted by: Aditi Sharma | Roll No.: CS2104" in page_text
        assert "Q1. [2 Marks]" in page_text

    docx_res = client.post("/api/assignments/export/docx", json=payload)
    assert docx_res.status_code == 200
    assert docx_res.content.startswith(b"PK\x03\x04")
    doc = Document(BytesIO(docx_res.content))
    header_text = doc.sections[0].header.paragraphs[0].text
    assert "Submitted by: Aditi Sharma | Roll No.: CS2104" in header_text
    assert any("Q1. [2 Marks]" in p.text for p in doc.paragraphs)
