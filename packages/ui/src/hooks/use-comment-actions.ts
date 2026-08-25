import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CommentAuthor, CommentSide, CommentThread } from '../components/comments/types';
import * as api from '../lib/api';
import { localResolveNotice } from '../lib/submitted-marker';

export function useCommentActions(sessionId: string | null, enabled: boolean) {
  const queryClient = useQueryClient();

  const invalidateThreads = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['threads', sessionId] });
  }, [queryClient, sessionId]);

  const addThread = useCallback((filePath: string, side: CommentSide, startLine: number, endLine: number, body: string, author: CommentAuthor, anchorContent?: string, options?: api.ReplyOptions) => {
    if (!enabled || !sessionId) {
      return;
    }
    api.createThread({
      sessionId, filePath, side, startLine, endLine, body, author, anchorContent,
      kind: options?.aside ? 'aside' : 'review',
      live: options?.live === true,
      intent: options?.intent ?? 'ask',
    }).then(() => {
      invalidateThreads();
    });
  }, [enabled, sessionId, invalidateThreads]);

  const addReply = useCallback((threadId: string, body: string, author: CommentAuthor, options?: api.ReplyOptions) => {
    if (!enabled) {
      return;
    }
    api.replyToThread(threadId, body, author, options).then(() => {
      invalidateThreads();
    });
  }, [enabled, invalidateThreads]);

  const resolveThread = useCallback((threadId: string) => {
    if (!enabled) {
      return;
    }
    const threads = queryClient.getQueryData<CommentThread[]>(['threads', sessionId]);
    const notice = localResolveNotice(threads?.find(thread => thread.id === threadId)?.submittedAt);

    api.updateThreadStatus(threadId, 'resolved').then(() => {
      invalidateThreads();
      if (notice) {
        toast.info(notice);
      }
    });
  }, [enabled, invalidateThreads, queryClient, sessionId]);

  const unresolveThread = useCallback((threadId: string) => {
    if (!enabled) {
      return;
    }
    api.updateThreadStatus(threadId, 'open').then(() => {
      invalidateThreads();
    });
  }, [enabled, invalidateThreads]);

  const dismissThread = useCallback((threadId: string) => {
    if (!enabled) {
      return;
    }
    api.updateThreadStatus(threadId, 'dismissed').then(() => {
      invalidateThreads();
    });
  }, [enabled, invalidateThreads]);

  const editComment = useCallback((commentId: string, body: string) => {
    if (!enabled) {
      return;
    }
    api.editComment(commentId, body).then(() => {
      invalidateThreads();
    });
  }, [enabled, invalidateThreads]);

  const deleteComment = useCallback((threadId: string, commentId: string) => {
    if (!enabled) {
      return;
    }
    api.deleteComment(commentId).then(() => {
      invalidateThreads();
    });
  }, [enabled, invalidateThreads]);

  const deleteThread = useCallback((threadId: string) => {
    if (!enabled) {
      return;
    }
    api.deleteThread(threadId).then(() => {
      invalidateThreads();
    });
  }, [enabled, invalidateThreads]);

  const deleteAllThreads = useCallback(() => {
    if (!enabled || !sessionId) {
      return;
    }
    api.deleteAllThreads(sessionId).then(() => {
      invalidateThreads();
    });
  }, [enabled, sessionId, invalidateThreads]);

  return {
    addThread,
    addReply,
    resolveThread,
    unresolveThread,
    dismissThread,
    editComment,
    deleteComment,
    deleteThread,
    deleteAllThreads,
  };
}

export type CommentActions = ReturnType<typeof useCommentActions>;
