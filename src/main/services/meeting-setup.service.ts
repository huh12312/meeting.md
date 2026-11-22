/**
 * Meeting Setup Service
 * Handles LLM calls for generating probing questions and meeting checklist
 */

import { logger } from '../lib/logger';
import { getLLMService } from './llm.service';
import {
  PROBING_QUESTIONS_SYSTEM_PROMPT,
  buildProbingQuestionsUserPrompt,
  CHECKLIST_SYSTEM_PROMPT,
  buildChecklistUserPrompt,
} from './meeting-setup.prompts';
import type {
  ProbingQuestion,
  ProbingQuestionsResponse,
  ChecklistResponse,
} from '../../shared/types/meeting-setup.types';

const log = logger.child({ module: 'meeting-setup-service' });

export class MeetingSetupService {
  /**
   * Generate probing questions based on meeting name and description
   */
  async generateProbingQuestions(
    name: string,
    description: string
  ): Promise<{ success: boolean; questions: ProbingQuestion[]; error?: string }> {
    log.info({ name, description: description.slice(0, 100) }, 'Generating probing questions');

    const llm = getLLMService();
    const userPrompt = buildProbingQuestionsUserPrompt(name, description);

    const response = await llm.chatCompletionJSON<ProbingQuestionsResponse>([
      { role: 'system', content: PROBING_QUESTIONS_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ]);

    if (!response.success || !response.data) {
      log.error({ error: response.error }, 'Failed to generate probing questions');
      return {
        success: false,
        questions: [],
        error: response.error || 'Failed to generate questions',
      };
    }

    // Map response to ProbingQuestion format
    const questions: ProbingQuestion[] = response.data.questions.map((q) => ({
      question: q.question,
      options: q.options,
      answer: '',
      customAnswer: undefined,
    }));

    log.info({ questionCount: questions.length }, 'Probing questions generated');
    return { success: true, questions };
  }

  /**
   * Generate meeting checklist based on setup data
   */
  async generateChecklist(
    name: string,
    description: string,
    questions: ProbingQuestion[]
  ): Promise<{ success: boolean; checklist: string[]; error?: string }> {
    log.info({ name, questionCount: questions.length }, 'Generating meeting checklist');

    const llm = getLLMService();
    const userPrompt = buildChecklistUserPrompt(name, description, questions);

    const response = await llm.chatCompletionJSON<ChecklistResponse>([
      { role: 'system', content: CHECKLIST_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ]);

    if (!response.success || !response.data) {
      log.error({ error: response.error }, 'Failed to generate checklist');
      return {
        success: false,
        checklist: [],
        error: response.error || 'Failed to generate checklist',
      };
    }

    // The model occasionally answers with a bare array or a differently named
    // key; accept any list of strings rather than failing the whole wizard.
    const data: unknown = response.data;
    const candidate = Array.isArray(data)
      ? data
      : (response.data.checklist ??
        Object.values(data as Record<string, unknown>).find((value) => Array.isArray(value)));
    const checklist = Array.isArray(candidate)
      ? candidate.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];

    if (checklist.length === 0) {
      log.error({ data }, 'Checklist response contained no items');
      return { success: false, checklist: [], error: 'The model returned no checklist items' };
    }

    log.info({ checklistCount: checklist.length }, 'Meeting checklist generated');
    return { success: true, checklist };
  }
}

// Singleton instance
let instance: MeetingSetupService | null = null;

export function getMeetingSetupService(): MeetingSetupService {
  if (!instance) {
    instance = new MeetingSetupService();
  }
  return instance;
}

export function resetMeetingSetupService(): void {
  instance = null;
}
