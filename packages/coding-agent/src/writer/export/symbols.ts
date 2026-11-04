/**
 * Symbols for Word: LaTeX math ($\rightarrow$, \(x^2\)), LaTeX commands written in the prose, HTML entities
 * (&rarr;, &#8594;) and Markdown escapes (\_) become the Unicode characters Word shows directly (→, x², _).
 * A $…$ pair counts as math only when it holds a command, ^, _ or braces, so prices such as $100 stay.
 * Inline code and URLs are kept as they are; commands without a Unicode form are kept and reported.
 */

/** Result of converting one paragraph. */
export interface SymbolResult {
	// The paragraph with Unicode symbols.
	text: string;
	// Number of math spans, commands, entities and escapes converted.
	converted: number;
	// LaTeX commands left without a Unicode form ("\foo"), each once.
	unknown: string[];
}

/** LaTeX commands and their Unicode characters. */
const COMMANDS: Readonly<Record<string, string>> = {
	// Arrows.
	rightarrow: "→",
	to: "→",
	longrightarrow: "→",
	leftarrow: "←",
	gets: "←",
	longleftarrow: "←",
	leftrightarrow: "↔",
	Rightarrow: "⇒",
	implies: "⇒",
	Longrightarrow: "⇒",
	Leftarrow: "⇐",
	Leftrightarrow: "⇔",
	iff: "⇔",
	uparrow: "↑",
	downarrow: "↓",
	updownarrow: "↕",
	mapsto: "↦",
	nearrow: "↗",
	searrow: "↘",
	// Relations.
	leq: "≤",
	le: "≤",
	leqslant: "≤",
	geq: "≥",
	ge: "≥",
	geqslant: "≥",
	neq: "≠",
	ne: "≠",
	approx: "≈",
	sim: "∼",
	simeq: "≃",
	cong: "≅",
	equiv: "≡",
	propto: "∝",
	ll: "≪",
	gg: "≫",
	in: "∈",
	notin: "∉",
	ni: "∋",
	subset: "⊂",
	subseteq: "⊆",
	supset: "⊃",
	supseteq: "⊇",
	perp: "⊥",
	parallel: "∥",
	mid: "∣",
	// Operators.
	times: "×",
	div: "÷",
	pm: "±",
	mp: "∓",
	cdot: "·",
	cdots: "⋯",
	ldots: "…",
	dots: "…",
	circ: "∘",
	ast: "∗",
	star: "⋆",
	bullet: "•",
	oplus: "⊕",
	otimes: "⊗",
	cup: "∪",
	cap: "∩",
	setminus: "∖",
	wedge: "∧",
	land: "∧",
	vee: "∨",
	lor: "∨",
	neg: "¬",
	lnot: "¬",
	sum: "∑",
	prod: "∏",
	int: "∫",
	oint: "∮",
	partial: "∂",
	nabla: "∇",
	infty: "∞",
	forall: "∀",
	exists: "∃",
	emptyset: "∅",
	varnothing: "∅",
	angle: "∠",
	triangle: "△",
	therefore: "∴",
	because: "∵",
	prime: "′",
	degree: "°",
	surd: "√",
	langle: "⟨",
	rangle: "⟩",
	lfloor: "⌊",
	rfloor: "⌋",
	lceil: "⌈",
	rceil: "⌉",
	// Lowercase Greek.
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	epsilon: "ε",
	varepsilon: "ε",
	zeta: "ζ",
	eta: "η",
	theta: "θ",
	vartheta: "ϑ",
	iota: "ι",
	kappa: "κ",
	lambda: "λ",
	mu: "μ",
	nu: "ν",
	xi: "ξ",
	pi: "π",
	rho: "ρ",
	sigma: "σ",
	tau: "τ",
	upsilon: "υ",
	phi: "φ",
	varphi: "φ",
	chi: "χ",
	psi: "ψ",
	omega: "ω",
	// Capital Greek.
	Gamma: "Γ",
	Delta: "Δ",
	Theta: "Θ",
	Lambda: "Λ",
	Xi: "Ξ",
	Pi: "Π",
	Sigma: "Σ",
	Upsilon: "Υ",
	Phi: "Φ",
	Psi: "Ψ",
	Omega: "Ω",
	// Spacing: thin spaces vanish, wide ones become one space.
	quad: " ",
	qquad: " ",
	// Sizing and delimiters that only change the look.
	left: "",
	right: "",
	big: "",
	Big: "",
	bigg: "",
	Bigg: "",
	displaystyle: "",
	limits: "",
};

/** Commands whose argument in braces is kept as plain text. */
const TEXT_COMMANDS =
	/\\(?:text|textrm|textbf|textit|mathrm|mathbf|mathit|mathsf|mathtt|mathbb|mathcal|boldsymbol|operatorname)\s*\{([^{}]*)\}/g;

/** Superscript and subscript forms of the characters that have one. */
const SUPER: Readonly<Record<string, string>> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	n: "ⁿ",
	i: "ⁱ",
};
const SUB: Readonly<Record<string, string>> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
	a: "ₐ",
	e: "ₑ",
	o: "ₒ",
	x: "ₓ",
	h: "ₕ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	p: "ₚ",
	s: "ₛ",
	t: "ₜ",
};

/** HTML named entities a model writes into prose, and their characters. */
const ENTITIES: Readonly<Record<string, string>> = {
	rarr: "→",
	larr: "←",
	harr: "↔",
	uarr: "↑",
	darr: "↓",
	rArr: "⇒",
	lArr: "⇐",
	hArr: "⇔",
	times: "×",
	divide: "÷",
	plusmn: "±",
	le: "≤",
	ge: "≥",
	ne: "≠",
	asymp: "≈",
	equiv: "≡",
	infin: "∞",
	deg: "°",
	middot: "·",
	bull: "•",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	minus: "−",
	nbsp: " ",
	ensp: " ",
	emsp: " ",
	thinsp: "",
	lt: "<",
	gt: ">",
	amp: "&",
	quot: '"',
	apos: "'",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	laquo: "«",
	raquo: "»",
	copy: "©",
	reg: "®",
	trade: "™",
	sect: "§",
	para: "¶",
	permil: "‰",
	yen: "¥",
	euro: "€",
	pound: "£",
	cent: "¢",
	micro: "µ",
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	pi: "π",
	sigma: "σ",
	mu: "μ",
	lambda: "λ",
	omega: "ω",
	Delta: "Δ",
	Sigma: "Σ",
	Omega: "Ω",
};

// Private-use markers around the index of a kept span (code, URL).
const OPEN = "\uE002";
const CLOSE = "\uE003";
// Private-use markers for literal braces (\{ \}) inside math.
const LBRACE = "\uE004";
const RBRACE = "\uE005";
// Private-use marker for a space math keeps (inside \text{…}, "\ ", \quad); other spaces in math vanish, as in LaTeX.
const SPACE = "\uE006";

/** A superscript or subscript: every character in its raised or lowered form, or ^(…) / _(…) when one has none. */
function script(body: string, table: Readonly<Record<string, string>>, mark: string): string {
	// All characters must have a form, or the plain text keeps its meaning with the mark and brackets.
	const chars = [...body];
	if (chars.length > 0 && chars.every((c) => table[c] !== undefined)) return chars.map((c) => table[c]).join("");
	return chars.length === 1 ? `${mark}${body}` : `${mark}(${body})`;
}

/** LaTeX math (without its $ delimiters) → Unicode text; unknown commands are kept and collected.
 * Spaces in math only separate commands, so they go, except inside \text{…} and explicit spaces. */
export function latexToUnicode(math: string, unknown: string[] = []): string {
	// Degrees and primes written as superscripts.
	let s = math.replace(/\^\s*\{?\s*\\circ\s*\}?/g, "°").replace(/\^\s*\{?\s*\\prime\s*\}?/g, "′");
	// Text inside \text{…} and font commands, innermost first.
	for (let before = ""; before !== s; ) {
		before = s;
		s = s.replace(TEXT_COMMANDS, (_m, text: string) => text.replace(/ /g, SPACE));
	}
	// Escaped characters (literal braces held as markers so the grouping braces can go) and thin spaces.
	s = s
		.replace(/\\\{/g, LBRACE)
		.replace(/\\\}/g, RBRACE)
		.replace(/\\([%$&#_])/g, "$1")
		.replace(/\\[,;:!>]/g, "")
		.replace(/\\ /g, SPACE);
	// Named commands (\quad and \qquad are kept spaces).
	s = s.replace(/\\([A-Za-z]+)/g, (m, name: string) => {
		const u = COMMANDS[name];
		if (u !== undefined) return u === " " ? SPACE : u;
		// \frac and \sqrt are handled below; others are kept and reported.
		if (name !== "frac" && name !== "dfrac" && name !== "tfrac" && name !== "sqrt" && !unknown.includes(m))
			unknown.push(m);
		return m;
	});
	// Fractions and roots, innermost groups first.
	const wrap = (x: string) => (/^[\p{L}\p{N}.′°]+$/u.test(x.trim()) ? x.trim() : `(${x.trim()})`);
	for (let before = ""; before !== s; ) {
		before = s;
		s = s
			.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_m, a: string, b: string) => `${wrap(a)}/${wrap(b)}`)
			.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_m, a: string) => `√${wrap(a)}`);
	}
	// Superscripts and subscripts: ^{…}, ^x, _{…}, _x.
	s = s
		.replace(/\^\s*\{([^{}]*)\}|\^\s*(\S)/g, (_m, g: string | undefined, c: string | undefined) =>
			script((g ?? c ?? "").trim(), SUPER, "^"),
		)
		.replace(/_\s*\{([^{}]*)\}|_\s*(\S)/g, (_m, g: string | undefined, c: string | undefined) =>
			script((g ?? c ?? "").trim(), SUB, "_"),
		);
	// Remaining grouping braces and spaces go; literal braces and kept spaces come back.
	return s
		.replace(/[{}\s]/g, "")
		.replace(new RegExp(LBRACE, "g"), "{")
		.replace(new RegExp(RBRACE, "g"), "}")
		.replace(new RegExp(SPACE, "g"), " ")
		.trim();
}

/** Unicode symbols for one paragraph: math spans, LaTeX commands, HTML entities and Markdown escapes. */
export function fixSymbols(paragraph: string): SymbolResult {
	// Counters.
	let converted = 0;
	const unknown: string[] = [];
	// Inline code and URLs kept aside.
	const kept: string[] = [];
	let s = paragraph.replace(
		/`[^`]*`|\bhttps?:\/\/[^\s<>()（）\u3000-\u303f\uff00-\uffef]+/g,
		(m) => `${OPEN}${kept.push(m) - 1}${CLOSE}`,
	);
	// Math: $$…$$; $…$, \(…\) and \[…\] with a command, ^, _ or braces inside; and $…$ holding only a variable or a
	// short formula ($A$, $x + y$): Latin or Greek letters, digits and operators, not starting with a digit, with
	// spaces only around an operator (so $100 和 $200, costs $x and $y, and \[1\] stay text).
	const math = (_m: string, body: string) => {
		converted++;
		return latexToUnicode(body, unknown);
	};
	const plainMath = (m: string, body: string) => (/\s/.test(body) && !/[=+\-*/<>]/.test(body) ? m : math(m, body));
	s = s
		.replace(/\$\$([^$]+?)\$\$/g, math)
		.replace(/\$(?!\s)([^$\n]*?[\\^_{}][^$\n]*?)(?<!\s)\$/g, math)
		.replace(/\$(?![\s\d])([A-Za-z\u0370-\u03ff0-9=+\-*/<>.,()|' ]{1,40}?)(?<!\s)\$/g, plainMath)
		.replace(/\\\(([^\n]*?[\\^_{}][^\n]*?)\\\)/g, math)
		.replace(/\\\[([^\n]*?[\\^_{}][^\n]*?)\\\]/g, math);
	// Known LaTeX commands written in the prose (\rightarrow); unknown ones (paths such as C:\Users) stay.
	s = s.replace(/\\([A-Za-z]+)(?![A-Za-z])/g, (m, name: string) => {
		const u = COMMANDS[name];
		if (u === undefined || u === "") return m;
		converted++;
		return u;
	});
	// HTML entities: named, decimal and hexadecimal.
	s = s.replace(/&(#\d{2,7}|#x[0-9A-Fa-f]{2,6}|[A-Za-z]{2,8});/g, (m, e: string) => {
		const code = e.startsWith("#x") ? Number.parseInt(e.slice(2), 16) : e.startsWith("#") ? Number(e.slice(1)) : NaN;
		const u = Number.isNaN(code)
			? ENTITIES[e]
			: code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: undefined;
		if (u === undefined) return m;
		converted++;
		return u;
	});
	// Markdown escapes of characters that are not formatting in the export (\_ \# \~ \| \> \. \+ \- \! \[ \] \( \)).
	s = s.replace(/\\([_#~|>.+\-![\]()])/g, (_m, c: string) => {
		converted++;
		return c;
	});
	// Kept spans back.
	const text = s.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"), (_m, i: string) => kept[Number(i)]);
	return { text, converted, unknown };
}
