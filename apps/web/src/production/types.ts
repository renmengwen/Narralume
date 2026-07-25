import type { JobStatus } from "../production-logic";

export interface SeriesProject { id: string; bookId: string; title: string }
export interface Chapter {
  id: string;
  title: string;
  chapter_index: number;
  char_count: number;
  byte_start: number;
  byte_end: number;
}
export type ChapterEventType = "character" | "location" | "prop" | "causality" | "revelation" | "suspense";
export interface ChapterEventSource { byteStart: number; byteEnd: number; sourceText: string }
export interface ChapterEvent {
  id: string;
  type: ChapterEventType;
  occurrence: number;
  payload: Record<string, string>;
  sources: ChapterEventSource[];
}
export interface EpisodeSourceSnapshot {
  sourceIndex: number;
  chapterId: string;
  sourceEventId: string;
  byteStart: number;
  byteEnd: number;
  sourceHash: string;
  sourceText: string;
}
export interface Episode {
  id: string;
  seriesProjectId: string;
  index: number;
  title: string;
  storyArc: string;
  targetDurationSeconds: number;
  recap: string | null;
  nextHook: string | null;
  createdAt: number;
  updatedAt: number;
  sources: EpisodeSourceSnapshot[];
}
export type ScriptVersionKind = "faithful" | "packaged";
export interface ScriptVersionSource {
  episodeSourceIndex: number;
  chapterId: string;
  sourceEventId: string;
  byteStart: number;
  byteEnd: number;
  sourceHash: string;
}
export interface ScriptVersion {
  id: string;
  episodeId: string;
  kind: ScriptVersionKind;
  versionNumber: number;
  parentVersionId: string | null;
  contentHash: string;
  paragraphs: Array<{ text: string; sources: ScriptVersionSource[] }>;
}
export interface ScriptApproval {
  episodeId: string;
  status: "unapproved" | "approved" | "withdrawn";
  revision: number;
  scriptVersionId: string | null;
  changedAt: number | null;
}
export interface JobRecord {
  id: string;
  type: string;
  status: JobStatus;
  progress: number;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
  payload?: { episodeId?: string; voice?: string; rate?: number } | Record<string, unknown>;
  result?: { episodeId?: string; timelineHash?: string; durationMs?: number; segmentCount?: number; cueCount?: number; reusedSegments?: number } | Record<string, unknown> | null;
  errorMessage: string | null;
}
export interface EpisodeRecommendation {
  status: "recommended" | "needs_analysis";
  startChapterId: string;
  endChapterId?: string;
  chapterIds?: string[];
  eventIds?: string[];
  events?: Array<{ id: string; chapterId: string; type: string; payload: Record<string, string> }>;
  estimatedCharacterCount?: number;
  estimatedDurationSeconds?: number;
  targetDurationSeconds?: number;
  advice?: "保留" | "压缩";
  missingChapters: Array<{ id: string; title: string }>;
}
export interface TtsTimelineSummary {
  episodeId: string; scriptVersionId: string; timelineHash: string; providerId: string; voice: string; rate: number;
  durationMs: number; segmentCount: number; cueCount: number; reusedSegments: number | null; createdAt: number;
  srtIdentity: string; assIdentity: string;
}
export interface TtsTimeline extends TtsTimelineSummary {
  segments: Array<{ index: number; text: string; inputHash: string; fileHash: string; bytes: number; durationMs: number }>;
  cues: Array<{ index: number; segmentIndex: number; startMs: number; endMs: number; text: string }>;
}
