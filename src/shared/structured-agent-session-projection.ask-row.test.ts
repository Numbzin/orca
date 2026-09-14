import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { projectStructuredItemToNativeChat } from './structured-agent-session-projection'

const PENDING = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

function item(itemId: string, body: AgentJournalRenderItem['body']): AgentJournalRenderItem {
  return { itemId, sequence: 1, revision: 1, observedAt: 1, body }
}

describe('structured agent session ask-row projection', () => {
  it('gives a pending question a row instead of dropping it from the transcript', () => {
    // Codex only ever journals the question, so without this the reader sees
    // nothing in the log while the agent is blocked on them.
    const projected = projectStructuredItemToNativeChat(
      item('q', {
        kind: 'question',
        question: 'Which branch?',
        options: [{ id: 'q1:main', label: 'main' }],
        resolution: { ...PENDING }
      })
    )

    expect(projected?.role).toBe('assistant')
    expect(projected?.blocks).toEqual([
      {
        type: 'tool-call',
        name: 'request_user_input',
        input: { questions: [{ question: 'Which branch?' }] },
        state: 'running'
      }
    ])
  })

  it('prefers a grouped prompt own questions over the label naming their count', () => {
    const projected = projectStructuredItemToNativeChat(
      item('grouped', {
        kind: 'question',
        question: '2 grouped questions from Claude',
        options: [],
        questions: [
          { id: 'q1', question: 'Which targets?', multiSelect: true, options: [] },
          { id: 'q2', question: 'Proceed?', multiSelect: false, options: [] }
        ],
        resolution: { ...PENDING }
      })
    )

    expect(projected?.blocks).toEqual([
      {
        type: 'tool-call',
        name: 'request_user_input',
        input: { questions: [{ question: 'Which targets?' }, { question: 'Proceed?' }] },
        state: 'running'
      }
    ])
  })

  it('drops the question tool call itself so the row is not drawn twice', () => {
    // Claude journals both the `AskUserQuestion` call and the question it
    // raised; the question item above is the one that draws the row.
    expect(
      projectStructuredItemToNativeChat(
        item('ask', {
          kind: 'tool-call',
          name: 'AskUserQuestion',
          input: { questions: [{ question: 'Which branch?' }] },
          state: 'running'
        })
      )
    ).toBeNull()
  })

  it('keeps an ordinary tool call', () => {
    expect(
      projectStructuredItemToNativeChat(
        item('read', {
          kind: 'tool-call',
          name: 'Read',
          input: { file_path: 'a.ts' },
          state: 'running'
        })
      )?.blocks
    ).toHaveLength(1)
  })
})
