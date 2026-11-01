/**
 * Secret redaction for free text that leaves the user's control (skills generated from a session,
 * reports): API keys with known prefixes, bearer tokens and Authorization values, key=value and
 * 密码：值 pairs, JWTs, URL credentials and secret query parameters, and long random-looking strings.
 * Each hit becomes <redacted>.
 */

// URL credential and query-parameter redaction shared with the upstream bug report.
import { redactUrl } from "../core/bug-report.ts";

/** Replacement text. */
export const REDACTED = "<redacted>";

// Known key formats: OpenAI/Anthropic sk-, GitHub, Slack, AWS, Google, Hugging Face, GitLab, JWT.
const KNOWN_RE =
	/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
// "Bearer <token>" and "Authorization: <value>".
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const AUTH_RE = /\b(authorization|x-api-key|api-key|cookie)\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?[^\s,;]+/gi;
// Labelled values: api_key=…, token: …, password …, 密码：…, 密钥 …
const LABEL_RE =
	/(\b(?:api[_-]?key|access[_-]?token|secret|token|password|passwd|pwd)\b|密码|口令|密钥|令牌)(\s*(?:[:=：]|是|为)?\s*)([^\s，。；,;&<>]{4,})/gi;
// URLs.
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'，。；）]+/gi;
// Long random-looking strings: 32+ characters with letters and digits mixed.
const LONG_RE = /\b(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{32,}\b/g;

/** Text with secrets replaced by <redacted>. */
export function redactSecrets(text: string): string {
	// Known formats first, then header values and bearer tokens, URLs, labelled values, and anything long and random.
	return text
		.replace(KNOWN_RE, REDACTED)
		.replace(AUTH_RE, (_m, name: string) => `${name}: ${REDACTED}`)
		.replace(BEARER_RE, (_m, kind: string) => `${kind} ${REDACTED}`)
		.replace(URL_RE, (u) => redactUrl(u).replace(/%3Credacted%3E/gi, REDACTED))
		.replace(LABEL_RE, (_m, label: string, sep: string) => `${label}${sep}${REDACTED}`)
		.replace(LONG_RE, REDACTED);
}
