import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  parseAddTourStepRequest,
  parseCreateTourRequest,
  parseUpdateTourStatusRequest,
} from '@diffity/api';
import {
  createTour,
  deleteTour,
  getTour,
  getToursForSession,
  addTourStep,
  updateTourStatus,
} from './tours.js';
import { sendJson, sendError, withJsonBody } from './http-utils.js';
import { resolveSessionId, sessionRef } from './session.js';

export function handleTourRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  onTourViewed?: (ref: string) => void,
): boolean {
  if (pathname === '/api/tours' && req.method === 'GET') {
    const sid = resolveSessionId(url.searchParams.get('session'));
    if (!sid) {
      sendError(res, 400, 'No review session');
      return true;
    }
    const tours = getToursForSession(sid);
    sendJson(res, tours);
    return true;
  }

  if (pathname === '/api/tours' && req.method === 'POST') {
    withJsonBody(res, req, 'Failed to create tour', parseCreateTourRequest, (body) => {
      const tour = createTour(body.sessionId, body.topic, body.body ?? '');
      sendJson(res, tour);
    });
    return true;
  }

  const tourStepsMatch = pathname.match(/^\/api\/tours\/([^/]+)\/steps$/);
  if (tourStepsMatch && req.method === 'POST') {
    withJsonBody(res, req, 'Failed to add tour step', parseAddTourStepRequest, (body) => {
      const step = addTourStep(
        tourStepsMatch[1],
        body.filePath,
        body.startLine,
        body.endLine,
        body.body ?? '',
        body.annotation ?? '',
      );
      sendJson(res, step);
    });
    return true;
  }

  const tourMatch = pathname.match(/^\/api\/tours\/([^/]+)$/);
  if (tourMatch && req.method === 'DELETE') {
    deleteTour(tourMatch[1]);
    sendJson(res, { ok: true });
    return true;
  }

  if (tourMatch && req.method === 'GET') {
    const tour = getTour(tourMatch[1]);
    if (!tour) {
      sendError(res, 404, 'Tour not found');
      return true;
    }
    // Reading a tour is reading its session: the tour page's chrome also touches the tree
    // routes, so without this the agent would follow those to the tree instead. Carry-forward
    // moves tour rows, so the session this row names is already the newest of its review.
    const ref = sessionRef(tour.sessionId);
    if (ref) {
      onTourViewed?.(ref);
    }
    sendJson(res, tour);
    return true;
  }

  if (tourMatch && req.method === 'PATCH') {
    withJsonBody(res, req, 'Failed to update tour', parseUpdateTourStatusRequest, (body) => {
      updateTourStatus(tourMatch![1], body.status);
      sendJson(res, { ok: true });
    });
    return true;
  }

  return false;
}
