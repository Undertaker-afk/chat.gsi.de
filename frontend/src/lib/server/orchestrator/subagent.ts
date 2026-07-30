/**
 * A research subagent: retrieve -> read -> report.
 *
 * Subagents are deliberately leaf nodes. They cannot spawn further subagents --
 * one level of nesting, no recursion, so worst-case cost is exactly
 * maxRounds × maxSubagentsPerRound calls and can be reasoned about up front.
 */
import { config } from '../config';
import { complete, parseJson } from '../llm';
import { formatContext, retrieve } from '../retrieval';
import type { CitationPool, Finding } from './types';

interface SubagentReply {
	summary: string;
	markers: number[];
	confidence: 'high' | 'medium' | 'low';
}

export async function runSubagent(
	agentId: string,
	query: string,
	pool: CitationPool,
	systemPrompt: string,
	signal: AbortSignal,
	// Subagents inherit the caller's grants unchanged. There is deliberately no
	// way for one to widen them: they are leaf nodes with no authority of their own.
	kbIds?: number[]
): Promise<Finding> {
	const chunks = await retrieve(query, {
		limit: config.orchestrator.contextChunksDeep,
		signal,
		kbIds
	});

	if (chunks.length === 0) {
		return {
			agentId,
			query,
			summary: `No documentation found for: ${query}`,
			markers: [],
			confidence: 'low'
		};
	}

	// The subagent sees local markers [1..n]; the pool holds global ones. Reporting
	// global markers directly would let one agent's numbering leak into another's.
	const localToGlobal = chunks.map((chunk) => pool.add(chunk));

	const raw = await complete(
		[
			{ role: 'system', content: systemPrompt },
			{
				role: 'user',
				content: `Sub-question: ${query}\n\nSources:\n\n${formatContext(chunks)}`
			}
		],
		{ maxTokens: 600, temperature: 0.1, json: true, signal }
	);

	const parsed = parseJson<SubagentReply>(raw);
	if (!parsed) {
		// Degrade rather than fail: the prose is still usable as a finding.
		return {
			agentId,
			query,
			summary: raw.slice(0, 800),
			markers: localToGlobal.slice(0, 3),
			confidence: 'low'
		};
	}

	const markers = (parsed.markers ?? [])
		.filter((m) => Number.isInteger(m) && m >= 1 && m <= localToGlobal.length)
		.map((m) => localToGlobal[m - 1]);

	return {
		agentId,
		query,
		summary: parsed.summary ?? '',
		markers: [...new Set(markers)],
		confidence: parsed.confidence ?? 'medium'
	};
}
