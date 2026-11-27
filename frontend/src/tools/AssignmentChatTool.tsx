/**
 * AssignmentChatTool — streaming chat workspace for marks-based assignment answers.
 *
 * Keeps all backend parsing, course presets, word-per-mark length calculation,
 * cache, and Gemini generation intact while providing a single chat-based UX.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ClipboardCopy,
  Download,
  Edit3,
  FileText,
  Loader2,
  Minus,
  Paperclip,
  Plus,
  RefreshCw,
  RotateCcw,
  SendHorizonal,
  Settings,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { ToolDefinition } from '../types/tools';
import { useStagedToolFiles } from '../hooks/useStagedToolFiles';
import {
  formatFileSize,
  triggerBlobDownload,
  validateFile,
} from '../utils/fileValidation';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const CHAT_STORAGE_KEY = 'docuforge_chat_v1';
const PROFILE_STORAGE_KEY = 'docuforge_chat_profile_v1';
const SETTINGS_STORAGE_KEY = 'docuforge_chat_settings_v1';
const ACCEPTED_EXTS = ['.pdf', '.docx', '.png', '.jpg', '.jpeg'];
const MAX_UPLOAD_MB = 20;
const QUICK_MARKS = [2, 5, 7, 10, 11];
const DEFAULT_MISSING_MARKS = 5;
const STREAM_CONCURRENCY = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface PresetsResponse {
  default_words_per_mark_min: number;
  default_words_per_mark_max: number;
  sections: string[];
  presets: CoursePreset[];
  default_model: string;
  available_models: { id: string; label: string }[];
  gemini_configured: boolean;
}

interface DonePayload {
  text?: string;
  word_count: number;
  explanation_word_count: number;
  estimated_lines: number;
  min_words: number;
  max_words: number;
  target_words?: number;
  length_warning: boolean;
  cached: boolean;
}

type AnswerMessageType = {
  id: string;
  role: 'assistant';
  type: 'answer';
  questionId: string;
  questionText: string;
  questionType: QuestionType;
  marks: number;
  label?: string;
  content: string;
  streaming: boolean;
  statusNotice?: string;
  done?: DonePayload;
  error?: string;
};

type QuestionListMessageType = {
  id: string;
  role: 'assistant';
  type: 'question_list';
  questions: AssignmentQuestion[];
  filename: string;
  extractionMethod?: string;
  pageCount?: number;
};

type ChatMessage =
  | {
      id: string;
      role: 'user';
      type: 'text';
      content: string;
    }
  | {
      id: string;
      role: 'user';
      type: 'file_chip';
      content: string;
      fileSize?: number;
    }
  | QuestionListMessageType
  | AnswerMessageType
  | {
      id: string;
      role: 'assistant';
      type: 'marks_prompt';
      questionText: string;
      resolvedMarks?: number;
    }
  | {
      id: string;
      role: 'assistant';
      type: 'text';
      content: string;
      loading?: boolean;
    }
  | {
      id: string;
      role: 'assistant';
      type: 'error';
      content: string;
    };

interface UserProfile {
  name: string;
  rollNo: string;
}

interface ChatSettings {
  presetId: string;
  subjectHint: string;
  wordsPerMarkMin: number;
  wordsPerMarkMax: number;
  customWpmActive: boolean;
  model: string;
}

// ---------------------------------------------------------------------------
// Pure Helpers
// ---------------------------------------------------------------------------

function uid(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function inferQuestionTypeClient(text: string): QuestionType {
  const low = text.trim().toLowerCase();
  if (/(?:\bprogram\b|\bcode\b|\bimplement\b|write a function|sql query|algorithm in )/.test(low)) {
    return 'code';
  }
  if (/(?:\bderive\b|\bderivation\b|prove that|show that)/.test(low)) return 'derivation';
  if (/(?:\bcalculate\b|\bfind the\b|\bnumerical\b|\bcompute\b)/.test(low)) return 'numerical';
  if (/(?:\bcompare\b|difference between|\bdifferentiate\b|distinguish between|\bvs\b)/.test(low)) {
    return 'compare';
  }
  if (/(?:\bdiagram\b|block diagram|neat sketch|\bdraw\b)/.test(low)) return 'diagram';
  if (/(?:short note|write notes on)/.test(low)) return 'short_note';
  if (/(?:case study|scenario)/.test(low)) return 'case_study';
  if (/^(?:define|what is|what are|meaning of)\b/.test(low)) return 'define';
  return 'explain';
}

/**
 * Detect marks notations: "7 marks", "7M", "Marks: 7", "(7)", "[7]"
 * (avoiding leading question prefixes like "(1) What is...").
 */
function detectMarksInText(raw: string): { marks: number | null; cleanedText: string } {
  const text = raw.trim();
  if (!text) return { marks: null, cleanedText: '' };

  const patterns: RegExp[] = [
    /\bmarks?\s*[:=\-]\s*(\d+(?:\.\d+)?)\b/i,
    /[\(\[]\s*(\d+(?:\.\d+)?)\s*(?:marks?|mark|pts?|points?|m)\s*[\)\]]/i,
    /(?:^|[\s,;])(\d+(?:\.\d+)?)\s*(?:marks?|mark)\b/i,
    /(?:^|[\s,;])(\d+(?:\.\d+)?)\s*M\b/i,
    /(?:\s)[\(\[]\s*(\d+(?:\.\d+)?)\s*[\)\]]\s*[?.!]*$/,
  ];

  for (const re of patterns) {
    const match = text.match(re);
    if (match) {
      const val = parseFloat(match[1]);
      if (!Number.isNaN(val) && val > 0 && val <= 100) {
        const cleaned = text
          .replace(match[0], ' ')
          .replace(/[,;\s]+$/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        return { marks: val, cleanedText: cleaned || text };
      }
    }
  }
  return { marks: null, cleanedText: text };
}

function parsePureMarksReply(raw: string): number | null {
  const low = raw.trim().toLowerCase();
  if (!low) return null;
  if (low === 'default' || low === 'use default' || low === 'skip') {
    return DEFAULT_MISSING_MARKS;
  }
  const match = low.match(/^(\d+(?:\.\d+)?)\s*(?:marks?|mark|m)?$/i);
  if (!match) return null;
  const val = parseFloat(match[1]);
  return !Number.isNaN(val) && val > 0 && val <= 100 ? val : null;
}

type FollowupIntent =
  | {
      kind: 'followup';
      action: 'shorter' | 'longer' | 'fix_length' | 'regenerate' | 'custom';
      targetQuestionRef?: string;
      instruction: string;
    }
  | { kind: 'new_question' };

function detectFollowupIntent(text: string, hasPriorAnswers: boolean): FollowupIntent {
  if (!hasPriorAnswers) return { kind: 'new_question' };
  const trimmed = text.trim();
  const low = trimmed.toLowerCase();

  // If user clearly supplied marks for a new question ("Explain X, 7 marks"), treat as new question
  // UNLESS it explicitly references Q1/Q2/regenerate.
  const qRefMatch = trimmed.match(/\b(q\s*\d+[a-z]?|question\s*\d+[a-z]?)\b/i);
  const targetQuestionRef = qRefMatch
    ? qRefMatch[1].replace(/\s+/g, '').replace(/^question/i, 'Q').toUpperCase()
    : undefined;

  if (/\b(regenerate|redo|retry)\b/i.test(low) || (targetQuestionRef && /^(redo|regenerate|try again)/i.test(low))) {
    return {
      kind: 'followup',
      action: 'regenerate',
      targetQuestionRef,
      instruction: trimmed,
    };
  }

  if (
    /\b(fix length|fix the length|fit range|match word range)\b/i.test(low) ||
    (targetQuestionRef && /\b(fix length|fix)\b/i.test(low))
  ) {
    return {
      kind: 'followup',
      action: 'fix_length',
      targetQuestionRef,
      instruction: 'Fix length to match the required word range',
    };
  }

  if (
    /^(?:make\s+(?:it|this|that|q\w+)\s+)?(?:shorter|brief(?:er)?|concise(?:r)?|condense|trim|shorten)\b/i.test(low) ||
    /\bmake\s+(?:it|this|q\w+)\s+shorter\b/i.test(low)
  ) {
    return {
      kind: 'followup',
      action: 'shorter',
      targetQuestionRef,
      instruction: trimmed,
    };
  }

  if (
    /^(?:make\s+(?:it|this|that|q\w+)\s+)?(?:longer|expand|elaborate|more detail(?:ed)?)\b/i.test(low) ||
    /\bmake\s+(?:it|this|q\w+)\s+longer\b/i.test(low)
  ) {
    return {
      kind: 'followup',
      action: 'longer',
      targetQuestionRef,
      instruction: trimmed,
    };
  }

  const followupVerbs =
    /^(?:add\b|include\b|give\s+an?\s+example|with\s+an?\s+example|rewrite\b|simplify\b|simpler\b|use\s+simple|make\s+it\b|change\s+(?:it|this)\b|in\s+that\s+answer|can\s+you\s+(?:add|make|rewrite|simplify|include))/i;

  if (followupVerbs.test(low) || Boolean(targetQuestionRef)) {
    return {
      kind: 'followup',
      action: 'custom',
      targetQuestionRef,
      instruction: trimmed,
    };
  }

  return { kind: 'new_question' };
}

function badgeColor(done: DonePayload): string {
  if (!done.length_warning) return '#15803D'; // crisp green
  const count = done.explanation_word_count || done.word_count;
  const pct = count < done.min_words ? count / done.min_words : done.max_words / count;
  return pct >= 0.85 ? '#B45309' : '#B91C1C';
}

function loadJsonStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } : fallback;
  } catch {
    return fallback;
  }
}

function loadMessagesStorage(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as ChatMessage[])
      .filter((m) => !(m.type === 'text' && m.role === 'assistant' && m.loading))
      .map((m) => {
        if (m.type !== 'answer') return m;
        const interrupted = !m.content && !m.done && !m.error;
        return {
          ...m,
          streaming: false,
          statusNotice: undefined,
          error: interrupted ? 'Stream interrupted — click Retry to generate.' : m.error,
        };
      });
  } catch {
    return [];
  }
}

function saveMessagesStorage(messages: ChatMessage[]): void {
  try {
    const clean = messages
      .filter((m) => !(m.type === 'text' && m.role === 'assistant' && m.loading))
      .map((m) => (m.type === 'answer' ? { ...m, streaming: false, statusNotice: undefined } : m));
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // ignore storage quota overflow
  }
}

// ---------------------------------------------------------------------------
// SSE streaming helper
// ---------------------------------------------------------------------------

interface StreamCallbacks {
  onToken: (chunk: string) => void;
  onRateLimit: (message: string, reset?: boolean) => void;
  signal?: AbortSignal;
}

async function readAnswerSse(
  url: string,
  body: Record<string, unknown>,
  callbacks: StreamCallbacks,
): Promise<DonePayload> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: callbacks.signal,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(errBody?.detail || `Server returned HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error('Streaming response body unavailable.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let donePayload: DonePayload | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.startsWith('data: ')) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        continue;
      }

      if (event.type === 'token' && typeof event.text === 'string') {
        callbacks.onToken(event.text);
      } else if (event.type === 'rate_limited') {
        callbacks.onRateLimit(
          typeof event.message === 'string' ? event.message : 'Rate limited, retrying...',
          Boolean(event.reset),
        );
      } else if (event.type === 'done') {
        donePayload = event as unknown as DonePayload;
      } else if (event.type === 'error') {
        throw new Error(
          typeof event.message === 'string' ? event.message : 'Answer generation failed.',
        );
      }
    }
  }

  if (!donePayload) {
    throw new Error('Stream ended unexpectedly before completion.');
  }
  return donePayload;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** User file attachment chip */
const FileChip: React.FC<{ filename: string; size?: number }> = ({ filename, size }) => (
  <span className="inline-flex items-center gap-2 border border-[#222222] bg-[#222222] px-3 py-1.5 text-xs text-white font-mono">
    <FileText className="w-3.5 h-3.5 shrink-0" />
    <span className="truncate max-w-[240px]">{filename}</span>
    {size != null && <span className="text-[#BBBBBB]">{formatFileSize(size)}</span>}
  </span>
);

/** Compact parsed question list message with inline marks editing */
const QuestionListMessage: React.FC<{
  msg: QuestionListMessageType;
  batchBusy: boolean;
  onEditMarks: (msgId: string, questionId: string, newMarks: number) => void;
  onGenerateAll: (questions: AssignmentQuestion[]) => void;
}> = ({ msg, batchBusy, onEditMarks, onGenerateAll }) => {
  const [editingQId, setEditingQId] = useState<string | null>(null);
  const [draftMarks, setDraftMarks] = useState('');

  const missingCount = msg.questions.filter((q) => q.marks == null || q.needs_review).length;

  const commitMarks = (qId: string) => {
    const parsed = parseFloat(draftMarks);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 100) {
      onEditMarks(msg.id, qId, parsed);
    }
    setEditingQId(null);
  };

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <p className="text-xs text-[#222222]">
          Found <strong>{msg.questions.length}</strong>{' '}
          {msg.questions.length === 1 ? 'question' : 'questions'} in{' '}
          <span className="font-mono text-[#555555]">{msg.filename}</span>
        </p>
        {missingCount > 0 && (
          <span className="text-[11px] font-mono text-[#B45309] bg-[#FFFBEB] border border-[#FCD34D] px-2 py-0.5">
            {missingCount} defaulted to {DEFAULT_MISSING_MARKS}M (click marks to edit)
          </span>
        )}
      </div>

      <div className="border border-[#E5E5E5] divide-y divide-[#E5E5E5] bg-white">
        {msg.questions.map((q) => {
          const isEditing = editingQId === q.id;
          const isMissing = q.marks == null;
          const displayMarks = q.marks ?? DEFAULT_MISSING_MARKS;

          return (
            <div
              key={q.id}
              className={`flex items-center gap-2.5 px-2.5 py-1.5 text-xs ${
                q.needs_review || isMissing ? 'bg-[#FFFBEB]' : ''
              }`}
            >
              <span className="font-mono text-[11px] font-semibold text-[#222222] w-10 shrink-0">
                {q.id}
              </span>

              <div className="shrink-0">
                {isEditing ? (
                  <span className="inline-flex items-center gap-1">
                    <input
                      autoFocus
                      type="number"
                      min={0.5}
                      max={100}
                      step={0.5}
                      value={draftMarks}
                      onChange={(e) => setDraftMarks(e.target.value)}
                      onBlur={() => commitMarks(q.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitMarks(q.id);
                        if (e.key === 'Escape') setEditingQId(null);
                      }}
                      className="w-14 border border-[#222222] bg-white px-1 py-0.5 text-xs font-mono text-center"
                      aria-label={`Edit marks for ${q.id}`}
                    />
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingQId(q.id);
                      setDraftMarks(String(displayMarks));
                    }}
                    title={
                      isMissing
                        ? `Marks missing — defaulted to ${DEFAULT_MISSING_MARKS}M. Click to edit.`
                        : 'Click to edit marks'
                    }
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-[11px] border ${
                      isMissing || q.needs_review
                        ? 'border-[#F59E0B] bg-white text-[#B45309]'
                        : 'border-[#E5E5E5] bg-[#F5F5F5] text-[#222222] hover:border-[#222222]'
                    }`}
                  >
                    <span>
                      {displayMarks}M{isMissing ? '?' : ''}
                    </span>
                    <Edit3 className="w-2.5 h-2.5 opacity-60" />
                  </button>
                )}
              </div>

              <span className="flex-1 text-[#333333] truncate" title={q.text}>
                {q.text}
              </span>

              <span className="hidden sm:inline-block font-mono text-[10px] text-[#777777] shrink-0">
                {q.type}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={batchBusy}
          onClick={() =>
            onGenerateAll(
              msg.questions.map((q) => ({
                ...q,
                marks: q.marks ?? DEFAULT_MISSING_MARKS,
              })),
            )
          }
          className="df-btn-dark px-4 py-1.5 text-xs font-medium inline-flex items-center gap-1.5"
        >
          {batchBusy ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Generating answers...
            </>
          ) : (
            <>Generate all answers ({msg.questions.length})</>
          )}
        </button>
      </div>
    </div>
  );
};

/** Render plain text with optional monospace fenced code blocks only when needed */
const AnswerBody: React.FC<{ content: string; questionType: QuestionType }> = ({
  content,
  questionType,
}) => {
  const segments = useMemo(() => {
    const cleanBold = (str: string) => (questionType === 'code' ? str : str.replace(/\*\*/g, ''));
    const parts: { kind: 'text' | 'code'; text: string }[] = [];
    const fenceRe = /```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g;
    let lastIdx = 0;
    let m: RegExpExecArray | null;

    while ((m = fenceRe.exec(content)) !== null) {
      if (m.index > lastIdx) {
        parts.push({ kind: 'text', text: cleanBold(content.slice(lastIdx, m.index)) });
      }
      parts.push({ kind: 'code', text: m[1].trimEnd() });
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < content.length) {
      parts.push({ kind: 'text', text: cleanBold(content.slice(lastIdx)) });
    }
    return parts.length ? parts : [{ kind: 'text', text: cleanBold(content) }];
  }, [content, questionType]);

  return (
    <div className="text-sm text-[#222222] leading-relaxed space-y-2">
      {segments.map((seg, i) =>
        seg.kind === 'code' ? (
          <pre
            key={i}
            className="border border-[#E5E5E5] bg-[#F5F5F5] p-2.5 font-mono text-xs text-[#222222] overflow-x-auto whitespace-pre"
          >
            {seg.text}
          </pre>
        ) : (
          <div key={i} className="whitespace-pre-wrap break-words">
            {seg.text}
          </div>
        ),
      )}
    </div>
  );
};

/** Dedicated answer message component (safe React hook usage per card) */
const AnswerMessage: React.FC<{
  msg: AnswerMessageType;
  onAction: (
    msg: AnswerMessageType,
    action: 'regenerate' | 'shorter' | 'longer' | 'fix_length',
  ) => void;
}> = ({ msg, onAction }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!msg.content) return;
    navigator.clipboard
      .writeText(msg.content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => {});
  };

  const done = msg.done;
  const wordLabel = done
    ? done.explanation_word_count !== done.word_count
      ? `${done.explanation_word_count} expl. words (target ${done.min_words}-${done.max_words}) · ${done.word_count} total`
      : `${done.word_count} words (target ${done.min_words}-${done.max_words})`
    : '';

  return (
    <div className="flex justify-start mb-4">
      <div className="w-full max-w-[90%] border border-[#E5E5E5] bg-white px-4 py-3">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-2 mb-2 pb-1.5 border-b border-[#F0F0F0]">
          <span className="font-mono text-[11px] font-semibold bg-[#222222] text-white px-1.5 py-0.5">
            {msg.questionId}
          </span>
          <span className="font-mono text-[11px] text-[#555555] border border-[#E5E5E5] bg-[#F5F5F5] px-1.5 py-0.5">
            {msg.marks}M
          </span>
          {msg.label && (
            <span className="font-mono text-[10px] text-[#555555] bg-[#F5F5F5] px-1.5 py-0.5">
              {msg.label}
            </span>
          )}
          <span className="text-xs text-[#666666] truncate max-w-[420px]" title={msg.questionText}>
            {msg.questionText}
          </span>
        </div>

        {/* Status notice during 429 rate-limit retries */}
        {msg.statusNotice && (
          <div className="mb-2 flex items-center gap-1.5 border border-[#FCD34D] bg-[#FFFBEB] px-2.5 py-1 text-[11px] text-[#B45309]">
            <Loader2 className="w-3 h-3 animate-spin shrink-0" />
            <span>{msg.statusNotice}</span>
          </div>
        )}

        {/* Body or waiting indicator */}
        {msg.error && !msg.content ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#B91C1C]">
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{msg.error}</span>
            </div>
            <button
              type="button"
              onClick={() => onAction(msg, 'regenerate')}
              className="df-btn-light px-2 py-0.5 text-[11px] inline-flex items-center gap-1 text-[#222222]"
            >
              <RefreshCw className="w-3 h-3" />
              Retry
            </button>
          </div>
        ) : msg.content ? (
          <div>
            <AnswerBody content={msg.content} questionType={msg.questionType} />
            {msg.streaming && (
              <span className="inline-block w-1.5 h-4 bg-[#222222] ml-1 animate-pulse align-middle" />
            )}
          </div>
        ) : msg.streaming ? (
          <div className="flex items-center gap-2 py-1 text-xs text-[#777777]">
            <span className="inline-flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-[#777777] animate-bounce [animation-delay:-0.2s]" />
              <span className="w-1.5 h-1.5 bg-[#777777] animate-bounce [animation-delay:-0.1s]" />
              <span className="w-1.5 h-1.5 bg-[#777777] animate-bounce" />
            </span>
            <span>Generating answer...</span>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 py-1 text-xs text-[#777777]">
            <span>Stopped before receiving output.</span>
            <button
              type="button"
              onClick={() => onAction(msg, 'regenerate')}
              className="df-btn-light px-2 py-0.5 text-[11px] inline-flex items-center gap-1 text-[#222222]"
            >
              <RefreshCw className="w-3 h-3" />
              Retry
            </button>
          </div>
        )}

        {/* Footer after stream completion */}
        {!msg.streaming && done && (
          <div className="mt-3 pt-2 border-t border-[#F0F0F0] flex flex-wrap items-center gap-2">
            <span
              className="font-mono text-[11px] px-2 py-0.5 border"
              style={{ borderColor: badgeColor(done), color: badgeColor(done) }}
            >
              {wordLabel}
            </span>
            <span className="font-mono text-[11px] text-[#666666]">
              ~{done.estimated_lines} lines
            </span>
            {done.cached && (
              <span className="font-mono text-[10px] text-[#777777] bg-[#F5F5F5] px-1.5 py-0.5">
                cached
              </span>
            )}

            <div className="flex flex-wrap items-center gap-1 ml-auto">
              {done.length_warning && (
                <button
                  type="button"
                  onClick={() => onAction(msg, 'fix_length')}
                  className="border border-[#B45309] bg-[#FFFBEB] text-[#B45309] hover:bg-[#FEF3C7] px-2 py-0.5 text-[11px] font-medium inline-flex items-center gap-1"
                  title="Outside target range — trigger one length-fixed regeneration"
                >
                  <SlidersHorizontal className="w-3 h-3" />
                  Fix length
                </button>
              )}
              <button
                type="button"
                onClick={handleCopy}
                className="df-btn-light px-2 py-0.5 text-[11px] inline-flex items-center gap-1"
              >
                {copied ? <Check className="w-3 h-3" /> : <ClipboardCopy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={() => onAction(msg, 'regenerate')}
                className="df-btn-light px-2 py-0.5 text-[11px] inline-flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                Regenerate
              </button>
              <button
                type="button"
                onClick={() => onAction(msg, 'shorter')}
                className="df-btn-light px-2 py-0.5 text-[11px] inline-flex items-center gap-1"
              >
                <Minus className="w-3 h-3" />
                Shorter
              </button>
              <button
                type="button"
                onClick={() => onAction(msg, 'longer')}
                className="df-btn-light px-2 py-0.5 text-[11px] inline-flex items-center gap-1"
              >
                <Plus className="w-3 h-3" />
                Longer
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Chat Component
// ---------------------------------------------------------------------------

interface Props {
  tool: ToolDefinition;
}

export const AssignmentChatTool: React.FC<Props> = () => {
  // --- Catalog state ---
  const [presets, setPresets] = useState<CoursePreset[]>([]);
  const [sections, setSections] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState('gemini-3.5-flash-lite');
  const [availableModels, setAvailableModels] = useState<{ id: string; label: string }[]>([]);
  const [geminiConfigured, setGeminiConfigured] = useState(true);

  // --- Persisted Profile & Settings ---
  const [profile, setProfile] = useState<UserProfile>(() =>
    loadJsonStorage<UserProfile>(PROFILE_STORAGE_KEY, { name: '', rollNo: '' }),
  );
  const [settings, setSettings] = useState<ChatSettings>(() =>
    loadJsonStorage<ChatSettings>(SETTINGS_STORAGE_KEY, {
      presetId: 'btech-cse',
      subjectHint: '',
      wordsPerMarkMin: 30,
      wordsPerMarkMax: 40,
      customWpmActive: false,
      model: '',
    }),
  );

  // --- UI state ---
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadMessagesStorage());
  const [input, setInput] = useState('');
  const [parsing, setParsing] = useState(false);
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [pendingMarksQuestion, setPendingMarksQuestion] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [dragDepth, setDragDepth] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // Persist profile, settings, and messages
  useEffect(() => {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  }, [profile]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    saveMessagesStorage(messages);
  }, [messages]);

  // Fetch presets catalog once
  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}/api/assignments/presets`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: PresetsResponse | null) => {
        if (!active || !data) return;
        setPresets(data.presets || []);
        setSections(data.sections || []);
        const resolvedDefault = data.default_model || 'gemini-3.5-flash-lite';
        setDefaultModel(resolvedDefault);
        setAvailableModels(data.available_models || []);
        setGeminiConfigured(Boolean(data.gemini_configured));
        setSettings((prev) => {
          const validPreset = (data.presets || []).some((p) => p.id === prev.presetId);
          const validModel =
            !prev.model || (data.available_models || []).some((m) => m.id === prev.model);
          const fallback = (data.presets || [])[0];
          const nextPresetId = validPreset ? prev.presetId : fallback?.id || prev.presetId;
          return {
            ...prev,
            presetId: nextPresetId,
            model: validModel ? prev.model : '',
            wordsPerMarkMin:
              validPreset || prev.customWpmActive || !fallback
                ? prev.wordsPerMarkMin
                : fallback.words_per_mark_min,
            wordsPerMarkMax:
              validPreset || prev.customWpmActive || !fallback
                ? prev.wordsPerMarkMax
                : fallback.words_per_mark_max,
          };
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // Close Export dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Scroll to bottom smoothly when new messages arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const activePreset = useMemo(
    () => presets.find((p) => p.id === settings.presetId),
    [presets, settings.presetId],
  );

  const presetsBySection = useMemo(
    () =>
      sections.map((section) => ({
        section,
        items: presets.filter((p) => p.section === section),
      })),
    [sections, presets],
  );

  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const updateAnswerMessage = useCallback(
    (msgId: string, updater: (prev: AnswerMessageType) => AnswerMessageType) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId && m.type === 'answer' ? updater(m) : m)),
      );
    },
    [],
  );

  // Recent short context lines for conversational follow-ups
  const buildConversationContext = useCallback(
    (upToMessages: ChatMessage[]): string[] =>
      upToMessages
        .filter((m) => (m.role === 'user' && m.type === 'text') || m.type === 'answer')
        .slice(-6)
        .map((m) =>
          m.type === 'answer'
            ? `${m.questionId} (${m.marks}M): ${m.questionText}`
            : `User: ${m.content}`,
        ),
    [],
  );

  // -------------------------------------------------------------------------
  // Stream one question / follow-up into an existing AnswerMessage slot
  // -------------------------------------------------------------------------
  const runAnswerStream = useCallback(
    async (params: {
      msgId: string;
      question: AssignmentQuestion;
      bypassCache?: boolean;
      targetMinWords?: number;
      targetMaxWords?: number;
      previousAnswer?: string;
      followupInstruction?: string;
      conversationContext?: string[];
      signal?: AbortSignal;
    }) => {
      const {
        msgId,
        question,
        bypassCache = false,
        targetMinWords,
        targetMaxWords,
        previousAnswer,
        followupInstruction,
        conversationContext = [],
        signal,
      } = params;

      const modelToUse = (settings.model || defaultModel).trim() || defaultModel;

      try {
        const done = await readAnswerSse(
          `${API_BASE}/api/assignments/chat/stream`,
          {
            question,
            preset_id: settings.presetId,
            subject_hint: settings.subjectHint,
            words_per_mark_min: settings.wordsPerMarkMin || 30,
            words_per_mark_max: settings.wordsPerMarkMax || 40,
            target_min_words: targetMinWords ?? null,
            target_max_words: targetMaxWords ?? null,
            model: modelToUse,
            bypass_cache: bypassCache,
            previous_answer: previousAnswer ?? null,
            followup_instruction: followupInstruction ?? null,
            conversation_context: conversationContext,
          },
          {
            signal,
            onToken: (chunk) => {
              updateAnswerMessage(msgId, (prev) => ({
                ...prev,
                statusNotice: undefined,
                content: prev.content + chunk,
              }));
            },
            onRateLimit: (message, reset) => {
              updateAnswerMessage(msgId, (prev) => ({
                ...prev,
                content: reset ? '' : prev.content,
                statusNotice: message,
              }));
            },
          },
        );

        updateAnswerMessage(msgId, (prev) => ({
          ...prev,
          streaming: false,
          statusNotice: undefined,
          content: done.text ?? prev.content,
          done,
        }));
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') {
          updateAnswerMessage(msgId, (prev) => ({
            ...prev,
            streaming: false,
            statusNotice: undefined,
            error: prev.content ? undefined : 'Generation stopped.',
          }));
          return;
        }
        updateAnswerMessage(msgId, (prev) => ({
          ...prev,
          streaming: false,
          statusNotice: undefined,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [settings, defaultModel, updateAnswerMessage],
  );

  // -------------------------------------------------------------------------
  // Upload & parse assignment file
  // -------------------------------------------------------------------------
  const handleFileUpload = useCallback(
    async (file: File) => {
      const check = validateFile(file, ACCEPTED_EXTS, MAX_UPLOAD_MB);
      if (!check.valid) {
        appendMessage({
          id: uid(),
          role: 'assistant',
          type: 'error',
          content: check.error || 'Unsupported file.',
        });
        return;
      }

      appendMessage({
        id: uid(),
        role: 'user',
        type: 'file_chip',
        content: file.name,
        fileSize: file.size,
      });

      const loadingId = uid();
      appendMessage({
        id: loadingId,
        role: 'assistant',
        type: 'text',
        content: `Reading ${file.name} and extracting questions...`,
        loading: true,
      });
      setParsing(true);

      try {
        const form = new FormData();
        form.append('file', file);
        const activeModel = (settings.model || defaultModel).trim();
        const parseUrl = activeModel
          ? `${API_BASE}/api/assignments/parse?model=${encodeURIComponent(activeModel)}`
          : `${API_BASE}/api/assignments/parse`;

        const res = await fetch(parseUrl, { method: 'POST', body: form });
        if (!res.ok) {
          const detail = await res.json().catch(() => ({ detail: res.statusText }));
          throw new Error(detail?.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const questions: AssignmentQuestion[] = data.questions || [];

        setMessages((prev) =>
          prev.map((m) =>
            m.id === loadingId
              ? questions.length > 0
                ? ({
                    id: loadingId,
                    role: 'assistant',
                    type: 'question_list',
                    filename: data.filename || file.name,
                    extractionMethod: data.extraction_method,
                    pageCount: data.page_count,
                    questions,
                  } as QuestionListMessageType)
                : {
                    id: loadingId,
                    role: 'assistant',
                    type: 'error',
                    content: `No questions were detected in "${file.name}". Try typing a question below.`,
                  }
              : m,
          ),
        );
      } catch (err) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === loadingId
              ? {
                  id: loadingId,
                  role: 'assistant',
                  type: 'error',
                  content: `Could not parse "${file.name}": ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                }
              : m,
          ),
        );
      } finally {
        setParsing(false);
      }
    },
    [appendMessage, settings.model, defaultModel],
  );

  // Auto-handle file staged from HomePage dropzone
  useStagedToolFiles(ACCEPTED_EXTS, MAX_UPLOAD_MB, false, (files) => {
    if (files[0]) handleFileUpload(files[0]);
  });

  // Update question marks inline inside QuestionListMessage (persisted in localStorage)
  const handleEditListMarks = useCallback(
    (listMsgId: string, questionId: string, newMarks: number) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== listMsgId || m.type !== 'question_list') return m;
          return {
            ...m,
            questions: m.questions.map((q) =>
              q.id === questionId
                ? { ...q, marks: newMarks, needs_review: false, review_reason: null }
                : q,
            ),
          };
        }),
      );
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Batch generation with concurrency 2-3, strictly ordered cards
  // -------------------------------------------------------------------------
  const handleGenerateAll = useCallback(
    async (questions: AssignmentQuestion[]) => {
      if (!questions.length || batchGenerating) return;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setBatchGenerating(true);

      let cursor = 0;

      const claimNext = (): { q: AssignmentQuestion; msgId: string } | null => {
        if (controller.signal.aborted || cursor >= questions.length) return null;
        const q = questions[cursor++];
        const msgId = uid();
        // Posted sequentially as claimed so answers strictly appear in question order Q1, Q2, Q3...
        appendMessage({
          id: msgId,
          role: 'assistant',
          type: 'answer',
          questionId: q.id,
          questionText: q.text,
          questionType: q.type || 'explain',
          marks: q.marks ?? DEFAULT_MISSING_MARKS,
          content: '',
          streaming: true,
        });
        return { q, msgId };
      };

      const worker = async () => {
        while (true) {
          const item = claimNext();
          if (!item) break;
          await runAnswerStream({
            msgId: item.msgId,
            question: item.q,
            signal: controller.signal,
          });
        }
      };

      const workerCount = Math.min(STREAM_CONCURRENCY, questions.length);
      try {
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        setBatchGenerating(false);
      }
    },
    [batchGenerating, appendMessage, runAnswerStream],
  );

  // -------------------------------------------------------------------------
  // Answer footer actions (Fix length / Regenerate / Shorter / Longer)
  // -------------------------------------------------------------------------
  const handleAnswerAction = useCallback(
    async (
      targetMsg: AnswerMessageType,
      action: 'regenerate' | 'shorter' | 'longer' | 'fix_length',
    ) => {
      const done = targetMsg.done;
      const newId = uid();

      const labelMap = {
        regenerate: 'Regenerated',
        shorter: 'Shorter',
        longer: 'Longer',
        fix_length: 'Fixed length',
      } as const;

      appendMessage({
        id: newId,
        role: 'assistant',
        type: 'answer',
        questionId: targetMsg.questionId,
        questionText: targetMsg.questionText,
        questionType: targetMsg.questionType,
        marks: targetMsg.marks,
        label: labelMap[action],
        content: '',
        streaming: true,
      });

      const q: AssignmentQuestion = {
        id: targetMsg.questionId,
        number: targetMsg.questionId.replace(/\D/g, '') || '1',
        part: '',
        text: targetMsg.questionText,
        marks: targetMsg.marks,
        type: targetMsg.questionType,
        confidence: 1,
        needs_review: false,
      };

      if (action === 'regenerate') {
        await runAnswerStream({ msgId: newId, question: q, bypassCache: true });
        return;
      }

      if (action === 'fix_length') {
        await runAnswerStream({
          msgId: newId,
          question: q,
          bypassCache: true,
          targetMinWords: done?.min_words,
          targetMaxWords: done?.max_words,
          previousAnswer: targetMsg.content,
          followupInstruction: 'Fix length to match the required word range',
        });
        return;
      }

      const baseMin = done?.min_words ?? targetMsg.marks * (settings.wordsPerMarkMin || 30);
      const baseMax = done?.max_words ?? targetMsg.marks * (settings.wordsPerMarkMax || 40);
      const factor = action === 'shorter' ? 0.72 : 1.3;
      const nextMin = Math.max(12, Math.round(baseMin * factor));
      const nextMax = Math.max(nextMin + 10, Math.round(baseMax * factor));

      await runAnswerStream({
        msgId: newId,
        question: q,
        bypassCache: true,
        targetMinWords: nextMin,
        targetMaxWords: nextMax,
        previousAnswer: targetMsg.content,
        followupInstruction:
          action === 'shorter'
            ? 'Make this answer shorter while keeping essential definitions and points.'
            : 'Make this answer longer with clearer explanation and a helpful example.',
      });
    },
    [appendMessage, runAnswerStream, settings.wordsPerMarkMin, settings.wordsPerMarkMax],
  );

  // -------------------------------------------------------------------------
  // Quick-pick marks resolution for typed question
  // -------------------------------------------------------------------------
  const resolvePendingMarks = useCallback(
    async (marks: number) => {
      if (!pendingMarksQuestion) return;
      const qText = pendingMarksQuestion;
      setPendingMarksQuestion(null);

      // Disable the quick-pick buttons on the existing prompt message
      setMessages((prev) =>
        prev.map((m) =>
          m.type === 'marks_prompt' && m.questionText === qText && m.resolvedMarks == null
            ? { ...m, resolvedMarks: marks }
            : m,
        ),
      );

      appendMessage({ id: uid(), role: 'user', type: 'text', content: `${marks} marks` });

      const qType = inferQuestionTypeClient(qText);
      const ansId = uid();
      appendMessage({
        id: ansId,
        role: 'assistant',
        type: 'answer',
        questionId: 'Q_chat',
        questionText: qText,
        questionType: qType,
        marks,
        content: '',
        streaming: true,
      });

      const q: AssignmentQuestion = {
        id: 'Q_chat',
        number: '1',
        part: '',
        text: qText,
        marks,
        type: qType,
        confidence: 1,
        needs_review: false,
      };
      await runAnswerStream({ msgId: ansId, question: q });
    },
    [pendingMarksQuestion, appendMessage, runAnswerStream],
  );

  // -------------------------------------------------------------------------
  // Send handler: pending marks reply | follow-up | new typed question
  // -------------------------------------------------------------------------
  const handleSend = useCallback(async () => {
    const raw = input.trim();
    if (!raw) return;
    setInput('');

    // 1) If waiting for marks and user typed a pure number / "7 marks" / "default"
    if (pendingMarksQuestion) {
      const pureMarks = parsePureMarksReply(raw);
      if (pureMarks != null) {
        await resolvePendingMarks(pureMarks);
        return;
      }
      // User moved on to a new message; clear pending state cleanly
      setPendingMarksQuestion(null);
    }

    const answerMessages = messages.filter((m): m is AnswerMessageType => m.type === 'answer');
    const intent = detectFollowupIntent(raw, answerMessages.length > 0);

    // 2) Follow-up against existing answer (or Q3 etc.)
    if (intent.kind === 'followup') {
      const findTarget = (): AnswerMessageType | undefined => {
        if (intent.targetQuestionRef) {
          const normRef = intent.targetQuestionRef.toUpperCase();
          const numOnly = normRef.replace(/^Q/, '');
          const exact = [...answerMessages]
            .reverse()
            .find(
              (a) =>
                a.questionId.toUpperCase() === normRef ||
                a.questionId.toUpperCase() === `Q${numOnly}`,
            );
          if (exact) return exact;
        }
        return answerMessages[answerMessages.length - 1];
      };

      const target = findTarget();
      if (target) {
        appendMessage({ id: uid(), role: 'user', type: 'text', content: raw });
        const newId = uid();

        const labelText =
          intent.action === 'regenerate'
            ? 'Regenerated'
            : intent.action === 'shorter'
              ? 'Shorter'
              : intent.action === 'longer'
                ? 'Longer'
                : intent.action === 'fix_length'
                  ? 'Fixed length'
                  : 'Follow-up';

        appendMessage({
          id: newId,
          role: 'assistant',
          type: 'answer',
          questionId: target.questionId,
          questionText: target.questionText,
          questionType: target.questionType,
          marks: target.marks,
          label: labelText,
          content: '',
          streaming: true,
        });

        const q: AssignmentQuestion = {
          id: target.questionId,
          number: target.questionId.replace(/\D/g, '') || '1',
          part: '',
          text: target.questionText,
          marks: target.marks,
          type: target.questionType,
          confidence: 1,
          needs_review: false,
        };

        let targetMinWords: number | undefined;
        let targetMaxWords: number | undefined;

        if (intent.action === 'shorter' || intent.action === 'longer') {
          const baseMin =
            target.done?.min_words ?? target.marks * (settings.wordsPerMarkMin || 30);
          const baseMax =
            target.done?.max_words ?? target.marks * (settings.wordsPerMarkMax || 40);
          const factor = intent.action === 'shorter' ? 0.72 : 1.3;
          targetMinWords = Math.max(12, Math.round(baseMin * factor));
          targetMaxWords = Math.max(targetMinWords + 10, Math.round(baseMax * factor));
        }

        await runAnswerStream({
          msgId: newId,
          question: q,
          bypassCache: true,
          targetMinWords,
          targetMaxWords,
          previousAnswer: intent.action === 'regenerate' ? undefined : target.content,
          followupInstruction:
            intent.action === 'regenerate' ? undefined : intent.instruction,
          conversationContext: buildConversationContext(messages),
        });
        return;
      }
    }

    // 3) New single question typed in chat
    appendMessage({ id: uid(), role: 'user', type: 'text', content: raw });
    const { marks, cleanedText } = detectMarksInText(raw);

    if (marks != null) {
      const qType = inferQuestionTypeClient(cleanedText);
      const ansId = uid();
      appendMessage({
        id: ansId,
        role: 'assistant',
        type: 'answer',
        questionId: 'Q_chat',
        questionText: cleanedText,
        questionType: qType,
        marks,
        content: '',
        streaming: true,
      });

      const q: AssignmentQuestion = {
        id: 'Q_chat',
        number: '1',
        part: '',
        text: cleanedText,
        marks,
        type: qType,
        confidence: 1,
        needs_review: false,
      };
      await runAnswerStream({ msgId: ansId, question: q });
    } else {
      setPendingMarksQuestion(cleanedText);
      appendMessage({
        id: uid(),
        role: 'assistant',
        type: 'marks_prompt',
        questionText: cleanedText,
      });
    }
  }, [
    input,
    pendingMarksQuestion,
    resolvePendingMarks,
    messages,
    appendMessage,
    runAnswerStream,
    buildConversationContext,
    settings.wordsPerMarkMin,
    settings.wordsPerMarkMax,
  ]);

  // -------------------------------------------------------------------------
  // New Chat / Clear / Optional Copy All & Export
  // -------------------------------------------------------------------------
  const handleNewChat = () => {
    abortControllerRef.current?.abort();
    setMessages([]);
    setPendingMarksQuestion(null);
    setBatchGenerating(false);
    setExportNotice(null);
  };

  const handleClearHistory = () => {
    abortControllerRef.current?.abort();
    setMessages([]);
    setPendingMarksQuestion(null);
    setBatchGenerating(false);
    setExportNotice(null);
    localStorage.removeItem(CHAT_STORAGE_KEY);
  };

  const completedAnswers = useMemo(() => {
    const raw = messages.filter(
      (m): m is AnswerMessageType => m.type === 'answer' && Boolean(m.content && !m.streaming),
    );
    // Keep latest answer per questionId if regenerated, preserving order of first appearance
    return raw;
  }, [messages]);

  const handleCopyAll = () => {
    if (!completedAnswers.length) {
      setExportNotice('No finished answers to copy yet.');
      return;
    }
    const text = completedAnswers
      .map(
        (a) =>
          `${a.questionId}. [${a.marks} Marks] ${a.questionText}\n\n${a.content}`,
      )
      .join('\n\n' + '-'.repeat(48) + '\n\n');
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedAll(true);
        setTimeout(() => setCopiedAll(false), 1800);
      })
      .catch(() => {});
  };

  const handleExport = async (format: 'pdf' | 'docx') => {
    setExportOpen(false);
    setExportNotice(null);
    if (!completedAnswers.length) {
      setExportNotice('Generate at least one answer before exporting.');
      return;
    }

    const items = completedAnswers.map((a, idx) => {
      const minW = a.done?.min_words ?? a.marks * (settings.wordsPerMarkMin || 30);
      const maxW = a.done?.max_words ?? a.marks * (settings.wordsPerMarkMax || 40);
      return {
        question_id: a.questionId === 'Q_chat' ? `Q${idx + 1}` : a.questionId,
        number: String(idx + 1),
        part: '',
        question_text: a.questionText,
        marks: a.marks,
        type: a.questionType,
        answer: a.content,
        explanation_word_count: a.done?.explanation_word_count ?? 0,
        total_word_count: a.done?.word_count ?? 0,
        min_words: minW,
        max_words: maxW,
        target_words: Math.round((minW + maxW) / 2),
        estimated_lines: a.done?.estimated_lines ?? 1,
        length_warning: a.done?.length_warning ?? false,
        attempts: 1,
        cached: a.done?.cached ?? false,
      };
    });

    try {
      const res = await fetch(`${API_BASE}/api/assignments/export/${format}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: settings.subjectHint.trim() || 'Assignment Answers',
          course_name: activePreset?.course_name || 'B.Tech CSE',
          subject_hint: settings.subjectHint,
          profile: { name: profile.name, roll_no: profile.rollNo },
          items,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err?.detail || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      triggerBlobDownload(blob, `assignment_answers.${format}`);
    } catch (err) {
      setExportNotice(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // -------------------------------------------------------------------------
  // Preset select handler (updates defaults cleanly when Custom is picked)
  // -------------------------------------------------------------------------
  const handlePresetChange = (nextId: string) => {
    const matched = presets.find((p) => p.id === nextId);
    setSettings((prev) => ({
      ...prev,
      presetId: nextId,
      wordsPerMarkMin:
        prev.customWpmActive || !matched ? prev.wordsPerMarkMin : matched.words_per_mark_min,
      wordsPerMarkMax:
        prev.customWpmActive || !matched ? prev.wordsPerMarkMax : matched.words_per_mark_max,
    }));
    if (matched?.is_custom) {
      setShowSettings(true);
    }
  };

  // -------------------------------------------------------------------------
  // Drag and drop handlers
  // -------------------------------------------------------------------------
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    setDragDepth((d) => d + 1);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragDepth((d) => Math.max(0, d - 1));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragDepth(0);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileUpload(file);
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div
      className="relative flex flex-col border border-[#E5E5E5] bg-white"
      style={{ height: 'max(540px, calc(100vh - 280px))' }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Full-pane Drag & Drop overlay */}
      {dragDepth > 0 && (
        <div className="absolute inset-0 z-40 flex items-center justify-center border-2 border-dashed border-[#222222] bg-white/90 pointer-events-none">
          <div className="text-center px-6 py-4 border border-[#E5E5E5] bg-[#F5F5F5]">
            <p className="text-sm font-semibold text-[#222222]">
              Drop your assignment file here
            </p>
            <p className="text-xs text-[#666666] mt-1 font-mono">
              PDF, DOCX, PNG, JPG, JPEG · up to 20 MB
            </p>
          </div>
        </div>
      )}

      {/* ── Top Bar ── */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 border-b border-[#E5E5E5] bg-[#F5F5F5]">
        {/* Course selector */}
        <select
          value={settings.presetId}
          onChange={(e) => handlePresetChange(e.target.value)}
          aria-label="Course preset"
          className="border border-[#E5E5E5] bg-white text-xs text-[#222222] px-2.5 py-1.5 cursor-pointer min-w-[160px] max-w-[220px]"
        >
          {presets.length === 0 && (
            <option value={settings.presetId}>B.Tech CSE (default)</option>
          )}
          {presetsBySection.map(({ section, items }) =>
            items.length ? (
              <optgroup key={section} label={section}>
                {items.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.course_name}
                  </option>
                ))}
              </optgroup>
            ) : null,
          )}
        </select>

        {/* Optional Subject hint */}
        <input
          type="text"
          value={settings.subjectHint}
          onChange={(e) =>
            setSettings((prev) => ({ ...prev, subjectHint: e.target.value }))
          }
          placeholder="Subject hint (e.g. Operating Systems)"
          aria-label="Subject hint"
          className="border border-[#E5E5E5] bg-white text-xs text-[#222222] px-2.5 py-1.5 w-48 sm:w-56 placeholder:text-[#999999]"
        />

        <div className="flex-1" />

        {/* New chat & Clear */}
        <button
          type="button"
          onClick={handleNewChat}
          className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1"
          title="Start a fresh conversation"
        >
          <Plus className="w-3.5 h-3.5" />
          New chat
        </button>

        <button
          type="button"
          onClick={handleClearHistory}
          disabled={messages.length === 0 && !batchGenerating}
          className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1"
          title="Clear saved chat history from browser"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Clear
        </button>

        {/* Optional Export menu (off main path) */}
        <div className="relative" ref={exportMenuRef}>
          <button
            type="button"
            onClick={() => setExportOpen((o) => !o)}
            className="df-btn-light px-2.5 py-1.5 text-xs inline-flex items-center gap-1"
            title="Copy all or export PDF/DOCX"
          >
            <Download className="w-3.5 h-3.5" />
            Export
            <ChevronDown className="w-3 h-3 text-[#777777]" />
          </button>

          {exportOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 w-44 border border-[#E5E5E5] bg-white divide-y divide-[#F0F0F0]">
              <button
                type="button"
                onClick={() => {
                  handleCopyAll();
                  setExportOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-xs text-[#222222] hover:bg-[#F5F5F5] flex items-center gap-2"
              >
                <ClipboardCopy className="w-3.5 h-3.5 text-[#555555]" />
                {copiedAll ? 'Copied all answers' : 'Copy all answers'}
              </button>
              <button
                type="button"
                onClick={() => handleExport('pdf')}
                className="w-full text-left px-3 py-2 text-xs text-[#222222] hover:bg-[#F5F5F5] flex items-center gap-2"
              >
                <Download className="w-3.5 h-3.5 text-[#555555]" />
                Export as PDF
              </button>
              <button
                type="button"
                onClick={() => handleExport('docx')}
                className="w-full text-left px-3 py-2 text-xs text-[#222222] hover:bg-[#F5F5F5] flex items-center gap-2"
              >
                <Download className="w-3.5 h-3.5 text-[#555555]" />
                Export as DOCX
              </button>
            </div>
          )}
        </div>

        {/* Settings toggle */}
        <button
          type="button"
          onClick={() => setShowSettings((s) => !s)}
          className={`px-2 py-1.5 text-xs border inline-flex items-center ${
            showSettings
              ? 'border-[#222222] bg-[#222222] text-white'
              : 'df-btn-light'
          }`}
          title="Student details, words-per-mark range, and model settings"
          aria-label="Settings"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Expandable Settings Panel ── */}
      {showSettings && (
        <div className="border-b border-[#E5E5E5] bg-[#FAFAFA] px-4 py-3 text-xs space-y-3">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-[#222222]">
              Notebook & Length Settings
            </span>
            <button
              type="button"
              onClick={() => setShowSettings(false)}
              className="text-[#777777] hover:text-[#222222]"
              aria-label="Close settings"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[#555555]">Name (for export header)</span>
              <input
                type="text"
                value={profile.name}
                onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
                placeholder="e.g. Aarav Sharma"
                className="border border-[#E5E5E5] bg-white px-2 py-1 text-[#222222]"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[#555555]">Roll No.</span>
              <input
                type="text"
                value={profile.rollNo}
                onChange={(e) => setProfile((p) => ({ ...p, rollNo: e.target.value }))}
                placeholder="e.g. 21CS104"
                className="border border-[#E5E5E5] bg-white px-2 py-1 text-[#222222]"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[#555555]">Min words / mark</span>
              <input
                type="number"
                min={5}
                max={200}
                value={settings.wordsPerMarkMin}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    customWpmActive: true,
                    wordsPerMarkMin: Math.max(5, Math.min(200, Number(e.target.value) || 30)),
                  }))
                }
                className="border border-[#E5E5E5] bg-white px-2 py-1 text-[#222222] font-mono"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[#555555]">Max words / mark</span>
              <input
                type="number"
                min={5}
                max={250}
                value={settings.wordsPerMarkMax}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    customWpmActive: true,
                    wordsPerMarkMax: Math.max(5, Math.min(250, Number(e.target.value) || 40)),
                  }))
                }
                className="border border-[#E5E5E5] bg-white px-2 py-1 text-[#222222] font-mono"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[#555555]">Gemini Model</span>
              <select
                value={settings.model || defaultModel}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, model: e.target.value }))
                }
                className="border border-[#E5E5E5] bg-white px-2 py-1 text-[#222222]"
              >
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#666666]">
            <span>
              Course style: <strong>{activePreset?.course_name || 'B.Tech CSE'}</strong> —{' '}
              {activePreset?.tone_style_notes}
            </span>
            {settings.customWpmActive && activePreset && (
              <button
                type="button"
                onClick={() =>
                  setSettings((s) => ({
                    ...s,
                    customWpmActive: false,
                    wordsPerMarkMin: activePreset.words_per_mark_min,
                    wordsPerMarkMax: activePreset.words_per_mark_max,
                  }))
                }
                className="inline-flex items-center gap-1 text-[#222222] underline"
              >
                <RotateCcw className="w-3 h-3" />
                Reset words/mark to preset ({activePreset.words_per_mark_min}–
                {activePreset.words_per_mark_max})
              </button>
            )}
          </div>
        </div>
      )}

      {/* Alerts (missing server key or export status) */}
      {!geminiConfigured && (
        <div className="border-b border-[#FCA5A5] bg-[#FEF2F2] px-3 py-2 text-xs text-[#991B1B] flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>
            <code>GEMINI_API_KEY</code> is not configured on the backend server. Add it to{' '}
            <code>.env</code> and restart uvicorn.
          </span>
        </div>
      )}

      {exportNotice && (
        <div className="border-b border-[#E5E5E5] bg-[#F5F5F5] px-3 py-1.5 text-xs text-[#444444] flex items-center justify-between">
          <span>{exportNotice}</span>
          <button type="button" onClick={() => setExportNotice(null)}>
            <X className="w-3.5 h-3.5 text-[#777777]" />
          </button>
        </div>
      )}

      {/* ── Conversation Messages ── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 bg-[#FAFAFA]">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center px-4">
            <div className="border border-[#E5E5E5] bg-white p-6 max-w-md space-y-3">
              <p className="text-sm font-semibold text-[#222222]">
                Marks-Based Assignment Chat
              </p>
              <p className="text-xs text-[#666666] leading-relaxed">
                Upload an assignment file (<span className="font-mono">PDF, DOCX, PNG, JPG</span>) to extract questions, or type any question directly with marks.
              </p>
              <div className="text-left border-t border-[#F0F0F0] pt-3 space-y-1.5 text-[11px] text-[#555555] font-mono">
                <div>• "Explain deadlock in OS, 7 marks"</div>
                <div>• "Compare TCP and UDP (5)"</div>
                <div>• Follow-ups: "make it shorter", "add an example", "regenerate Q3"</div>
              </div>
            </div>
          </div>
        )}

        {messages.map((msg) => {
          if (msg.type === 'text') {
            if (msg.role === 'user') {
              return (
                <div key={msg.id} className="flex justify-end mb-3">
                  <div className="max-w-[78%] bg-[#222222] text-white text-sm px-3.5 py-2 leading-relaxed whitespace-pre-wrap">
                    {msg.content}
                  </div>
                </div>
              );
            }
            return (
              <div key={msg.id} className="flex justify-start mb-3">
                <div className="max-w-[85%] border border-[#E5E5E5] bg-white px-3.5 py-2 text-xs text-[#444444] flex items-center gap-2">
                  {msg.loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#777777]" />}
                  <span>{msg.content}</span>
                </div>
              </div>
            );
          }

          if (msg.type === 'file_chip') {
            return (
              <div key={msg.id} className="flex justify-end mb-3">
                <FileChip filename={msg.content} size={msg.fileSize} />
              </div>
            );
          }

          if (msg.type === 'error') {
            return (
              <div key={msg.id} className="flex justify-start mb-3">
                <div className="max-w-[85%] border border-[#FCA5A5] bg-[#FEF2F2] px-3 py-2 text-xs text-[#991B1B] flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{msg.content}</span>
                </div>
              </div>
            );
          }

          if (msg.type === 'question_list') {
            return (
              <div key={msg.id} className="flex justify-start mb-4">
                <div className="w-full max-w-[92%] border border-[#E5E5E5] bg-white p-3.5">
                  <QuestionListMessage
                    msg={msg}
                    batchBusy={batchGenerating}
                    onEditMarks={handleEditListMarks}
                    onGenerateAll={handleGenerateAll}
                  />
                </div>
              </div>
            );
          }

          if (msg.type === 'marks_prompt') {
            const isResolved = msg.resolvedMarks != null;
            return (
              <div key={msg.id} className="flex justify-start mb-3">
                <div className="max-w-[85%] border border-[#E5E5E5] bg-white px-3.5 py-2.5">
                  <p className="text-xs text-[#333333] mb-2">
                    How many marks is this question for?{' '}
                    {isResolved && (
                      <span className="font-mono text-[#777777]">
                        ({msg.resolvedMarks} marks selected)
                      </span>
                    )}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {QUICK_MARKS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        disabled={isResolved || pendingMarksQuestion !== msg.questionText}
                        onClick={() => resolvePendingMarks(m)}
                        className={`px-2.5 py-1 text-xs font-mono border ${
                          msg.resolvedMarks === m
                            ? 'bg-[#222222] text-white border-[#222222]'
                            : 'df-btn-light'
                        }`}
                      >
                        {m} marks{m === DEFAULT_MISSING_MARKS ? ' (default)' : ''}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            );
          }

          if (msg.type === 'answer') {
            return (
              <AnswerMessage
                key={msg.id}
                msg={msg}
                onAction={handleAnswerAction}
              />
            );
          }

          return null;
        })}
        <div ref={bottomRef} />
      </div>

      {/* ── Bottom Input Bar ── */}
      <div className="border-t border-[#E5E5E5] bg-white px-3 py-2.5">
        <div className="flex items-end gap-2 border border-[#E5E5E5] focus-within:border-[#222222] bg-white px-2 py-1.5">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={parsing || batchGenerating}
            className="shrink-0 p-1.5 text-[#555555] hover:text-[#222222] disabled:opacity-40"
            title="Attach assignment file (PDF, DOCX, PNG, JPG)"
            aria-label="Upload assignment file"
          >
            {parsing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Paperclip className="w-4 h-4" />
            )}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.png,.jpg,.jpeg"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileUpload(file);
              e.target.value = '';
            }}
          />

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={
              pendingMarksQuestion
                ? 'Pick marks above or type e.g. "7 marks" (or "default" for 5)...'
                : 'Type a question (e.g. "Explain deadlock in OS, 7 marks"), a follow-up, or drop a file...'
            }
            rows={1}
            className="flex-1 resize-none text-sm text-[#222222] placeholder:text-[#999999] bg-transparent py-1 max-h-32 overflow-y-auto focus:outline-none"
          />

          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim()}
            className="shrink-0 df-btn-dark px-3 py-1.5 text-xs font-medium inline-flex items-center gap-1"
            aria-label="Send message"
          >
            <SendHorizonal className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Send</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 mt-1.5 text-[10px] text-[#888888] font-mono">
          <span>
            Length rule: {settings.wordsPerMarkMin}–{settings.wordsPerMarkMax} words/mark · Shift+Enter for new line
          </span>
          <span>
            Saved locally in browser · Course: {activePreset?.course_name || 'B.Tech CSE'}
          </span>
        </div>
      </div>
    </div>
  );
};

export default AssignmentChatTool;
