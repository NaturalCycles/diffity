import { randomUUID } from 'node:crypto';
import { getDb, queryAll, queryOne } from './db.js';

export type TourStatus = 'building' | 'ready';

export interface TourStep {
  id: string;
  tourId: string;
  sortOrder: number;
  filePath: string;
  startLine: number;
  endLine: number;
  body: string;
  annotation: string;
  createdAt: string;
}

export interface Tour {
  id: string;
  sessionId: string;
  topic: string;
  body: string;
  status: TourStatus;
  createdAt: string;
  steps: TourStep[];
}

interface TourRow {
  id: string;
  session_id: string;
  topic: string;
  body: string;
  status: string;
  created_at: string;
}

interface TourStepRow {
  id: string;
  tour_id: string;
  sort_order: number;
  file_path: string;
  start_line: number;
  end_line: number;
  body: string;
  annotation: string;
  created_at: string;
}

function rowToTourStep(row: TourStepRow): TourStep {
  return {
    id: row.id,
    tourId: row.tour_id,
    sortOrder: row.sort_order,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    body: row.body,
    annotation: row.annotation,
    createdAt: row.created_at,
  };
}

function rowToTour(row: TourRow, steps: TourStep[]): Tour {
  return {
    id: row.id,
    sessionId: row.session_id,
    topic: row.topic,
    body: row.body,
    status: row.status as TourStatus,
    createdAt: row.created_at,
    steps,
  };
}

export function createTour(sessionId: string, topic: string, body: string): Tour {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  const cleanBody = body;

  db.prepare(
    'INSERT INTO tours (id, session_id, topic, body, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, sessionId, topic, cleanBody, now);

  return {
    id,
    sessionId,
    topic,
    body: cleanBody,
    status: 'building',
    createdAt: now,
    steps: [],
  };
}

export function getTour(idOrPrefix: string): Tour | null {
  let row = queryOne<TourRow>('SELECT * FROM tours WHERE id = ?', idOrPrefix);

  if (!row && idOrPrefix.length >= 8) {
    row = queryOne<TourRow>('SELECT * FROM tours WHERE id LIKE ?', idOrPrefix + '%');
  }

  if (!row) {
    return null;
  }

  const stepRows = queryAll<TourStepRow>(
    'SELECT * FROM tour_steps WHERE tour_id = ? ORDER BY sort_order ASC',
    row.id,
  );

  return rowToTour(row, stepRows.map(rowToTourStep));
}

export function getToursForSession(sessionId: string): Tour[] {
  interface JoinedRow extends TourRow {
    s_id: string | null;
    s_sort_order: number | null;
    s_file_path: string | null;
    s_start_line: number | null;
    s_end_line: number | null;
    s_body: string | null;
    s_annotation: string | null;
    s_created_at: string | null;
  }

  const rows = queryAll<JoinedRow>(`
    SELECT t.*,
           s.id AS s_id, s.sort_order AS s_sort_order, s.file_path AS s_file_path,
           s.start_line AS s_start_line, s.end_line AS s_end_line,
           s.body AS s_body, s.annotation AS s_annotation, s.created_at AS s_created_at
    FROM tours t
    LEFT JOIN tour_steps s ON s.tour_id = t.id
    WHERE t.session_id = ?
    ORDER BY t.created_at ASC, s.sort_order ASC
  `, sessionId);

  const tours = new Map<string, Tour>();
  for (const row of rows) {
    let tour = tours.get(row.id);
    if (!tour) {
      tour = rowToTour(row, []);
      tours.set(row.id, tour);
    }
    if (row.s_id) {
      tour.steps.push({
        id: row.s_id,
        tourId: row.id,
        sortOrder: row.s_sort_order!,
        filePath: row.s_file_path!,
        startLine: row.s_start_line!,
        endLine: row.s_end_line!,
        body: row.s_body!,
        annotation: row.s_annotation!,
        createdAt: row.s_created_at!,
      });
    }
  }

  return Array.from(tours.values());
}

export function addTourStep(
  tourId: string,
  filePath: string,
  startLine: number,
  endLine: number,
  body: string,
  annotation: string,
): TourStep {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  const maxRow = queryOne<{ max_order: number }>(
    'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM tour_steps WHERE tour_id = ?',
    tourId,
  );
  const sortOrder = (maxRow?.max_order ?? 0) + 1;

  const cleanBody = body;
  const cleanAnnotation = annotation;

  db.prepare(
    'INSERT INTO tour_steps (id, tour_id, sort_order, file_path, start_line, end_line, body, annotation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, tourId, sortOrder, filePath, startLine, endLine, cleanBody, cleanAnnotation, now);

  return {
    id,
    tourId,
    sortOrder,
    filePath,
    startLine,
    endLine,
    body: cleanBody,
    annotation: cleanAnnotation,
    createdAt: now,
  };
}

export function updateTourStatus(tourId: string, status: TourStatus): void {
  const db = getDb();
  db.prepare('UPDATE tours SET status = ? WHERE id = ?').run(status, tourId);
}

/**
 * A walkthrough can be wrong — a mistaken step, a body mangled on the way in — and until now the
 * only remedy was to add another and rely on the newest winning, leaving the bad one behind.
 */
export function deleteTour(tourId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM tour_steps WHERE tour_id = ?').run(tourId);
  db.prepare('DELETE FROM tours WHERE id = ?').run(tourId);
}

/**
 * Spares a walkthrough that is still being written unless told otherwise: the whole point of the
 * building state is that something is mid-flight, and two agents on one session should not erase
 * each other. An agent replacing its own half-written walkthrough knows it is doing that, and says
 * so with `keepBuilding: false`.
 */
export function deleteToursForSession(
  sessionId: string,
  options: { keepBuilding?: boolean } = {},
): void {
  const keepBuilding = options.keepBuilding ?? true;
  const filter = keepBuilding ? " AND status != 'building'" : '';
  const db = getDb();
  db.prepare(
    `DELETE FROM tour_steps WHERE tour_id IN (
       SELECT id FROM tours WHERE session_id = ?${filter}
     )`,
  ).run(sessionId);
  db.prepare(`DELETE FROM tours WHERE session_id = ?${filter}`).run(sessionId);
}
