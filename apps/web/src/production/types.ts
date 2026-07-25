import type { JobStatus } from "../production-logic";

export interface SeriesProject { id: string; bookId: string; title: string }
export interface Chapter { id: string; title: string; chapter_index: number; char_count: number }
export interface ChapterEvent { id: string; type: string; occurrence: number; payload: unknown; sources: unknown[] }
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
