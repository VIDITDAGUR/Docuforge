"""Gemini-backed assignment answer generator with backoff, word-count retry, caching, and job runner."""

from concurrent.futures import ThreadPoolExecutor, as_completed
import logging
import re
import threading
import time
from typing import Any, Callable, Optional
import uuid
from google import genai
from google.genai import errors as genai_errors
from google.genai import types

from ..config import GEMINI_MODEL, get_gemini_api_key
from .cache import AssignmentAnswerCache, make_cache_key
from .length_validator import (
    WordRange,
    calculate_word_range,
    count_explanation_words,
    distance_to_range,
    estimate_handwritten_lines,
    is_within_range,
)
from .models import (
    AssignmentQuestion,
    CoursePreset,
    GeneratedAnswerItem,
    GenerationRequest,
    QuestionType,
    TokenUsage,
)
from .presets import get_preset, load_preset_catalog, resolve_length_rules
from .prompt_builder import (
    build_followup_prompt,
    build_retry_prompt,
    build_system_prompt,
    build_user_prompt,
)

logger = logging.getLogger("docuforge.assignment.generator")

_TRANSIENT_HTTP_CODES = {429, 500, 502, 503, 504}
_PREAMBLE_RE = re.compile(
    r"^(?:here\s+is\s+(?:your|the)\s+answer\s*[:\-]\s*|sure[,!]?\s+here\s+is[^:\n]*:\s*)",
    re.IGNORECASE,
)

_JOBS_LOCK = threading.Lock()
_JOBS: dict[str, dict[str, Any]] = {}


def _clean_generated_text(raw_text: str, question_type: QuestionType) -> str:
    cleaned = (raw_text or "").strip()
    cleaned = _PREAMBLE_RE.sub("", cleaned).strip()
    if question_type != "code":
        cleaned = re.sub(r"```[A-Za-z]*\n?", "", cleaned).replace("```", "")
        cleaned = cleaned.replace("**", "")
    return cleaned.strip()


def _usage_from_response(response: Any) -> TokenUsage:
    meta = getattr(response, "usage_metadata", None)
    if not meta:
        return TokenUsage(api_calls=1)
    return TokenUsage(
        prompt_tokens=int(getattr(meta, "prompt_token_count", 0) or 0),
        candidates_tokens=int(getattr(meta, "candidates_token_count", 0) or 0),
        thoughts_tokens=int(getattr(meta, "thoughts_token_count", 0) or 0),
        total_tokens=int(getattr(meta, "total_token_count", 0) or 0),
        api_calls=1,
    )


def _merge_usage(acc: TokenUsage, delta: TokenUsage) -> TokenUsage:
    return TokenUsage(
        prompt_tokens=acc.prompt_tokens + delta.prompt_tokens,
        candidates_tokens=acc.candidates_tokens + delta.candidates_tokens,
        thoughts_tokens=acc.thoughts_tokens + delta.thoughts_tokens,
        total_tokens=acc.total_tokens + delta.total_tokens,
        api_calls=acc.api_calls + delta.api_calls,
        cache_hits=acc.cache_hits + delta.cache_hits,
    )


def call_with_exponential_backoff(
    fn: Callable[[], Any],
    max_tries: int = 4,
    base_delay_sec: float = 1.5,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> Any:
    """
    Execute a Gemini API call retrying HTTP 429 and transient errors with exponential backoff.
    """
    last_exc: Exception | None = None
    for attempt in range(max_tries):
        try:
            return fn()
        except genai_errors.APIError as exc:
            last_exc = exc
            code = getattr(exc, "code", None)
            if code in _TRANSIENT_HTTP_CODES and attempt < max_tries - 1:
                delay = base_delay_sec * (2**attempt)
                logger.warning(
                    "Gemini transient API error (HTTP %s); retrying in %.1fs (attempt %d/%d).",
                    code,
                    delay,
                    attempt + 1,
                    max_tries,
                )
                sleep_fn(delay)
                continue
            raise RuntimeError(f"Gemini API error (HTTP {code}): {exc}") from exc
        except (ConnectionError, TimeoutError, OSError) as exc:
            last_exc = exc
            if attempt < max_tries - 1:
                delay = base_delay_sec * (2**attempt)
                logger.warning(
                    "Transient network error (%s); retrying in %.1fs (attempt %d/%d).",
                    exc,
                    delay,
                    attempt + 1,
                    max_tries,
                )
                sleep_fn(delay)
                continue
            raise RuntimeError(f"Network error contacting Gemini after {max_tries} tries: {exc}") from exc
    raise RuntimeError(f"Gemini request failed: {last_exc}")


def _build_client(client: Optional[genai.Client]) -> genai.Client:
    if client is not None:
        return client
    api_key = get_gemini_api_key()
    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY is not configured. Add it to your .env file before generating answers."
        )
    return genai.Client(api_key=api_key)


def _generate_text_once(
    client: genai.Client,
    model_name: str,
    system_prompt: str,
    user_contents: Any,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> tuple[str, TokenUsage]:
    response = call_with_exponential_backoff(
        lambda: client.models.generate_content(
            model=model_name,
            contents=user_contents,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=0.35,
            ),
        ),
        max_tries=4,
        sleep_fn=sleep_fn,
    )
    text = getattr(response, "text", None) or ""
    if not text.strip():
        raise RuntimeError("Gemini returned an empty answer.")
    return text.strip(), _usage_from_response(response)


def generate_single_answer(
    question: AssignmentQuestion,
    preset: CoursePreset,
    subject_hint: str = "",
    words_per_mark_min: Optional[int] = None,
    words_per_mark_max: Optional[int] = None,
    explicit_overrides: Optional[dict[str, list[int]]] = None,
    model: Optional[str] = None,
    cache: Optional[AssignmentAnswerCache] = None,
    use_cache: bool = True,
    bypass_cache: bool = False,
    client: Optional[genai.Client] = None,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> tuple[GeneratedAnswerItem, TokenUsage]:
    """
    Generate a single marks-calibrated answer with cache lookup and max-2-attempt word enforcement.
    """
    if question.marks is None or question.marks <= 0:
        raise ValueError(f"Question '{question.id}' must have positive marks.")

    model_name = (model or GEMINI_MODEL).strip() or GEMINI_MODEL
    catalog = load_preset_catalog()
    w_min, w_max, config_overrides = resolve_length_rules(
        preset, catalog=catalog, custom_min=words_per_mark_min, custom_max=words_per_mark_max
    )
    if explicit_overrides is not None:
        config_overrides = {**config_overrides, **explicit_overrides}

    word_range: WordRange = calculate_word_range(
        question.marks,
        words_per_mark_min=w_min,
        words_per_mark_max=w_max,
        explicit_overrides=config_overrides,
    )

    answer_cache = cache or AssignmentAnswerCache()
    cache_key = make_cache_key(
        question_text=question.text,
        marks=question.marks,
        preset_id=preset.id,
        model=model_name,
        subject_hint=subject_hint,
        words_per_mark_min=word_range.min_words,
        words_per_mark_max=word_range.max_words,
        question_type=question.type,
    )

    if use_cache and not bypass_cache:
        cached_payload = answer_cache.get(cache_key)
        if cached_payload and cached_payload.get("answer"):
            item = GeneratedAnswerItem(
                question_id=question.id,
                number=question.number,
                part=question.part,
                question_text=question.text,
                marks=float(question.marks),
                type=question.type,
                answer=cached_payload["answer"],
                explanation_word_count=int(cached_payload["explanation_word_count"]),
                total_word_count=int(cached_payload["total_word_count"]),
                min_words=word_range.min_words,
                max_words=word_range.max_words,
                target_words=word_range.target_words,
                estimated_lines=int(cached_payload["estimated_lines"]),
                length_warning=bool(cached_payload.get("length_warning", False)),
                attempts=int(cached_payload.get("attempts", 1)),
                cached=True,
            )
            return item, TokenUsage(cache_hits=1)

    active_client = _build_client(client)
    sys_prompt = build_system_prompt(preset.course_name)
    user_prompt = build_user_prompt(question, preset, subject_hint, word_range)

    total_usage = TokenUsage()

    # Attempt 1
    raw_1, usage_1 = _generate_text_once(
        active_client, model_name, sys_prompt, user_prompt, sleep_fn=sleep_fn
    )
    total_usage = _merge_usage(total_usage, usage_1)
    ans_1 = _clean_generated_text(raw_1, question.type)
    expl_1, tot_1 = count_explanation_words(ans_1, question.type)

    chosen_answer = ans_1
    chosen_expl = expl_1
    chosen_total = tot_1
    attempts = 1
    length_warning = False

    if not is_within_range(expl_1, word_range):
        retry_msg = build_retry_prompt(
            word_count=expl_1,
            target_words=word_range.target_words,
            min_words=word_range.min_words,
            max_words=word_range.max_words,
        )
        rewrite_contents = (
            f"{user_prompt}\n\n"
            f"Previous answer:\n{ans_1}\n\n"
            f"Instruction: {retry_msg}"
        )
        raw_2, usage_2 = _generate_text_once(
            active_client, model_name, sys_prompt, rewrite_contents, sleep_fn=sleep_fn
        )
        total_usage = _merge_usage(total_usage, usage_2)
        ans_2 = _clean_generated_text(raw_2, question.type)
        expl_2, tot_2 = count_explanation_words(ans_2, question.type)
        attempts = 2

        if is_within_range(expl_2, word_range):
            chosen_answer = ans_2
            chosen_expl = expl_2
            chosen_total = tot_2
            length_warning = False
        else:
            dist_1 = distance_to_range(expl_1, word_range)
            dist_2 = distance_to_range(expl_2, word_range)
            if dist_2 <= dist_1:
                chosen_answer, chosen_expl, chosen_total = ans_2, expl_2, tot_2
            length_warning = True

    est_lines = estimate_handwritten_lines(chosen_total)
    item = GeneratedAnswerItem(
        question_id=question.id,
        number=question.number,
        part=question.part,
        question_text=question.text,
        marks=float(question.marks),
        type=question.type,
        answer=chosen_answer,
        explanation_word_count=chosen_expl,
        total_word_count=chosen_total,
        min_words=word_range.min_words,
        max_words=word_range.max_words,
        target_words=word_range.target_words,
        estimated_lines=est_lines,
        length_warning=length_warning,
        attempts=attempts,
        cached=False,
    )

    if use_cache:
        answer_cache.set(
            cache_key,
            {
                "answer": item.answer,
                "explanation_word_count": item.explanation_word_count,
                "total_word_count": item.total_word_count,
                "estimated_lines": item.estimated_lines,
                "length_warning": item.length_warning,
                "attempts": item.attempts,
            },
        )

    return item, total_usage


def _run_generation_job(job_id: str, request: GenerationRequest) -> None:
    try:
        preset = get_preset(request.preset_id)
        shared_client = _build_client(None)
        cache = AssignmentAnswerCache()

        with _JOBS_LOCK:
            _JOBS[job_id]["status"] = "processing"

        total = len(request.questions)
        ordered_results: list[Optional[GeneratedAnswerItem]] = [None] * total
        agg_usage = TokenUsage()
        completed_count = 0

        def _worker(idx: int, q: AssignmentQuestion) -> tuple[int, GeneratedAnswerItem, TokenUsage]:
            try:
                item, usage = generate_single_answer(
                    question=q,
                    preset=preset,
                    subject_hint=request.subject_hint,
                    words_per_mark_min=request.words_per_mark_min,
                    words_per_mark_max=request.words_per_mark_max,
                    model=request.model,
                    cache=cache,
                    use_cache=request.use_cache,
                    client=shared_client,
                )
                return idx, item, usage
            except Exception as exc:
                word_range = calculate_word_range(
                    q.marks or 1,
                    words_per_mark_min=request.words_per_mark_min or preset.words_per_mark_min,
                    words_per_mark_max=request.words_per_mark_max or preset.words_per_mark_max,
                )
                err_item = GeneratedAnswerItem(
                    question_id=q.id,
                    number=q.number,
                    part=q.part,
                    question_text=q.text,
                    marks=float(q.marks or 0),
                    type=q.type,
                    answer="",
                    explanation_word_count=0,
                    total_word_count=0,
                    min_words=word_range.min_words,
                    max_words=word_range.max_words,
                    target_words=word_range.target_words,
                    estimated_lines=0,
                    length_warning=True,
                    attempts=1,
                    cached=False,
                    error=str(exc),
                )
                return idx, err_item, TokenUsage()

        with ThreadPoolExecutor(max_workers=request.concurrency) as pool:
            futures = [pool.submit(_worker, idx, q) for idx, q in enumerate(request.questions)]
            for fut in as_completed(futures):
                idx, item, delta_usage = fut.result()
                ordered_results[idx] = item
                agg_usage = _merge_usage(agg_usage, delta_usage)
                completed_count += 1
                with _JOBS_LOCK:
                    _JOBS[job_id]["completed"] = completed_count
                    _JOBS[job_id]["progress_label"] = f"Generating {completed_count}/{total}"
                    _JOBS[job_id]["token_usage"] = agg_usage.model_dump()

        final_items = [item.model_dump() for item in ordered_results if item is not None]
        logger.info(
            "Assignment job %s finished (%d answers): prompt=%d, output=%d, thoughts=%d, total=%d, cache_hits=%d",
            job_id,
            len(final_items),
            agg_usage.prompt_tokens,
            agg_usage.candidates_tokens,
            agg_usage.thoughts_tokens,
            agg_usage.total_tokens,
            agg_usage.cache_hits,
        )
        with _JOBS_LOCK:
            _JOBS[job_id].update(
                {
                    "status": "done",
                    "completed": total,
                    "progress_label": f"Completed {total}/{total}",
                    "results": final_items,
                    "token_usage": agg_usage.model_dump(),
                    "error": None,
                }
            )
    except Exception as exc:
        logger.exception("Assignment job %s failed", job_id)
        with _JOBS_LOCK:
            _JOBS[job_id].update({"status": "failed", "error": str(exc)})


def enqueue_generation_job(request: GenerationRequest) -> dict[str, Any]:
    """Validate confirmed questions and start asynchronous background answer generation."""
    if not request.questions:
        raise ValueError("Please include at least one question before generating answers.")
    missing = [q.id for q in request.questions if q.marks is None or q.marks <= 0]
    if missing:
        raise ValueError(
            f"Please fill valid positive marks for: {', '.join(missing)} before confirming."
        )
    # Verify preset exists eagerly
    get_preset(request.preset_id)

    job_id = uuid.uuid4().hex
    total = len(request.questions)
    job_payload: dict[str, Any] = {
        "job_id": job_id,
        "status": "pending",
        "completed": 0,
        "total": total,
        "progress_label": f"Generating 0/{total}",
        "results": [],
        "token_usage": TokenUsage().model_dump(),
        "error": None,
    }
    with _JOBS_LOCK:
        _JOBS[job_id] = job_payload

    t = threading.Thread(target=_run_generation_job, args=(job_id, request), daemon=True)
    t.start()
    return dict(job_payload)


def get_generation_job(job_id: str) -> Optional[dict[str, Any]]:
    """Fetch snapshot of an active or finished generation job."""
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        return dict(job) if job else None


def _is_fix_length_instruction(followup_instruction: Optional[str]) -> bool:
    low = (followup_instruction or "").strip().lower()
    return low.startswith("fix length") or "fix the length" in low or "within the word range" in low


async def stream_answer_sse(
    question: AssignmentQuestion,
    preset: CoursePreset,
    subject_hint: str = "",
    words_per_mark_min: Optional[int] = None,
    words_per_mark_max: Optional[int] = None,
    target_min_words: Optional[int] = None,
    target_max_words: Optional[int] = None,
    model_name: str = GEMINI_MODEL,
    bypass_cache: bool = False,
    previous_answer: Optional[str] = None,
    followup_instruction: Optional[str] = None,
    conversation_context: Optional[list[str]] = None,
    client: Optional[genai.Client] = None,
    cache: Optional[AssignmentAnswerCache] = None,
    async_sleep_fn: Optional[Callable[[float], Any]] = None,
) -> Any:
    """
    Async generator that yields SSE-formatted data lines for a single answer or follow-up.

    Uses ``client.aio.models.generate_content_stream`` so concurrent SSE requests
    do not block FastAPI's event loop.

    Event types emitted as ``data: {json}\\n\\n``:
    - ``token``        — incremental text chunk
    - ``rate_limited`` — transient HTTP 429 retry notice (includes ``reset`` flag)
    - ``done``         — completion payload with word counts, bounds, and estimated lines
    - ``error``        — terminal error message
    """
    import asyncio
    import json as _json

    sleep_impl = async_sleep_fn or asyncio.sleep
    marks = float(question.marks or 5.0)
    catalog = load_preset_catalog()
    w_min, w_max, config_overrides = resolve_length_rules(
        preset, catalog=catalog, custom_min=words_per_mark_min, custom_max=words_per_mark_max
    )

    if target_min_words is not None and target_max_words is not None:
        lo = max(10, min(int(target_min_words), int(target_max_words)))
        hi = max(lo, max(int(target_min_words), int(target_max_words)))
        word_range = WordRange(min_words=lo, max_words=hi, target_words=(lo + hi) // 2)
    else:
        word_range = calculate_word_range(
            marks,
            words_per_mark_min=w_min,
            words_per_mark_max=w_max,
            explicit_overrides=config_overrides,
        )

    is_fix_length = _is_fix_length_instruction(followup_instruction)
    is_custom_followup = bool(
        (followup_instruction and not is_fix_length)
        or (previous_answer and not is_fix_length)
        or target_min_words is not None
        or target_max_words is not None
    )

    answer_cache = cache or AssignmentAnswerCache()
    cache_key = make_cache_key(
        question_text=question.text,
        marks=marks,
        preset_id=preset.id,
        model=model_name,
        subject_hint=subject_hint,
        words_per_mark_min=word_range.min_words,
        words_per_mark_max=word_range.max_words,
        question_type=question.type,
    )

    # Emit initial SSE comment frame immediately so response headers flush to the client.
    yield ": stream-open\n\n"

    # --- Base cache check (standard requests only) ---
    if not bypass_cache and not is_custom_followup and not is_fix_length:
        cached_payload = answer_cache.get(cache_key)
        if cached_payload and cached_payload.get("answer"):
            full_text: str = cached_payload["answer"]
            chunk_size = 48
            for i in range(0, len(full_text), chunk_size):
                chunk = full_text[i : i + chunk_size]
                yield f"data: {_json.dumps({'type': 'token', 'text': chunk, 'question_id': question.id})}\n\n"
                await asyncio.sleep(0)

            expl_wc = int(cached_payload.get("explanation_word_count", 0))
            total_wc = int(cached_payload.get("total_word_count", 0))
            est_lines = int(cached_payload.get("estimated_lines", estimate_handwritten_lines(total_wc)))
            length_warning = bool(
                cached_payload.get("length_warning", not is_within_range(expl_wc, word_range))
            )
            yield f"data: {_json.dumps({'type': 'done', 'question_id': question.id, 'text': full_text, 'word_count': total_wc, 'explanation_word_count': expl_wc, 'estimated_lines': est_lines, 'min_words': word_range.min_words, 'max_words': word_range.max_words, 'target_words': word_range.target_words, 'length_warning': length_warning, 'cached': True})}\n\n"
            return

    # --- Build prompt (standard, Fix length, or contextual follow-up) ---
    owns_client = client is None
    active_client = client
    if active_client is None:
        api_key = get_gemini_api_key()
        if not api_key:
            yield f"data: {_json.dumps({'type': 'error', 'message': 'GEMINI_API_KEY is not configured. Add it to .env on the server.', 'question_id': question.id})}\n\n"
            return
        active_client = genai.Client(
            api_key=api_key,
            http_options=types.HttpOptions(timeout=35_000),
        )

    sys_prompt = build_system_prompt(preset.course_name)
    base_user_prompt = build_user_prompt(question, preset, subject_hint, word_range)

    if is_fix_length and previous_answer:
        prev_expl, _ = count_explanation_words(previous_answer, question.type)
        retry_msg = build_retry_prompt(
            word_count=prev_expl,
            target_words=word_range.target_words,
            min_words=word_range.min_words,
            max_words=word_range.max_words,
        )
        prompt_contents = (
            f"{base_user_prompt}\n\n"
            f"Previous answer:\n{previous_answer.strip()}\n\n"
            f"Instruction: {retry_msg}"
        )
    elif followup_instruction:
        prompt_contents = build_followup_prompt(
            base_user_prompt=base_user_prompt,
            previous_answer=previous_answer,
            followup_instruction=followup_instruction,
            word_range=word_range,
            conversation_context=conversation_context,
        )
    else:
        prompt_contents = base_user_prompt

    accumulated = ""
    max_tries = 4
    base_delay = 1.5

    try:
        for attempt in range(max_tries):
            try:
                stream = await asyncio.wait_for(
                    active_client.aio.models.generate_content_stream(
                        model=model_name,
                        contents=prompt_contents,
                        config=types.GenerateContentConfig(
                            system_instruction=sys_prompt,
                            temperature=0.35,
                        ),
                    ),
                    timeout=35.0,
                )
                had_partial = bool(accumulated)
                accumulated = ""
                stream_iter = stream.__aiter__()
                while True:
                    try:
                        chunk = await asyncio.wait_for(stream_iter.__anext__(), timeout=25.0)
                    except StopAsyncIteration:
                        break
                    chunk_text = getattr(chunk, "text", None) or ""
                    if chunk_text:
                        if had_partial:
                            yield f"data: {_json.dumps({'type': 'rate_limited', 'message': '', 'reset': True, 'question_id': question.id})}\n\n"
                            had_partial = False
                        accumulated += chunk_text
                        yield f"data: {_json.dumps({'type': 'token', 'text': chunk_text, 'question_id': question.id})}\n\n"
                break
            except genai_errors.APIError as exc:
                code = getattr(exc, "code", None)
                if code in _TRANSIENT_HTTP_CODES and attempt < max_tries - 1:
                    delay = base_delay * (2**attempt)
                    msg = (
                        f"Rate limited, retrying in {delay:.1f}s..."
                        if code == 429
                        else f"Temporary model issue (HTTP {code}), retrying in {delay:.1f}s..."
                    )
                    yield f"data: {_json.dumps({'type': 'rate_limited', 'message': msg, 'reset': bool(accumulated), 'question_id': question.id})}\n\n"
                    await sleep_impl(delay)
                    continue
                err_msg = (
                    "Rate limit exceeded after retries. Please try again shortly."
                    if code == 429
                    else f"Gemini API error (HTTP {code}): {exc}"
                )
                yield f"data: {_json.dumps({'type': 'error', 'message': err_msg, 'question_id': question.id})}\n\n"
                return
            except (asyncio.TimeoutError, ConnectionError, TimeoutError, OSError) as exc:
                if attempt < max_tries - 1:
                    delay = base_delay * (2**attempt)
                    reason = "Model timed out" if isinstance(exc, (asyncio.TimeoutError, TimeoutError)) else "Connection interrupted"
                    yield f"data: {_json.dumps({'type': 'rate_limited', 'message': f'{reason}, retrying in {delay:.1f}s...', 'reset': bool(accumulated), 'question_id': question.id})}\n\n"
                    await sleep_impl(delay)
                    continue
                yield f"data: {_json.dumps({'type': 'error', 'message': f'Request timed out or lost connection contacting Gemini: {exc}', 'question_id': question.id})}\n\n"
                return
            except Exception as exc:
                yield f"data: {_json.dumps({'type': 'error', 'message': str(exc), 'question_id': question.id})}\n\n"
                return
    finally:
        if owns_client and getattr(active_client, "aio", None) is not None:
            try:
                await active_client.aio.aclose()
            except Exception:
                pass

    if not accumulated.strip():
        yield f"data: {_json.dumps({'type': 'error', 'message': 'Gemini returned an empty answer.', 'question_id': question.id})}\n\n"
        return

    cleaned = _clean_generated_text(accumulated, question.type)
    expl_wc, total_wc = count_explanation_words(cleaned, question.type)
    est_lines = estimate_handwritten_lines(total_wc)
    length_warning = not is_within_range(expl_wc, word_range)

    # Cache base answers (and improved Fix-length results that landed inside range)
    if (not is_custom_followup) or (is_fix_length and not length_warning):
        answer_cache.set(
            cache_key,
            {
                "answer": cleaned,
                "explanation_word_count": expl_wc,
                "total_word_count": total_wc,
                "estimated_lines": est_lines,
                "length_warning": length_warning,
                "attempts": 1,
            },
        )

    yield f"data: {_json.dumps({'type': 'done', 'question_id': question.id, 'text': cleaned, 'word_count': total_wc, 'explanation_word_count': expl_wc, 'estimated_lines': est_lines, 'min_words': word_range.min_words, 'max_words': word_range.max_words, 'target_words': word_range.target_words, 'length_warning': length_warning, 'cached': False})}\n\n"
