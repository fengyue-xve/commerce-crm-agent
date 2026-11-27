import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TestPanel } from '@/app/app/ai/agents/[id]/_components/TestPanel';
import { newPreviewResult, type TurnPreview } from './preview';
import { buildTurnTools, type BuildTurnToolsInput } from './turn-tools';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/hooks/i18n/useT', () => ({ useT: () => (message: string) => message }));
vi.mock('@/lib/api/client', () => ({ apiClient: { post } }));
vi.mock('@/lib/env', () => ({ env: {} }));

describe('knowledge search in the agent test panel', () => {
  it.each([
    ['provider timeout', 'knowledge_unavailable', 'A base de conhecimento está indisponível. Tente a consulta novamente.'],
    ['embedding_sem_chave', 'knowledge_sem_chave', 'Configure uma chave de IA para consultar a base de conhecimento.'],
  ])('shows %s and clears the issue after a successful retry without hits', async (cause, code, message) => {
    const result = newPreviewResult();
    const existingIssue = { code: 'other_issue', message: 'Outro aviso' };
    result.impediments.push(existingIssue);
    const preview = { kind: 'sandbox', channelId: null, result } as TurnPreview;
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const embed = vi.fn()
      .mockRejectedValueOnce(new Error(cause))
      .mockRejectedValueOnce(new Error(cause))
      .mockResolvedValue({ embedding: [0.1] });
    const { rawTools } = await buildTurnTools({
      pool: { query },
      deps: { embed, knobs: {} },
      preview,
      tenantId: 'test-org',
      agentConfig: { knowledgeSourceIds: ['configured-source'], toolIds: [], operatorToolIds: [] },
      skillMatch: { matched: [] },
    } as unknown as BuildTurnToolsInput);
    const search = () => rawTools.search_knowledge!.execute!(
      { query: 'Qual é o prazo de envio?' },
      { toolCallId: 'test-search', messages: [], context: undefined },
    );
    const panelProps = {
      agent: { id: 'agent' },
      draft: null,
      published: { id: 'version', status: 'published', version_number: 1 },
    } as ComponentProps<typeof TestPanel>;
    post.mockReset().mockImplementationOnce(async () => {
      await expect(search()).resolves.toMatchObject({ ok: false, error: { code } });
      await expect(search()).resolves.toMatchObject({ ok: false, error: { code } });
      return { data: { ...structuredClone(result), status: 'blocked' } };
    }).mockImplementationOnce(async () => {
      await expect(search()).resolves.toEqual({ ok: true, results: [] });
      return { data: { ...structuredClone(result), status: 'blocked' } };
    });

    render(createElement(TestPanel, panelProps));
    fireEvent.change(screen.getByLabelText('Mensagem do cliente (sample)'), {
      target: { value: 'Qual é o prazo de envio?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Executar teste' }));
    await screen.findByText(message);
    expect(result.impediments).toEqual([existingIssue, { code, message }]);
    expect(query).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Executar teste' }));
    await waitFor(() => expect(query).toHaveBeenCalled());
    await screen.findByText(existingIssue.message);
    expect(screen.queryByText(message)).toBeNull();
    expect(result.impediments).toEqual([existingIssue]);
    expect(query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['test-org', ['configured-source']]));
  });
});
