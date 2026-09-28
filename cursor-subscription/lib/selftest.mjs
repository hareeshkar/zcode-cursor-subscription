/**
 * Live self-test: prove a Cursor account can actually answer, across several
 * models, before the user wires anything into Settings.
 *
 * Two things this is careful about:
 *
 *  - **It does not hardcode a model.** `composer-2.5` is a snapshot, not a
 *    contract; the whole point is to discover what works today.
 *  - **It prefers cheap models.** Each probe is a real billable request against
 *    the user's subscription, so the default picks small/fast/low-tier entries
 *    and skips the expensive families outright. Proving the transport works
 *    does not require spending a premium model's tokens.
 *
 * @module cursor-subscription/selftest
 */

/**
 * Probe preference.
 *
 * Ordered by preference, not by a score: Composer first (it is the model this
 * integration is really for, and its `-fast`/`-low` variants are the cheapest
 * per request), then Grok, then any other cheap tier. Premium families are
 * skipped entirely — a transport check must never spend a Claude Opus token.
 */
const PREFERENCE = [
	// 1. Composer, cheapest variant first.
	{ tier: 0, match: /composer/i, cheapFirst: /-(fast|low|nano)$/i },
	// 2. Grok, cheapest variant first.
	{ tier: 1, match: /grok/i, cheapFirst: /-(low|fast|nano)$/i },
];

/** Families that are expensive to probe and add nothing to a transport check. */
const EXPENSIVE = /(^|[-_/])(claude|gpt|opus|sonnet|o[134])[-_/]/i;

/** Everything else, ranked by how cheap it looks. */
const CHEAP_TIERS = [
	{ rank: 0, re: /-(low|nano|minimal|none|flash)$/i },
	{ rank: 1, re: /-(fast|lite|small|mini)$/i },
	{ rank: 2, re: /(kimi|glm|muse|seed|qwen)/i },
	{ rank: 3, re: /-/ }, // any other non-premium variant
];

/**
 * Rank and filter models for probing.
 *
 * Exported separately so the ordering is unit-testable without a network call —
 * the alternative is a selection heuristic that only ever runs in production.
 *
 * @param {string[]} models every model the account can use.
 * @param {{ limit?: number, includeExpensive?: boolean }} options
 * @returns {string[]} up to `limit` models, most-preferred first.
 */
export function pickProbeModels(models, { limit = 6, includeExpensive = false } = {}) {
	const unique = [...new Set(models.filter((m) => typeof m === "string" && m.length > 0))];

	const rank = (model) => {
		for (const tier of PREFERENCE) {
			if (!tier.match.test(model)) continue;
			// A cheap variant of a preferred family outranks the plain one.
			return [tier.tier, tier.cheapFirst.test(model) ? 0 : 1, model.length, model];
		}
		if (EXPENSIVE.test(model)) return null;
		for (const tier of CHEAP_TIERS) {
			if (tier.re.test(model)) return [2, tier.rank, model.length, model];
		}
		return [3, 0, model.length, model];
	};

	// `rank` returns null for an expensive family, and that null is meaningful —
	// it means "ranked last". The previous version read `key[i]` straight off it,
	// so `pickProbeModels([...], { includeExpensive: true })` threw a TypeError
	// from exported API. The default path never took that branch, which is why it
	// survived. `null` is now handled explicitly rather than dereferenced.
	return unique
		.map((model) => ({ model, key: rank(model) }))
		.filter((entry) => includeExpensive || entry.key !== null)
		.sort((a, b) => {
			if (a.key === null && b.key === null) return 0;
			if (a.key === null) return 1;
			if (b.key === null) return -1;
			for (let i = 0; i < 4; i += 1) {
				if (a.key[i] !== b.key[i]) return a.key[i] < b.key[i] ? -1 : 1;
			}
			return 0;
		})
		.slice(0, limit)
		.map((entry) => entry.model);
}

/** The prompt each probe sends. Deliberately trivial and short. */
const PROBE_PROMPT = "Reply with the single word: PONG";

/** System prompt used for probes — enough to prove it survives translation. */
const PROBE_SYSTEM =
	"You are a connectivity probe. Follow the instruction exactly and reply with one word.";

/**
 * Run one completion through the shim and report what came back.
 *
 * Never throws: a failing model is a result, not an exception, because the
 * point is to find out which models work.
 *
 * @returns {Promise<{model: string, ok: boolean, ms: number, detail: string}>}
 */
export async function probeModel(baseUrl, apiKey, model, { timeoutMs = 60_000 } = {}) {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			signal: controller.signal,
			headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				model,
				stream: false,
				max_tokens: 16,
				messages: [
					// A system message is not optional here: proving the harness
					// prompt survives translation is half of what we are testing.
					{ role: "system", content: PROBE_SYSTEM },
					{ role: "user", content: PROBE_PROMPT },
				],
			}),
		});
		const body = await response.json();
		const ms = Date.now() - started;
		if (!response.ok) {
			return {
				model,
				ok: false,
				ms,
				detail: `HTTP ${response.status}: ${body?.error?.message ?? "unknown error"}`.slice(0, 200),
			};
		}
		const text = body?.choices?.[0]?.message?.content ?? "";
		return {
			model,
			ok: true,
			ms,
			detail: text.trim().slice(0, 80) || `(empty reply, ${body?.usage?.completion_tokens ?? 0} tokens)`,
		};
	} catch (error) {
		return {
			model,
			ok: false,
			ms: Date.now() - started,
			detail: error?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(error?.message ?? error).slice(0, 200),
		};
	} finally {
		clearTimeout(timer);
	}
}
