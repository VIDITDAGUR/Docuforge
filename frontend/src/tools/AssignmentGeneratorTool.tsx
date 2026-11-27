import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { ToolDefinition } from '../types/tools';
import { FileDropzone } from '../components/common/FileDropzone';
import { StatusBanner } from '../components/common/StatusBanner';
import { useStagedToolFiles } from '../hooks/useStagedToolFiles';
import { triggerBlobDownload } from '../utils/fileValidation';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const PROFILE_STORAGE_KEY = 'docuforge_assignment_profile_v1';

type QuestionType =
  | 'define'
  | 'explain'
  | 'compare'
  | 'numerical'
  | 'code'
  | 'derivation'
  | 'diagram'
  | 'short_note'
  | 'case_study'
  | 'other';

const QUESTION_TYPES: QuestionType[] = [
  'define',
  'explain',
  'compare',
  'numerical',
  'code',
  'derivation',
  'diagram',
  'short_note',
  'case_study',
  'other',
];

interface AssignmentQuestion {
  id: string;
  number: string;
  part: string;
  text: string;
  marks: number | null;
  type: QuestionType;
  confidence: number;
  needs_review: boolean;
  review_reason?: string | null;
}

interface CoursePreset {
  id: string;
  course_name: string;
  section: string;
  tone_style_notes: string;
  answer_format_rules: string;
  words_per_mark_min: number;
  words_per_mark_max: number;
  explicit_overrides: Record<string, number[]>;
  is_custom?: boolean;
}

interface ModelOption {
  id: string;
  label: string;
}

interface PresetCatalogResponse {
  default_words_per_mark_min: number;
  default_words_per_mark_max: number;
  explicit_overrides: Record<string, number[]>;
  sections: string[];
  presets: CoursePreset[];
  default_model: string;
  available_models: ModelOption[];
  max_upload_mb: number;
  gemini_configured: boolean;
}

interface TokenUsage {
  prompt_tokens: number;
  candidates_tokens: number;
  thoughts_tokens: number;
  total_tokens: number;
  api_calls: number;
  cache_hits: number;
}

interface GeneratedAnswerItem {
  question_id: string;
  number: string;
  part: string;
  question_text: string;
  marks: number;
  type: QuestionType;
  answer: string;
  explanation_word_count: number;
  total_word_count: number;
  min_words: number;
  max_words: number;
  target_words: number;
  estimated_lines: number;
  length_warning: boolean;
  attempts: number;
  cached: boolean;
  error?: string | null;
}

interface GenerationJobResponse {
  job_id: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  completed: number;
  total: number;
  progress_label: string;
  results: GeneratedAnswerItem[];
  token_usage: TokenUsage;
  error?: string | null;
}

interface StudentProfile {
  name: string;
  roll_no: string;
}

function loadSavedProfile(): StudentProfile {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        name: String(parsed?.name || ''),
        roll_no: String(parsed?.roll_no || ''),
      };
    }
  } catch {
    // ignore storage errors
  }
  return { name: '', roll_no: '' };
}

function computeClientWordStats(text: string): { words: number; lines: number } {
  const matches = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g);
  const words = matches ? matches.length : 0;
  const lines = words > 0 ? Math.max(1, Math.ceil(words / 11)) : 0;
  return { words, lines };
}

function previewWordRange(
  marks: number | null,
  wMin: number,
  wMax: number,
  overrides: Record<string, number[]>
): string {
  if (!marks || marks <= 0) return 'Set marks';
  const key = Number.isInteger(marks) ? String(marks) : String(marks);
  const ov = overrides[key];
  if (ov && ov.length === 2) {
    return `${ov[0]}-${ov[1]}w`;
  }
  const lo = Math.round(marks * Math.min(wMin, wMax));
  const hi = Math.round(marks * Math.max(wMin, wMax));
  return `${lo}-${hi}w`;
}

const AssignmentGeneratorTool: React.FC<{ tool: ToolDefinition }> = ({ tool }) => {
  const [step, setStep] = useState<'setup' | 'review' | 'answers'>('setup');
  const [files, setFiles] = useState<File[]>([]);
  const [catalog, setCatalog] = useState<PresetCatalogResponse | null>(null);

  // Settings & profile state
  const [presetId, setPresetId] = useState<string>('btech-cse');
  const [subjectHint, setSubjectHint] = useState<string>('');
  const [wordsPerMarkMin, setWordsPerMarkMin] = useState<number>(30);
  const [wordsPerMarkMax, setWordsPerMarkMax] = useState<number>(40);
  const [selectedModel, setSelectedModel] = useState<string>('gemini-3.5-flash');
  const [concurrency, setConcurrency] = useState<number>(2);
  const [useCache, setUseCache] = useState<boolean>(true);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState<boolean>(false);
  const [profile, setProfile] = useState<StudentProfile>(loadSavedProfile);
  const [assignmentTitle, setAssignmentTitle] = useState<string>('Assignment Answers');

  // Workflow data
  const [questions, setQuestions] = useState<AssignmentQuestion[]>([]);
  const [extractionNote, setExtractionNote] = useState<string | null>(null);
  const [answers, setAnswers] = useState<GeneratedAnswerItem[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);

  // UI feedback
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [exportingType, setExportingType] = useState<'pdf' | 'docx' | null>(null);

  const pollTimerRef = useRef<number | null>(null);

  useStagedToolFiles(tool.acceptedExtensions, tool.maxSizeMB, false, (incoming) => {
    setFiles(incoming);
    if (incoming[0]?.name) {
      const stem = incoming[0].name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
      if (stem) setAssignmentTitle(`${stem} — Answers`);
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    } catch {
      // ignore storage errors
    }
  }, [profile]);

  useEffect(() => {
    let active = true;
    const fetchPresets = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/assignments/presets`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: PresetCatalogResponse = await res.json();
        if (!active) return;
        setCatalog(data);
        setWordsPerMarkMin(data.default_words_per_mark_min);
        setWordsPerMarkMax(data.default_words_per_mark_max);
        if (data.default_model) setSelectedModel(data.default_model);
      } catch {
        if (active) {
          setError('Could not load course presets from the DOCUFORGE backend.');
        }
      }
    };
    void fetchPresets();
    return () => {
      active = false;
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
    };
  }, []);

  const selectedPreset = useMemo(
    () => catalog?.presets.find((p) => p.id === presetId) ?? null,
    [catalog, presetId]
  );

  const mergedExplicitOverrides = useMemo(() => {
    return {
      ...(catalog?.explicit_overrides || {}),
      ...(selectedPreset?.explicit_overrides || {}),
    };
  }, [catalog, selectedPreset]);

  const handlePresetChange = (nextId: string) => {
    setPresetId(nextId);
    const nextPreset = catalog?.presets.find((p) => p.id === nextId);
    if (nextPreset) {
      setWordsPerMarkMin(nextPreset.words_per_mark_min);
      setWordsPerMarkMax(nextPreset.words_per_mark_max);
      if (nextPreset.is_custom) setShowAdvancedSettings(true);
    }
  };

  const handleParseFile = async () => {
    if (files.length === 0) return;
    setError(null);
    setBusyLabel('Extracting text/pages and parsing questions with Gemini...');

    try {
      const formData = new FormData();
      formData.append('file', files[0]);
      const res = await fetch(
        `${API_BASE}/api/assignments/parse?model=${encodeURIComponent(selectedModel)}`,
        {
          method: 'POST',
          body: formData,
        }
      );

      if (!res.ok) {
        let msg = `Parsing failed (HTTP ${res.status}).`;
        try {
          const payload = await res.json();
          if (payload?.detail) msg = payload.detail;
        } catch {
          // ignore
        }
        throw new Error(msg);
      }

      const data = await res.json();
      setQuestions(data.questions || []);
      setTokenUsage(data.token_usage || null);
      setExtractionNote(
        `Parsed ${data.questions?.length ?? 0} question(s) from "${data.filename}" (${data.extraction_method}, ${data.page_count} page(s)).`
      );
      if (data.filename) {
        const stem = String(data.filename).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
        if (stem) setAssignmentTitle(`${stem} — Answers`);
      }
      setStep('review');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to parse assignment file.');
    } finally {
      setBusyLabel(null);
    }
  };

  const handleStartManualEntry = () => {
    setError(null);
    setExtractionNote('Manual entry mode — add your assignment questions and marks below.');
    setQuestions([
      {
        id: 'Q1',
        number: '1',
        part: '',
        text: '',
        marks: 5,
        type: 'explain',
        confidence: 1,
        needs_review: false,
        review_reason: null,
      },
    ]);
    setStep('review');
  };

  const updateQuestionRow = (idx: number, patch: Partial<AssignmentQuestion>) => {
    setQuestions((prev) =>
      prev.map((q, i) => {
        if (i !== idx) return q;
        const next = { ...q, ...patch };
        next.id = `Q${next.number.trim() || String(idx + 1)}${next.part.trim()}`;
        const hasValidMarks = typeof next.marks === 'number' && next.marks > 0;
        const hasText = next.text.trim().length >= 6;
        if (hasValidMarks && hasText && (patch.marks !== undefined || patch.text !== undefined)) {
          next.needs_review = false;
          next.review_reason = null;
        }
        return next;
      })
    );
  };

  const addQuestionRow = () => {
    const nextNum = String(questions.length + 1);
    setQuestions((prev) => [
      ...prev,
      {
        id: `Q${nextNum}`,
        number: nextNum,
        part: '',
        text: '',
        marks: 5,
        type: 'explain',
        confidence: 1,
        needs_review: true,
        review_reason: 'Manually added — verify text and marks',
      },
    ]);
  };

  const deleteQuestionRow = (idx: number) => {
    setQuestions((prev) => prev.filter((_, i) => i !== idx));
  };

  const pollGenerationJob = async (jobId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/assignments/jobs/${jobId}`);
      if (!res.ok) throw new Error(`Failed to read job progress (HTTP ${res.status}).`);
      const job: GenerationJobResponse = await res.json();

      if (job.status === 'done') {
        setAnswers(job.results || []);
        setTokenUsage(job.token_usage || null);
        setBusyLabel(null);
        setStep('answers');
        return;
      }

      if (job.status === 'failed') {
        setError(job.error || 'Answer generation failed.');
        setBusyLabel(null);
        return;
      }

      setBusyLabel(job.progress_label || `Generating ${job.completed}/${job.total}...`);
      pollTimerRef.current = window.setTimeout(() => void pollGenerationJob(jobId), 800);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Lost connection while polling job progress.');
      setBusyLabel(null);
    }
  };

  const handleConfirmAndGenerate = async () => {
    setError(null);
    if (questions.length === 0) {
      setError('Add at least one question before generating answers.');
      return;
    }

    const invalid = questions.find((q) => !q.text.trim() || !q.marks || q.marks <= 0);
    if (invalid) {
      setError(
        `Please enter valid question text and positive marks for ${invalid.id || 'every row'} before confirming.`
      );
      return;
    }

    setBusyLabel(`Generating 0/${questions.length}...`);
    try {
      const res = await fetch(`${API_BASE}/api/assignments/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questions,
          preset_id: presetId,
          subject_hint: subjectHint,
          words_per_mark_min: wordsPerMarkMin,
          words_per_mark_max: wordsPerMarkMax,
          model: selectedModel,
          concurrency,
          use_cache: useCache,
        }),
      });

      if (!res.ok) {
        let msg = `Failed to start generation (HTTP ${res.status}).`;
        try {
          const payload = await res.json();
          if (payload?.detail) msg = payload.detail;
        } catch {
          // ignore
        }
        throw new Error(msg);
      }

      const job: GenerationJobResponse = await res.json();
      setBusyLabel(job.progress_label || `Generating 0/${questions.length}...`);
      pollTimerRef.current = window.setTimeout(() => void pollGenerationJob(job.job_id), 600);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to start answer generation.');
      setBusyLabel(null);
    }
  };

  const handleRegenerateSingle = async (idx: number) => {
    const target = answers[idx];
    if (!target) return;
    setError(null);
    setRegeneratingId(target.question_id);

    try {
      const matchedQ = questions.find((q) => q.id === target.question_id);
      const qPayload: AssignmentQuestion = matchedQ || {
        id: target.question_id,
        number: target.number,
        part: target.part,
        text: target.question_text,
        marks: target.marks,
        type: target.type,
        confidence: 1,
        needs_review: false,
      };

      const res = await fetch(`${API_BASE}/api/assignments/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: qPayload,
          preset_id: presetId,
          subject_hint: subjectHint,
          words_per_mark_min: wordsPerMarkMin,
          words_per_mark_max: wordsPerMarkMax,
          model: selectedModel,
          bypass_cache: true,
        }),
      });

      if (!res.ok) {
        let msg = `Regeneration failed (HTTP ${res.status}).`;
        try {
          const payload = await res.json();
          if (payload?.detail) msg = payload.detail;
        } catch {
          // ignore
        }
        throw new Error(msg);
      }

      const data: { item: GeneratedAnswerItem; token_usage: TokenUsage } = await res.json();
      setAnswers((prev) => prev.map((it, i) => (i === idx ? data.item : it)));
      if (data.token_usage) {
        setTokenUsage((prev) => ({
          prompt_tokens: (prev?.prompt_tokens || 0) + data.token_usage.prompt_tokens,
          candidates_tokens: (prev?.candidates_tokens || 0) + data.token_usage.candidates_tokens,
          thoughts_tokens: (prev?.thoughts_tokens || 0) + data.token_usage.thoughts_tokens,
          total_tokens: (prev?.total_tokens || 0) + data.token_usage.total_tokens,
          api_calls: (prev?.api_calls || 0) + data.token_usage.api_calls,
          cache_hits: (prev?.cache_hits || 0) + data.token_usage.cache_hits,
        }));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to regenerate answer.');
    } finally {
      setRegeneratingId(null);
    }
  };

  const handleAnswerEdit = (idx: number, nextText: string) => {
    setAnswers((prev) =>
      prev.map((item, i) => {
        if (i !== idx) return item;
        const { words, lines } = computeClientWordStats(nextText);
        const within = words >= item.min_words && words <= item.max_words;
        return {
          ...item,
          answer: nextText,
          explanation_word_count: words,
          total_word_count: words,
          estimated_lines: lines,
          length_warning: !within,
        };
      })
    );
  };

  const handleCopyAnswer = async (item: GeneratedAnswerItem) => {
    const label = `${item.question_id}. [${item.marks} Marks] ${item.question_text}\n\n${item.answer}`;
    try {
      await navigator.clipboard.writeText(label);
      setCopiedId(item.question_id);
      window.setTimeout(() => setCopiedId((cur) => (cur === item.question_id ? null : cur)), 1500);
    } catch {
      setError('Clipboard access blocked. Please select and copy text manually.');
    }
  };

  const handleExport = async (fmt: 'pdf' | 'docx') => {
    if (answers.length === 0) return;
    setError(null);
    setExportingType(fmt);
    try {
      const res = await fetch(`${API_BASE}/api/assignments/export/${fmt}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: assignmentTitle,
          course_name: selectedPreset?.course_name || presetId,
          subject_hint: subjectHint,
          profile,
          items: answers,
        }),
      });
      if (!res.ok) {
        let msg = `Export failed (HTTP ${res.status}).`;
        try {
          const payload = await res.json();
          if (payload?.detail) msg = payload.detail;
        } catch {
          // ignore
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const safeTitle =
        assignmentTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') ||
        'assignment_answers';
      triggerBlobDownload(blob, `${safeTitle}.${fmt}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : `Failed to export ${fmt.toUpperCase()}.`);
    } finally {
      setExportingType(null);
    }
  };

  const handleResetAll = () => {
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
    setFiles([]);
    setQuestions([]);
    setAnswers([]);
    setExtractionNote(null);
    setBusyLabel(null);
    setError(null);
    setStep('setup');
  };

  const totalMarks = useMemo(
    () => questions.reduce((acc, q) => acc + (typeof q.marks === 'number' && q.marks > 0 ? q.marks : 0), 0),
    [questions]
  );

  const reviewCount = useMemo(() => questions.filter((q) => q.needs_review).length, [questions]);

  const totalEstimatedLines = useMemo(
    () => answers.reduce((acc, item) => acc + item.estimated_lines, 0),
    [answers]
  );

  return (
    <div className="space-y-5">
      {/* Stepper Header */}
      <div className="border border-[#E5E5E5] bg-[#F5F5F5] px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-2 font-mono">
          <button
            type="button"
            onClick={() => setStep('setup')}
            className={`px-2.5 py-1 border cursor-pointer ${
              step === 'setup'
                ? 'bg-[#222222] text-white border-[#222222]'
                : 'bg-white text-[#222222] border-[#E5E5E5]'
            }`}
          >
            1. Setup & Upload
          </button>
          <span className="text-[#777777]">&rarr;</span>
          <button
            type="button"
            disabled={questions.length === 0}
            onClick={() => setStep('review')}
            className={`px-2.5 py-1 border cursor-pointer disabled:opacity-50 ${
              step === 'review'
                ? 'bg-[#222222] text-white border-[#222222]'
                : 'bg-white text-[#222222] border-[#E5E5E5]'
            }`}
          >
            2. Review Questions ({questions.length})
          </button>
          <span className="text-[#777777]">&rarr;</span>
          <button
            type="button"
            disabled={answers.length === 0}
            onClick={() => setStep('answers')}
            className={`px-2.5 py-1 border cursor-pointer disabled:opacity-50 ${
              step === 'answers'
                ? 'bg-[#222222] text-white border-[#222222]'
                : 'bg-white text-[#222222] border-[#E5E5E5]'
            }`}
          >
            3. Answers & Export ({answers.length})
          </button>
        </div>

        {(questions.length > 0 || files.length > 0) && (
          <button
            type="button"
            onClick={handleResetAll}
            className="df-btn-light px-2.5 py-1 text-xs inline-flex items-center gap-1 cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
            New Assignment
          </button>
        )}
      </div>

      {catalog && !catalog.gemini_configured && (
        <StatusBanner
          type="info"
          message="GEMINI_API_KEY is not set in the server environment (.env). You can edit questions or inspect presets, and add GEMINI_API_KEY in .env to enable AI parsing & generation."
        />
      )}

      {error && <StatusBanner type="error" message={error} />}
      {busyLabel && <StatusBanner type="loading" message={busyLabel} />}

      {/* STEP 1: SETUP & UPLOAD */}
      {step === 'setup' && (
        <div className="space-y-4">
          {/* Course Preset & Student Settings Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-7 border border-[#E5E5E5] bg-white p-4 space-y-3">
              <div className="flex items-center justify-between border-b border-[#E5E5E5] pb-2">
                <h2 className="text-sm font-semibold text-[#222222]">
                  Course Preset & Subject Style
                </h2>
                <button
                  type="button"
                  onClick={() => setShowAdvancedSettings((v) => !v)}
                  className="text-xs text-[#555555] hover:text-[#222222] inline-flex items-center gap-1 cursor-pointer"
                >
                  <Settings className="w-3.5 h-3.5" />
                  {showAdvancedSettings ? 'Hide Length / Quota Settings' : 'Length & Model Settings'}
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="course-preset"
                    className="block text-xs font-medium text-[#222222] mb-1"
                  >
                    Course / Program
                  </label>
                  <select
                    id="course-preset"
                    value={presetId}
                    onChange={(e) => handlePresetChange(e.target.value)}
                    className="w-full border border-[#CCCCCC] bg-white px-2.5 py-2 text-xs text-[#222222]"
                  >
                    {catalog ? (
                      catalog.sections.map((section) => (
                        <optgroup key={section} label={section}>
                          {catalog.presets
                            .filter((p) => p.section === section)
                            .map((preset) => (
                              <option key={preset.id} value={preset.id}>
                                {preset.course_name}
                              </option>
                            ))}
                        </optgroup>
                      ))
                    ) : (
                      <option value="btech-cse">Loading courses...</option>
                    )}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="subject-hint"
                    className="block text-xs font-medium text-[#222222] mb-1"
                  >
                    Subject Style Hint (optional)
                  </label>
                  <input
                    id="subject-hint"
                    type="text"
                    value={subjectHint}
                    onChange={(e) => setSubjectHint(e.target.value)}
                    placeholder="e.g., Operating Systems, Cost Accounting"
                    className="w-full border border-[#CCCCCC] bg-white px-2.5 py-2 text-xs text-[#222222]"
                  />
                </div>
              </div>

              {selectedPreset && (
                <div className="border border-[#E5E5E5] bg-[#F5F5F5] p-2.5 text-xs text-[#555555]">
                  <span className="font-semibold text-[#222222]">Preset Style: </span>
                  {selectedPreset.tone_style_notes}
                </div>
              )}

              {(showAdvancedSettings || selectedPreset?.is_custom) && (
                <div className="border-t border-[#E5E5E5] pt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-[#222222] mb-1">
                      Min words / mark
                    </label>
                    <input
                      type="number"
                      min={5}
                      max={200}
                      value={wordsPerMarkMin}
                      onChange={(e) => setWordsPerMarkMin(Number(e.target.value) || 30)}
                      className="w-full border border-[#CCCCCC] px-2 py-1.5 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-[#222222] mb-1">
                      Max words / mark
                    </label>
                    <input
                      type="number"
                      min={5}
                      max={250}
                      value={wordsPerMarkMax}
                      onChange={(e) => setWordsPerMarkMax(Number(e.target.value) || 40)}
                      className="w-full border border-[#CCCCCC] px-2 py-1.5 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-[#222222] mb-1">
                      Gemini Model
                    </label>
                    <select
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      className="w-full border border-[#CCCCCC] bg-white px-2 py-1.5 text-xs"
                    >
                      {(catalog?.available_models || [
                        { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
                        { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
                        { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
                      ]).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-[#222222] mb-1">
                      Concurrency
                    </label>
                    <select
                      value={concurrency}
                      onChange={(e) => setConcurrency(Number(e.target.value))}
                      className="w-full border border-[#CCCCCC] bg-white px-2 py-1.5 text-xs font-mono"
                    >
                      <option value={1}>1 (Sequential)</option>
                      <option value={2}>2 (Recommended)</option>
                      <option value={3}>3 (Faster)</option>
                    </select>
                  </div>
                  <div className="col-span-2 sm:col-span-4 flex items-center gap-2 text-xs text-[#555555]">
                    <input
                      id="use-cache-toggle"
                      type="checkbox"
                      checked={useCache}
                      onChange={(e) => setUseCache(e.target.checked)}
                    />
                    <label htmlFor="use-cache-toggle">
                      Enable SHA-256 disk answer cache (reruns of unchanged questions cost zero tokens)
                    </label>
                  </div>
                </div>
              )}
            </div>

            <div className="lg:col-span-5 border border-[#E5E5E5] bg-white p-4 space-y-3">
              <div className="border-b border-[#E5E5E5] pb-2">
                <h2 className="text-sm font-semibold text-[#222222]">
                  Student Notebook Header Profile
                </h2>
                <p className="text-[11px] text-[#777777] mt-0.5">
                  Printed on every exported PDF &amp; DOCX page header. Saved locally in your browser.
                </p>
              </div>
              <div className="space-y-2.5">
                <div>
                  <label className="block text-xs font-medium text-[#222222] mb-1">
                    Submitted by (Student Name)
                  </label>
                  <input
                    type="text"
                    value={profile.name}
                    onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
                    placeholder="e.g., Aarav Verma"
                    className="w-full border border-[#CCCCCC] px-2.5 py-1.5 text-xs text-[#222222]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#222222] mb-1">
                    Roll No. / Enrollment No.
                  </label>
                  <input
                    type="text"
                    value={profile.roll_no}
                    onChange={(e) => setProfile((p) => ({ ...p, roll_no: e.target.value }))}
                    placeholder="e.g., 23BCS1042"
                    className="w-full border border-[#CCCCCC] px-2.5 py-1.5 text-xs text-[#222222]"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Upload Area */}
          <FileDropzone
            acceptedExtensions={tool.acceptedExtensions}
            formatsLabel={tool.formatsLabel}
            maxSizeMB={tool.maxSizeMB}
            multiple={false}
            files={files}
            onFilesSelected={(next) => {
              setFiles(next);
              setError(null);
            }}
            onError={setError}
            onReset={() => setFiles([])}
          />

          <div className="flex flex-wrap items-center justify-between gap-3 border border-[#E5E5E5] bg-[#F5F5F5] p-4">
            <div className="text-xs text-[#555555]">
              PDFs with selectable text are extracted locally via PyMuPDF; scanned PDFs and photos are read via Gemini multimodal.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleStartManualEntry}
                disabled={Boolean(busyLabel)}
                className="df-btn-light px-3.5 py-2 text-xs font-medium cursor-pointer"
              >
                Or Enter Questions Manually
              </button>
              <button
                type="button"
                disabled={files.length === 0 || Boolean(busyLabel)}
                onClick={handleParseFile}
                className="df-btn-dark px-4 py-2 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Extract &amp; Parse Questions
              </button>
            </div>
          </div>
        </div>
      )}

      {/* STEP 2: EDITABLE QUESTION REVIEW TABLE */}
      {step === 'review' && (
        <div className="space-y-4">
          {extractionNote && <StatusBanner type="info" message={extractionNote} />}

          {reviewCount > 0 && (
            <div className="border border-[#D97706] bg-[#FFFBEB] px-3.5 py-2.5 text-xs text-[#92400E] flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[#D97706]" />
              <span>
                <strong>{reviewCount} question(s)</strong> need review (highlighted in yellow) due to missing marks or low extraction confidence. Please confirm marks before generating.
              </span>
            </div>
          )}

          <div className="border border-[#E5E5E5] bg-white">
            <div className="bg-[#F5F5F5] border-b border-[#E5E5E5] px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold text-[#222222]">
                Review Extracted Questions ({questions.length} total &middot; {totalMarks} marks)
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={addQuestionRow}
                  className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Question
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[#E5E5E5] bg-[#FAFAFA] text-[#555555] font-mono">
                    <th className="p-2.5 w-16">No.</th>
                    <th className="p-2.5 w-16">Part</th>
                    <th className="p-2.5 min-w-[260px]">Question Text</th>
                    <th className="p-2.5 w-24">Marks</th>
                    <th className="p-2.5 w-32">Type</th>
                    <th className="p-2.5 w-24">Target</th>
                    <th className="p-2.5 w-14 text-center">Del</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E5E5E5]">
                  {questions.map((q, idx) => (
                    <tr
                      key={`${q.id}-${idx}`}
                      className={
                        q.needs_review
                          ? 'bg-[#FFFBEB] border-l-4 border-l-[#D97706]'
                          : 'bg-white'
                      }
                    >
                      <td className="p-2 align-top">
                        <input
                          type="text"
                          value={q.number}
                          onChange={(e) => updateQuestionRow(idx, { number: e.target.value })}
                          className="w-full border border-[#CCCCCC] bg-white px-2 py-1 font-mono"
                          aria-label={`Question ${idx + 1} number`}
                        />
                      </td>
                      <td className="p-2 align-top">
                        <input
                          type="text"
                          value={q.part}
                          onChange={(e) => updateQuestionRow(idx, { part: e.target.value })}
                          placeholder="-"
                          className="w-full border border-[#CCCCCC] bg-white px-2 py-1 font-mono"
                          aria-label={`Question ${idx + 1} part`}
                        />
                      </td>
                      <td className="p-2 align-top">
                        <textarea
                          rows={2}
                          value={q.text}
                          onChange={(e) => updateQuestionRow(idx, { text: e.target.value })}
                          placeholder="Enter question prompt..."
                          className="w-full border border-[#CCCCCC] bg-white px-2 py-1 leading-relaxed"
                          aria-label={`Question ${idx + 1} text`}
                        />
                        {q.needs_review && (
                          <div className="text-[11px] text-[#B45309] mt-1 font-medium">
                            Needs Review{q.review_reason ? `: ${q.review_reason}` : ''}
                          </div>
                        )}
                      </td>
                      <td className="p-2 align-top">
                        <input
                          type="number"
                          min={0.5}
                          step={0.5}
                          max={100}
                          value={q.marks ?? ''}
                          onChange={(e) => {
                            const v = e.target.value === '' ? null : Number(e.target.value);
                            updateQuestionRow(idx, { marks: v });
                          }}
                          placeholder="?"
                          className={`w-full border px-2 py-1 font-mono ${
                            !q.marks || q.marks <= 0
                              ? 'border-[#D97706] bg-[#FFFDF5]'
                              : 'border-[#CCCCCC] bg-white'
                          }`}
                          aria-label={`Question ${idx + 1} marks`}
                        />
                      </td>
                      <td className="p-2 align-top">
                        <select
                          value={q.type}
                          onChange={(e) =>
                            updateQuestionRow(idx, { type: e.target.value as QuestionType })
                          }
                          className="w-full border border-[#CCCCCC] bg-white px-1.5 py-1"
                          aria-label={`Question ${idx + 1} type`}
                        >
                          {QUESTION_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="p-2 align-top font-mono text-[11px] text-[#555555] whitespace-nowrap pt-3">
                        {previewWordRange(
                          q.marks,
                          wordsPerMarkMin,
                          wordsPerMarkMax,
                          mergedExplicitOverrides
                        )}
                      </td>
                      <td className="p-2 align-top text-center pt-2.5">
                        <button
                          type="button"
                          onClick={() => deleteQuestionRow(idx)}
                          title="Delete row"
                          className="text-[#777777] hover:text-[#222222] p-1 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="border border-[#E5E5E5] bg-[#F5F5F5] p-4 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setStep('setup')}
              className="df-btn-light px-3.5 py-2 text-xs font-medium cursor-pointer"
            >
              &larr; Back to Settings &amp; Upload
            </button>
            <button
              type="button"
              disabled={Boolean(busyLabel) || questions.length === 0}
              onClick={handleConfirmAndGenerate}
              className="df-btn-dark px-5 py-2 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Confirm &amp; Generate {questions.length} Answer(s)
            </button>
          </div>
        </div>
      )}

      {/* STEP 3: GENERATED ANSWERS & EXPORT */}
      {step === 'answers' && (
        <div className="space-y-4">
          {/* Export & Quota Summary Toolbar */}
          <div className="border border-[#E5E5E5] bg-[#F5F5F5] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-[#222222]">
                  Generated Answers ({answers.length})
                </h2>
                <div className="text-xs text-[#555555] mt-0.5 flex flex-wrap gap-x-3 gap-y-1 font-mono">
                  <span>Course: {selectedPreset?.course_name || presetId}</span>
                  <span>Est. notebook space: ~{totalEstimatedLines} lines total</span>
                  {tokenUsage && (
                    <span>
                      Tokens: {tokenUsage.total_tokens} (in {tokenUsage.prompt_tokens} / out{' '}
                      {tokenUsage.candidates_tokens}, cache hits {tokenUsage.cache_hits})
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep('review')}
                  className="df-btn-light px-3 py-1.5 text-xs font-medium cursor-pointer"
                >
                  Edit Questions
                </button>
                <button
                  type="button"
                  disabled={exportingType !== null}
                  onClick={() => handleExport('docx')}
                  className="df-btn-light px-3.5 py-1.5 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  {exportingType === 'docx' ? 'Exporting DOCX...' : 'Export DOCX'}
                </button>
                <button
                  type="button"
                  disabled={exportingType !== null}
                  onClick={() => handleExport('pdf')}
                  className="df-btn-dark px-3.5 py-1.5 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  {exportingType === 'pdf' ? 'Exporting PDF...' : 'Export PDF'}
                </button>
              </div>
            </div>

            {/* Header customization strip */}
            <div className="border-t border-[#E5E5E5] pt-3 grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
              <div>
                <label className="block text-[11px] text-[#555555] mb-1">Export Title</label>
                <input
                  type="text"
                  value={assignmentTitle}
                  onChange={(e) => setAssignmentTitle(e.target.value)}
                  className="w-full border border-[#CCCCCC] bg-white px-2 py-1"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[#555555] mb-1">
                  Header: Submitted by
                </label>
                <input
                  type="text"
                  value={profile.name}
                  onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
                  placeholder="Student Name"
                  className="w-full border border-[#CCCCCC] bg-white px-2 py-1"
                />
              </div>
              <div>
                <label className="block text-[11px] text-[#555555] mb-1">Header: Roll No.</label>
                <input
                  type="text"
                  value={profile.roll_no}
                  onChange={(e) => setProfile((p) => ({ ...p, roll_no: e.target.value }))}
                  placeholder="Roll Number"
                  className="w-full border border-[#CCCCCC] bg-white px-2 py-1"
                />
              </div>
            </div>
          </div>

          {/* Per-Answer Editable Cards */}
          <div className="space-y-3">
            {answers.map((item, idx) => (
              <div key={`${item.question_id}-${idx}`} className="border border-[#E5E5E5] bg-white">
                <div className="bg-[#FAFAFA] border-b border-[#E5E5E5] px-4 py-2.5 flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1 max-w-3xl">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono font-bold bg-[#222222] text-white px-2 py-0.5">
                        {item.question_id}
                      </span>
                      <span className="font-mono border border-[#E5E5E5] bg-white px-2 py-0.5 text-[#222222]">
                        {item.marks} {item.marks === 1 ? 'Mark' : 'Marks'}
                      </span>
                      <span className="font-mono border border-[#E5E5E5] bg-white px-2 py-0.5 text-[#555555]">
                        {item.type}
                      </span>
                      {item.cached && (
                        <span className="font-mono border border-[#E5E5E5] bg-white px-2 py-0.5 text-[#555555]">
                          Cached
                        </span>
                      )}
                    </div>
                    <p className="text-xs sm:text-sm font-semibold text-[#222222]">
                      {item.question_text}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleCopyAnswer(item)}
                      className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
                    >
                      {copiedId === item.question_id ? (
                        <>
                          <Check className="w-3.5 h-3.5" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          Copy
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={regeneratingId === item.question_id}
                      onClick={() => handleRegenerateSingle(idx)}
                      className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1 cursor-pointer"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${
                          regeneratingId === item.question_id ? 'animate-spin' : ''
                        }`}
                      />
                      {regeneratingId === item.question_id ? 'Regenerating...' : 'Regenerate'}
                    </button>
                  </div>
                </div>

                <div className="p-4 space-y-2.5">
                  {item.error && (
                    <StatusBanner type="error" message={`Generation error: ${item.error}`} />
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      {!item.length_warning ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 border border-[#059669] bg-[#ECFDF5] text-[#065F46] font-mono">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Within range: {item.explanation_word_count} words ({item.min_words}-
                          {item.max_words})
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 border border-[#D97706] bg-[#FFFBEB] text-[#92400E] font-mono">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          length_warning: {item.explanation_word_count} words (allowed{' '}
                          {item.min_words}-{item.max_words})
                        </span>
                      )}

                      {item.total_word_count !== item.explanation_word_count && (
                        <span className="font-mono text-[#666666]">
                          (Total with code/math: {item.total_word_count}w)
                        </span>
                      )}
                    </div>

                    <div className="font-mono text-[#555555]">
                      Est. handwritten space: <strong>~{item.estimated_lines} lines</strong> (10-12 words/line)
                    </div>
                  </div>

                  <textarea
                    rows={Math.max(4, Math.min(16, (item.answer || '').split('\n').length + 2))}
                    value={item.answer}
                    onChange={(e) => handleAnswerEdit(idx, e.target.value)}
                    className="w-full border border-[#E5E5E5] bg-[#FAFAFA] focus:bg-white p-3 text-xs sm:text-sm text-[#222222] leading-relaxed font-sans"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default AssignmentGeneratorTool;
