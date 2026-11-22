/**
 * Live Assist Service
 *
 * Runs every 20 seconds during recording, analyzes recent transcript,
 * and generates contextual assists (things to say, questions to ask)
 * using an LLM.
 */

import { EventEmitter } from 'events';
import { logger } from '../lib/logger';
import { getLLMService } from './llm.service';
import type { LiveInsights } from '../../shared/types/live-assist.types';
import type { ProbingQuestion } from '../../shared/types/meeting-setup.types';
import {
  LIVE_ASSIST_SYSTEM_PROMPT,
  buildAlreadySuggestedSection,
  filterNewSuggestions,
  rememberSuggestions,
} from '../lib/live-assist-prompt';

const log = logger.child({ module: 'live-assist' });

const LIVE_ASSIST_INTERVAL_MS = 20000; // 20 seconds

export interface MeetingContext {
  name?: string;
  description?: string;
  questions?: ProbingQuestion[];
  checklist?: string[];
}

interface TranscriptChunk {
  text: string;
  source: 'mic' | 'system_audio';
  timestamp: number;
}

interface VisualIndexChunk {
  text: string;
  timestamp: number;
}

class LiveAssistService extends EventEmitter {
  private intervalTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private transcriptBuffer: TranscriptChunk[] = [];
  private visualIndexBuffer: VisualIndexChunk[] = [];
  private previousSayThis: string[] = [];
  private previousAskThis: string[] = [];
  private lastProcessedTimestamp = 0;
  private meetingContext: MeetingContext | null = null;

  /**
   * Start the live assist loop
   */
  start(context?: MeetingContext): void {
    if (this.isRunning) {
      // A new meeting must not inherit the last one's context or suggestions.
      log.warn('Live assist was still running; restarting it for the new meeting');
      this.stop();
    }

    log.info({ context: context ? { name: context.name, hasDescription: !!context.description } : null }, 'Starting live assist service');
    this.isRunning = true;
    this.transcriptBuffer = [];
    this.visualIndexBuffer = [];
    this.previousSayThis = [];
    this.previousAskThis = [];
    this.lastProcessedTimestamp = Date.now();
    this.meetingContext = context || null;

    // Run immediately, then every 20 seconds
    this.processTranscript();
    this.intervalTimer = setInterval(() => {
      this.processTranscript();
    }, LIVE_ASSIST_INTERVAL_MS);
  }

  /**
   * Stop the live assist loop
   */
  stop(): void {
    if (!this.isRunning) return;

    log.info('Stopping live assist service');
    this.isRunning = false;

    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    this.transcriptBuffer = [];
    this.visualIndexBuffer = [];
    this.previousSayThis = [];
    this.previousAskThis = [];
    this.meetingContext = null;
  }

  /**
   * Add a transcript segment to the buffer
   */
  addTranscript(text: string, source: 'mic' | 'system_audio'): void {
    if (!this.isRunning) return;

    this.transcriptBuffer.push({
      text,
      source,
      timestamp: Date.now(),
    });

    // Keep only last 60 seconds of transcript for context
    const cutoff = Date.now() - 60000;
    this.transcriptBuffer = this.transcriptBuffer.filter(t => t.timestamp > cutoff);
  }

  /**
   * Add a visual index event to the buffer
   */
  addVisualIndex(text: string): void {
    if (!this.isRunning) return;

    this.visualIndexBuffer.push({
      text,
      timestamp: Date.now(),
    });

    // Keep only last 60 seconds of visual index for context
    const cutoff = Date.now() - 60000;
    this.visualIndexBuffer = this.visualIndexBuffer.filter(v => v.timestamp > cutoff);
  }

  /**
   * Build meeting context section for prompt (only if context exists)
   */
  private buildMeetingContextSection(): string {
    if (!this.meetingContext) return '';

    const parts: string[] = [];

    if (this.meetingContext.name) {
      parts.push(`Meeting: ${this.meetingContext.name}`);
    }

    if (this.meetingContext.description) {
      parts.push(`Purpose: ${this.meetingContext.description}`);
    }

    if (this.meetingContext.questions && this.meetingContext.questions.length > 0) {
      const answeredQuestions = this.meetingContext.questions
        .filter(q => q.answer)
        .map(q => `- ${q.question}: ${q.answer}`)
        .join('\n');
      if (answeredQuestions) {
        parts.push(`Key context from prep:\n${answeredQuestions}`);
      }
    }

    if (this.meetingContext.checklist && this.meetingContext.checklist.length > 0) {
      parts.push(`Goals to cover:\n${this.meetingContext.checklist.map(c => `- ${c}`).join('\n')}`);
    }

    if (parts.length === 0) return '';

    return `## MEETING CONTEXT\n${parts.join('\n\n')}\n\n---\n\n`;
  }

  /**
   * Build visual index section for prompt (only if recent visual data exists)
   */
  private buildVisualIndexSection(cutoff: number): string {
    const recentVisuals = this.visualIndexBuffer.filter(v => v.timestamp > cutoff);
    if (recentVisuals.length === 0) return '';

    const visualText = recentVisuals.map(v => v.text).join('\n');
    return `## SCREEN CONTENT (use only if relevant to the meeting)\n${visualText}\n\n---\n\n`;
  }

  /**
   * Process transcript and generate assists
   */
  private async processTranscript(): Promise<void> {
    if (!this.isRunning) return;

    // Get transcript from last 20 seconds
    const cutoff = Date.now() - LIVE_ASSIST_INTERVAL_MS;
    const recentChunks = this.transcriptBuffer.filter(t => t.timestamp > cutoff);

    if (recentChunks.length === 0) {
      log.debug('No recent transcript to process');
      return;
    }

    // Build transcript text with speaker labels
    const transcriptText = recentChunks
      .map(chunk => {
        const speaker = chunk.source === 'mic' ? 'User' : 'Them';
        return `[${speaker}]: ${chunk.text}`;
      })
      .join('\n');

    // Build context sections (only included if they have content)
    const meetingContextSection = this.buildMeetingContextSection();
    const visualIndexSection = this.buildVisualIndexSection(cutoff);

    const alreadySuggestedSection = buildAlreadySuggestedSection(this.previousSayThis, this.previousAskThis);

    const userPrompt = `${meetingContextSection}${visualIndexSection}${alreadySuggestedSection}## TRANSCRIPT\n${transcriptText}`;

    log.info({ chunkCount: recentChunks.length, textLength: transcriptText.length, hasContext: !!meetingContextSection, hasVisual: !!visualIndexSection }, 'Processing transcript for live assist');

    try {
      const llm = getLLMService();
      const response = await llm.chatCompletionJSON<LiveInsights>([
        { role: 'system', content: LIVE_ASSIST_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ]);

      if (!response.success || !response.data) {
        log.warn({ error: response.error }, 'Failed to get live assist response');
        return;
      }

      // The meeting may have ended while the model was answering.
      if (!this.isRunning) return;

      const { say_this, ask_this } = response.data;
      log.debug({ say_this, ask_this }, 'Insights generated for this chunk');

      // The prompt asks for no repeats; this also drops reworded ones.
      const newSayThis = filterNewSuggestions(say_this, this.previousSayThis);
      const newAskThis = filterNewSuggestions(ask_this, this.previousAskThis);

      this.previousSayThis = rememberSuggestions(this.previousSayThis, newSayThis);
      this.previousAskThis = rememberSuggestions(this.previousAskThis, newAskThis);

      if (newSayThis.length > 0 || newAskThis.length > 0) {
        log.info({ sayCount: newSayThis.length, askCount: newAskThis.length }, 'Generated new live insights');
        this.emit('insights', {
          insights: { say_this: newSayThis, ask_this: newAskThis },
          processedAt: Date.now(),
        });
      }
    } catch (error) {
      log.error({ error }, 'Error processing transcript for live assist');
    }
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.transcriptBuffer = [];
    this.visualIndexBuffer = [];
    this.previousSayThis = [];
    this.previousAskThis = [];
    this.meetingContext = null;
  }
}

// Singleton instance
let instance: LiveAssistService | null = null;

export function getLiveAssistService(): LiveAssistService {
  if (!instance) {
    instance = new LiveAssistService();
  }
  return instance;
}

export function resetLiveAssistService(): void {
  if (instance) {
    instance.stop();
    instance.removeAllListeners();
    instance = null;
  }
}

export { LiveAssistService };
export type { TranscriptChunk };
