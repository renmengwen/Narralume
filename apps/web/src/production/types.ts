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
export interface JobRecord {
  id: string;
  type: string;
  status: JobStatus;
  progress: number;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
  errorMessage: string | null;
}
