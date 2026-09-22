/**
 * Design system.
 *
 * ===========================================================================
 * THE DESIGN THESIS — "a lit room, and the one number that matters"
 * ===========================================================================
 *
 * The visual language comes from the sibling product (steve-vpn-web) so the two
 * read as one family: a deep blue-black ground lit by an aurora, frosted glass
 * for anything a customer looks at, and a single blue accent ramp carrying every
 * interactive affordance.
 *
 * TWO MATERIALS, AND THEY ARE NOT INTERCHANGEABLE.
 *
 *   Public surfaces — landing, docs, sign-in, and the payment page — are FROSTED
 *   GLASS: translucent white fills over the aurora, 20-24px radii, a soft lift and
 *   a blue glow on hover. That reads well on a page someone is being persuaded by.
 *
 *   The operator consoles are MATTE PLATES on a darker chassis: opaque, flat,
 *   14px radii, cool slate hairlines, blur switched off. That reads well for a
 *   merchant auditing a ledger and badly as a landing page. Scoping the console
 *   material under `.adm-root` is what keeps the two from leaking into each other;
 *   a panel in the console and a panel on the landing page are the same markup.
 *
 * ONE ACCENT, AND MONEY IS THE ONLY OTHER COLOUR. The ramp is a single blue
 * (300/400/500/600/700) and it does every job that is not "this is a sum of money".
 * `owed` is money the customer still owes and time still running; `settled` is money
 * that arrived and is confirmed; `failed` is money that did not arrive or was
 * refused. So a colour on screen always answers the question a merchant is actually
 * asking, and nothing is tinted for decoration.
 *
 * TYPE. Vazirmatn carries Persian at 400/500/700. Estedad 800/900 is the display
 * face — used on headings, the brand, and the amount on the payment card, and
 * nowhere else, so it stays a signal rather than a texture. IBM Plex Mono carries
 * the machine register: identifiers, keys, code, and wide-tracked eyebrows. Persian
 * labels are never tracked: it is a connected script, and letter-spacing visibly
 * tears a word apart.
 *
 * TWO STYLESHEETS, SPLIT BY WEIGHT. The payment page is opened on a phone, often on
 * a bad connection, by someone who needs exactly one number to be legible. It must
 * not pay for console chrome: `PAY_CSS` is standalone and small and gets the static
 * half of the aurora drawn by body pseudo-elements, with no extra DOM and no
 * animation. `APP_CSS` adds the drifting aurora, the shells, the consoles and the
 * docs on top of it.
 */

export const TOKENS = {
  // --- ground: the room, and the layers that sit in it -----------------------
  /** Page base. Deepest layer, and visibly blue rather than black. */
  void: '#05070D',
  /** Chassis: the console frame, one step up from the ground. */
  strata: '#080D18',
  /** Plates: the workhorse console surface. */
  strata2: '#0B101D',
  /** Raised: inputs, code blocks, recessed wells. */
  strata3: '#131B2E',
  /** Every hairline. A seam, not a line. */
  seam: 'rgba(148,163,184,.16)',
  seamSoft: 'rgba(148,163,184,.09)',

  // --- type ------------------------------------------------------------------
  /** Primary text. Cool white with a blue cast, never pure #fff. */
  ice: '#EDF3FF',
  /** Secondary: labels, supporting copy. */
  steel: 'rgba(226,232,240,.66)',
  /** Tertiary: metadata, timestamps, hints. */
  haze: 'rgba(226,232,240,.42)',

  // --- the accent ramp -------------------------------------------------------
  /** Interactive register: links, focus, primary action. */
  signal: '#2F7DFF',
  signalDim: '#1A5FF0',
  /** Emphasis and link text — accent-300 in the ramp. */
  beam: '#8EC2FF',
  /** The lighter step used for data in motion: traces, sparklines, the plate sweep. */
  arc: '#5AA3FF',

  // --- money, and only money -------------------------------------------------
  /** Money owed, time running out. */
  owed: '#FBBF24',
  /** Money arrived and confirmed. */
  settled: '#34D399',
  /** Money failed, refused, or disputed. */
  failed: '#FB7185',
} as const;

/**
 * Font stacks. All three faces are self-hosted; see scripts/sync-fonts.mjs.
 *
 * No web font is fetched from a third party. A payment page that calls out to a
 * font CDN leaks its visitors to that CDN and fails closed on a filtered network,
 * which in this market is not a hypothetical.
 */
export const FONT_STACK = {
  ui: "'Vazirmatn', system-ui, -apple-system, 'Segoe UI', sans-serif",
  /** Headings and the amount. 800/900 only. */
  display: "'Estedad', 'Vazirmatn', system-ui, sans-serif",
  code: "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
} as const;

const ARABIC_RANGE = 'U+0600-06FF,U+0750-077F,U+FB50-FDFF,U+FE70-FEFF,U+200C-200D';
const LATIN_RANGE = 'U+0000-00FF,U+0131,U+0152-0153,U+2000-206F';

/**
 * Payment page faces: two Persian weights, the display face, and one mono.
 *
 * The payment page declares exactly the faces it uses. Regular and bold cover the
 * body; Estedad 900 carries the merchant name and the amount, which are the two
 * things the customer reads; Plex Mono 400 is there for the Latin-digit strings that
 * have to survive being read carefully — the invoice id and the bank card number.
 * Nothing else ships, and the page downloads no Latin text face at all.
 */
const FONT_FACES_PAY = `
@font-face{font-family:'Vazirmatn';src:url('/fonts/vazirmatn-arabic-400.woff2')format('woff2');
font-weight:400;font-display:swap;unicode-range:${ARABIC_RANGE}}
@font-face{font-family:'Vazirmatn';src:url('/fonts/vazirmatn-arabic-700.woff2')format('woff2');
font-weight:700;font-display:swap;unicode-range:${ARABIC_RANGE}}
@font-face{font-family:'Estedad';src:url('/fonts/estedad-arabic-900.woff2')format('woff2');
font-weight:900;font-display:swap;unicode-range:${ARABIC_RANGE}}
@font-face{font-family:'IBM Plex Mono';src:url('/fonts/plex-mono-400.woff2')format('woff2');
font-weight:400;font-display:swap}
`;

/** Dashboard, docs and landing: the 500 weight, the display 800, Latin coverage and mono 500. */
const FONT_FACES_APP = `
@font-face{font-family:'Vazirmatn';src:url('/fonts/vazirmatn-arabic-500.woff2')format('woff2');
font-weight:500;font-display:swap;unicode-range:${ARABIC_RANGE}}
@font-face{font-family:'Vazirmatn';src:url('/fonts/vazirmatn-latin-400.woff2')format('woff2');
font-weight:400;font-display:swap;unicode-range:${LATIN_RANGE}}
@font-face{font-family:'Vazirmatn';src:url('/fonts/vazirmatn-latin-700.woff2')format('woff2');
font-weight:700;font-display:swap;unicode-range:${LATIN_RANGE}}
@font-face{font-family:'Estedad';src:url('/fonts/estedad-arabic-800.woff2')format('woff2');
font-weight:800;font-display:swap;unicode-range:${ARABIC_RANGE}}
@font-face{font-family:'IBM Plex Mono';src:url('/fonts/plex-mono-500.woff2')format('woff2');
font-weight:500;font-display:swap}
`;

/**
 * Token variables.
 *
 * Two blocks on purpose. The first is this system's vocabulary. The second maps the
 * previous system's names onto it, because the admin console and payment page set
 * colours inline (`style="color:var(--amber)"`) in a few hundred places and those
 * references should keep working — a token rename should not require touching a
 * thousand lines of markup, and an alias is cheaper and far less risky than a sweep.
 *
 * The material block is the part that matters most. `--glass-*` is the public
 * recipe and `--adm-*` is the console recipe, and both are declared here rather than
 * inline so a panel in the console and a panel on the landing page can share one
 * markup shape while reading as two different materials.
 */
const TOKEN_VARS = `
:root{
--void:${TOKENS.void};--strata:${TOKENS.strata};--strata-2:${TOKENS.strata2};--strata-3:${TOKENS.strata3};
--seam:${TOKENS.seam};--seam-soft:${TOKENS.seamSoft};
--ice:${TOKENS.ice};--steel:${TOKENS.steel};--haze:${TOKENS.haze};
--signal:${TOKENS.signal};--signal-dim:${TOKENS.signalDim};--beam:${TOKENS.beam};--arc:${TOKENS.arc};
--owed:${TOKENS.owed};--settled:${TOKENS.settled};--failed:${TOKENS.failed};

/* legacy aliases — same values, previous names */
--ink:var(--void);--ink-raised:var(--strata);--basalt:var(--strata-2);--basalt-strong:var(--strata-3);
--hairline:var(--seam);--hairline-soft:var(--seam-soft);
--glacier:var(--ice);--muted:var(--steel);--faint:var(--haze);
--signal-deep:var(--signal-dim);--amber:var(--owed);--settle:var(--settled);--reject:var(--failed);

/* radius ladder: glass surfaces are generous, controls are not */
--radius:20px;--radius-lg:24px;--radius-sm:12px;--radius-xs:10px;
--mono:${FONT_STACK.code};--display:${FONT_STACK.display};

/* --- public material: frosted glass over the aurora ---------------------- */
--glass-bg:rgba(255,255,255,.07);--glass-bg-2:rgba(255,255,255,.10);
--glass-well:rgba(255,255,255,.05);
--glass-line:rgba(255,255,255,.10);--glass-line-2:rgba(255,255,255,.16);
--glass-blur:blur(20px);
--glass-lift:0 8px 32px rgba(0,0,0,.35);
--glass-hi:inset 0 1px 0 rgba(255,255,255,.08);
--signal-glow:0 0 40px rgba(47,125,255,.35);

/* --- console material: matte plates on a chassis ------------------------- */
--adm-ground:${TOKENS.void};--adm-chassis:${TOKENS.strata};--adm-plate:${TOKENS.strata2};
--adm-plate-hover:#101728;--adm-well:rgba(148,163,184,.05);
--adm-line:${TOKENS.seam};--adm-line-soft:${TOKENS.seamSoft};--adm-line-strong:rgba(148,163,184,.28);
--adm-lift:0 18px 34px -26px rgba(2,4,12,.95);
}
`;

const RESET = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;color:var(--ice);font-family:${FONT_STACK.ui};line-height:1.85;font-weight:400;
-webkit-font-smoothing:antialiased;font-feature-settings:'ss01' 1;background-color:var(--void)}
/*
 * The lit room, drawn with two pseudo-elements rather than extra DOM.
 *
 * A fixed radial ground puts a real blue at the top-inline corner and falls to the
 * void, and a single blurred bloom sits over it. Both are static: the payment page
 * renders on phones that cannot afford an animated backdrop-filter, and a still
 * gradient with one blurred layer is free. APP_CSS adds the drifting aurora layer
 * on top for the surfaces that are being looked at rather than paid on.
 */
body::before{content:'';position:fixed;inset:0;z-index:-2;pointer-events:none;
background:radial-gradient(circle at 20% 20%,#0B1530 0%,var(--void) 62%)}
body::after{content:'';position:fixed;z-index:-1;pointer-events:none;top:-16rem;
inset-inline-start:-10rem;width:38rem;height:38rem;border-radius:50%;
background:radial-gradient(circle,rgba(47,125,255,.30),transparent 68%);filter:blur(70px)}
img,svg{max-width:100%;display:block}
button,input,select,textarea{font:inherit;color:inherit}
a{color:var(--beam);text-decoration:none}
a:hover{color:var(--ice);text-decoration:underline;text-underline-offset:3px}
/* One focus ring, drawn twice so it stays visible on glass and on plates alike. */
:focus-visible{outline:none;box-shadow:0 0 0 2px var(--void),0 0 0 4px var(--arc);border-radius:10px}
::selection{background:rgba(47,125,255,.35)}
/* Figures must never reflow as they change. */
.num{font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1}
/*
 * The machine register, and it is LTR by construction.
 *
 * Everything carrying .mono is an identifier — an invoice id, a masked card number, an
 * API-key hint, a URL, an IP. Inside an RTL paragraph the bidi algorithm treats the
 * asterisks and dashes in those strings as neutral characters and reorders them, so a
 * masked card number was painted with its last four digits first. A wrong number on a screen
 * about money. Declaring the direction here fixes the whole class at once, rather than
 * relying on every call site to remember a dir attribute.
 */
.mono{font-family:${FONT_STACK.code};font-variant-ligatures:none;direction:ltr;unicode-bidi:isolate}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
clip:rect(0,0,0,0);white-space:nowrap;border:0}
/* Scrollbars, because a default light scrollbar on this surface is a visible seam. */
*{scrollbar-color:#22315E transparent;scrollbar-width:thin}
*::-webkit-scrollbar{width:9px;height:9px}
*::-webkit-scrollbar-thumb{background:#22315E;border-radius:99px;border:2px solid transparent;background-clip:content-box}
*::-webkit-scrollbar-track{background:transparent}
`;

/**
 * Typography roles.
 *
 * `.display` is the one heading voice: Estedad at 800/900 with tightened tracking.
 * It is deliberately not applied to body copy, to labels, or to anything numeric that
 * changes — a display face on a figure makes the figure slower to read.
 *
 * `.eyebrow` is the section label. It is set in the UI face, tracked wide, in the
 * accent's light step, and it carries no letter-spacing on the Persian it sits above:
 * Persian is a connected script and tracking tears a word apart ("پ ر د ا خ ت"). Latin
 * labels keep their tracking; Persian labels are set as Persian is written.
 */
const TYPE = `
.display{font-family:${FONT_STACK.display};font-weight:800;letter-spacing:-.02em;line-height:1.35}
.eyebrow{font-size:.68rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
color:var(--beam);opacity:.82;margin:0 0 .6rem;display:block}
.eyebrow em{font-style:normal;color:var(--ice);opacity:1}
/* Latin-only tracking. Used where a label mixes scripts: the Latin half keeps the wide,
   tracked instrument look and the Persian half is left as written. */
.tracked{font-family:${FONT_STACK.code};letter-spacing:.14em;text-transform:uppercase;font-size:.68rem}
`;

/** Motion shared by every surface. Everything here is gated off by reduced-motion. */
const MOTION = `
@keyframes sweep{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}
@keyframes trace{0%{background-position:0% 50%}100%{background-position:200% 50%}}
@keyframes glow{0%,100%{opacity:.45}50%{opacity:1}}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes pulse{50%{opacity:.5}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes drift{0%,100%{transform:translate(0,0) scale(1)}
33%{transform:translate(30px,-40px) scale(1.1)}66%{transform:translate(-20px,20px) scale(.95)}}
.trace{height:1px;background:var(--seam-soft);position:relative;overflow:hidden}
.trace::after{content:'';position:absolute;inset:0;width:38%;
background:linear-gradient(90deg,transparent,var(--arc),var(--beam),transparent);
animation:sweep 4s cubic-bezier(.4,0,.6,1) infinite}
.trace-live{height:2px;border-radius:2px;background:linear-gradient(90deg,transparent,var(--signal),var(--arc),var(--signal),transparent);
background-size:200% 100%;animation:trace 3.2s linear infinite}
.reveal{opacity:0}
.reveal[data-shown='1']{animation:rise .55s cubic-bezier(.2,.7,.3,1) forwards}
/* The drifting aurora. Emitted only by the surfaces that are read rather than paid on. */
.bg-aurora{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none;contain:strict}
.bg-aurora i{position:absolute;border-radius:50%;filter:blur(90px);opacity:.4;
will-change:transform;animation:drift 12s ease-in-out infinite}
.bg-aurora i:nth-child(1){width:26rem;height:26rem;top:-6rem;inset-inline-end:-6rem;
background:var(--signal-dim)}
.bg-aurora i:nth-child(2){width:22rem;height:22rem;bottom:-7rem;inset-inline-start:-5rem;
background:var(--signal);animation-delay:-4s}
@media (prefers-reduced-motion:reduce){
*,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;
transition-duration:.001ms!important;scroll-behavior:auto!important}
.reveal{opacity:1}
}
`;

/**
 * Payment page stylesheet.
 *
 * Ordered so specificity never fights itself: tokens, then base, then components in
 * descending order of importance to the customer. The amount plate is the one
 * memorable element, written first among the components and given the most care.
 */
export const PAY_CSS = `${TOKEN_VARS}${FONT_FACES_PAY}${RESET}${TYPE}${MOTION}
/* --- page frame --------------------------------------------------------- */
.pay-wrap{min-height:100dvh;display:flex;flex-direction:column;align-items:center;
justify-content:center;padding:1.5rem 1rem 2.5rem;gap:.875rem;position:relative}
/*
 * The glass card, and the top edge is the one element of Steve Gate's own language
 * that survives the re-skin: a 2px line in the payment's state colour, lit by a
 * travelling highlight. That is decoration carrying information — the colour of the
 * card's edge is the state of the payment — which is why it earns its place above the
 * frosted surface rather than being one more gradient.
 */
.pay-card{width:100%;max-width:27rem;border-radius:var(--radius-lg);padding:1.5rem 1.25rem 1.375rem;
position:relative;overflow:hidden;
background:var(--glass-bg);border:1px solid var(--glass-line);
-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);
box-shadow:var(--glass-hi),var(--glass-lift),0 0 70px -34px rgba(47,125,255,.6)}
.pay-card::before{content:'';position:absolute;inset:0 0 auto 0;height:2px;
background:linear-gradient(90deg,transparent,var(--state,var(--signal)) 22%,var(--state,var(--signal)) 78%,transparent)}
.pay-card::after{content:'';position:absolute;top:0;left:0;width:30%;height:2px;
background:linear-gradient(90deg,transparent,var(--beam),transparent);animation:sweep 3.6s linear infinite}
/*
 * Glass falls apart without backdrop-filter. Browsers and in-app WebViews that do not
 * composite it leave a 7%-white fill over a dark ground, so the card and the page behind
 * it are the same colour and the card stops being a card. Detect that case and fall back
 * to a solid surface, which is less pretty and always legible.
 */
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
.pay-card,.panel,.stat,.code,.steps,.facts,.docs-note,.key-reveal,.slip,
.pay-note,.setup-step,.msg,.site-nav-inner,.forge,.docs-nav,
input.input,select.input,textarea.input{
background-color:rgba(10,15,28,.94)}
.btn{background-color:rgba(255,255,255,.06)}
}

.pay-head{display:flex;align-items:center;gap:.75rem;padding-bottom:1rem;border-bottom:1px solid var(--glass-line)}
.pay-logo{width:2.75rem;height:2.75rem;border-radius:16px;flex:none;overflow:hidden;
display:grid;place-items:center;font-family:var(--display);font-weight:900;font-size:1.05rem;color:var(--beam);
background:rgba(47,125,255,.16);border:1px solid rgba(90,163,255,.34)}
.pay-logo img{width:100%;height:100%;object-fit:cover}
.pay-merchant{font-family:var(--display);font-weight:900;font-size:1.05rem;line-height:1.5;letter-spacing:-.015em}
.pay-meta{color:var(--haze);font-size:.72rem;line-height:1.7;margin-top:.1rem}
.pay-desc{margin:1.125rem 0 0;font-size:.93rem;color:var(--ice);word-break:break-word;line-height:1.95}
.pay-label{font-size:.75rem;color:var(--haze);margin:0 0 .45rem;display:block}

/* A recessed well, for the one-line detail blocks on the error pages. */
.plate{margin-top:1.25rem;padding:1rem 1.125rem;border-radius:var(--radius);
background:var(--glass-well);border:1px solid var(--glass-line-2)}

/* =========================================================================
   THE AMOUNT — two copy targets, and the words underneath
   ========================================================================= */
/*
 * The exact figure is the thing a human verifies digit by digit, so the WHOLE CARD is the
 * copy target rather than a small button beside it: the thing to tap is the thing being
 * read, and a customer who has just copied a number should not also have to hit a 60px
 * chip. Toman leads and Rial follows on a quieter surface, because the Rial figure is a
 * conversion aid for someone whose bank app only speaks Rial, not a second amount of equal
 * standing (§74).
 *
 * The words underneath are a second rendering of the same integer. Both realistic mistakes
 * on this page are digit mistakes — dropping a zero, or reading ۳۲۴٬۵۵۵ as ۳۲۴٬۵۵۰ — and
 * reading the number back in Persian is what catches them.
 */
.amount-card{display:block;width:100%;text-align:start;position:relative;overflow:hidden;
margin-top:.625rem;padding:1rem 1.125rem;border-radius:var(--radius);cursor:pointer;
background:linear-gradient(to left,rgba(47,125,255,.16),rgba(47,125,255,.04));
border:1px solid rgba(90,163,255,.4);color:var(--ice);
transition:transform .3s cubic-bezier(.4,0,.2,1),border-color .3s ease,box-shadow .3s ease}
.amount-card:hover{transform:translateY(-2px);border-color:rgba(90,163,255,.62);
box-shadow:0 14px 30px -18px rgba(47,125,255,.9)}
.amount-card[data-copied='1']{border-color:rgba(52,211,153,.6)}
.amount-card-sub{background:var(--glass-well);border-color:var(--glass-line)}
.amount-card-sub:hover{border-color:var(--glass-line-2);box-shadow:none}
.amount-card-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem}
.amount-card-label{font-size:.71rem;font-weight:700;color:var(--beam)}
.amount-card-sub .amount-card-label{color:var(--haze)}
/* No direction override here. Persian digits and the Arabic thousands separator (U+066C)
   both carry a bidi class that renders them correctly inside an RTL line, so the pair
   packs to the reading start of the card and still reads as "amount then unit". */
.amount-card-value{display:flex;align-items:baseline;gap:.4rem;margin-top:.4rem;flex-wrap:wrap}
.amount-card-value b{font-family:var(--display);font-size:2rem;font-weight:900;line-height:1.15;
letter-spacing:-.025em;font-variant-numeric:tabular-nums;color:#fff}
.amount-card-value span{font-size:.78rem;font-weight:700;color:var(--beam)}
.amount-card-sub .amount-card-value b{font-size:1.45rem;color:rgba(226,232,240,.9)}
.amount-card-sub .amount-card-value span{color:var(--haze)}
.amount-words{margin:.7rem 0 0;padding-top:.6rem;border-top:1px solid var(--glass-line);
font-size:.76rem;line-height:1.9;color:var(--steel)}
.copy-pill{display:inline-flex;align-items:center;flex:none;padding:.3rem .7rem;
border-radius:999px;border:1px solid var(--glass-line-2);background:var(--glass-well);
font-size:.7rem;font-weight:700;color:var(--steel);transition:all .3s ease}
.amount-card[data-copied='1'] .copy-pill{border-color:rgba(52,211,153,.5);
background:rgba(52,211,153,.15);color:var(--settled)}
.amount-warn{display:flex;gap:.5rem;align-items:flex-start;margin:.875rem 0 0;
padding:.7rem .875rem;border-radius:var(--radius-sm);font-size:.74rem;line-height:1.85;
background:rgba(251,191,36,.07);border:1px solid rgba(251,191,36,.22);color:#FDE68A}
.amount-warn b{font-weight:700;color:#FEF3C7}

/* --- the receiving card, drawn as the bank draws it --------------------- */
/*
 * The palette arrives in three custom properties — bc-grad, bc-brand and bc-muted — set by
 * the issuer lookup in src/core/banks.ts. Everything here is layout and material: the
 * proportion of a real card, the light falling across it, and the plastic mark. Which
 * colours those are is a fact about the bank, and this file knows none of them.
 *
 * (No backticks in these comments: this is a template literal, and one would end the CSS.)
 *
 * 1.586 is the ISO/IEC 7810 ID-1 ratio — the shape a card actually is. Getting it right is
 * most of why the result reads as a card rather than as a panel with a gradient on it.
 */
.bankcard{position:relative;display:block;width:100%;overflow:hidden;text-align:start;
border:1px solid rgba(255,255,255,.16);border-radius:var(--radius);
background:var(--bc-grad,var(--glass-well));color:#fff;isolation:isolate;
aspect-ratio:1.586;box-shadow:0 10px 28px -14px rgba(0,0,0,.55)}
.bankcard-sm{min-height:130px;aspect-ratio:auto}
/* Two soft lights: a highlight from the top-right corner and a shadow pooling bottom-left,
   which is what makes a flat gradient read as a surface with a direction. */
.bankcard-sheen{position:absolute;inset:0;pointer-events:none;z-index:0;
background:radial-gradient(120% 90% at 85% -10%,rgba(255,255,255,.28) 0%,rgba(255,255,255,0) 55%),
radial-gradient(90% 70% at 10% 110%,rgba(0,0,0,.26) 0%,rgba(0,0,0,0) 60%)}
/* The lit top edge. One hairline, and it is the single detail that most makes the card look
   like an object rather than a rectangle. */
.bankcard-light{position:absolute;inset-inline:0;top:0;height:1px;pointer-events:none;z-index:1;
background:linear-gradient(90deg,transparent,rgba(255,255,255,.5),transparent)}
.bankcard-body{position:relative;z-index:2;display:flex;flex-direction:column;justify-content:space-between;
height:100%;min-height:inherit;padding:1rem 1.125rem;gap:.6rem}
.bankcard-sm .bankcard-body{padding:.8rem .9rem}
.bankcard-top{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.bankcard-bank{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
font-weight:800;font-size:.86rem;color:var(--bc-brand,#e2e8f0);
text-shadow:0 1px 3px rgba(0,0,0,.35)}
.bankcard-sm .bankcard-bank{font-size:.76rem}
/* The chip. Two stacked gradients rather than an image: it is 34×24 pixels of a contact
   plate, not a photograph. */
.bankcard-chip{flex:none;width:2.6rem;height:1.8rem;border-radius:.35rem;
background:linear-gradient(135deg,rgba(255,255,255,.55),rgba(255,255,255,.2) 45%,rgba(255,255,255,.38));
border:1px solid rgba(255,255,255,.45);box-shadow:inset 0 0 0 1px rgba(0,0,0,.06)}
.bankcard-sm .bankcard-chip{width:2rem;height:1.4rem}
.bankcard-mid{display:flex;flex-direction:column;align-items:center;gap:.4rem;text-align:center}
.bankcard-title{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
align-self:center;padding:.15rem .6rem;border-radius:999px;font-size:.66rem;font-weight:700;
color:var(--bc-brand,#e2e8f0);background:rgba(0,0,0,.2);border:1px solid rgba(255,255,255,.18)}
/* Grouped four at a time, in the order the card is printed, with the groups held in a row
   so a masked number keeps the same shape as a full one. */
.bankcard-digits{font-family:${FONT_STACK.code};font-size:1.06rem;font-weight:600;letter-spacing:.16em;
direction:ltr;font-variant-numeric:tabular-nums;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.4);
white-space:nowrap}
.bankcard-digits[data-partial='1']{color:rgba(255,255,255,.62)}
.bankcard-sm .bankcard-digits{font-size:.92rem;letter-spacing:.12em}
.bankcard-holder{font-size:.68rem;color:var(--bc-muted,rgba(255,255,255,.6))}
.bankcard-foot{display:flex;align-items:center;justify-content:space-between;gap:.5rem;min-height:1.6rem}
.bankcard-mark{display:inline-flex;align-items:center;gap:.3rem;flex:none;
color:var(--bc-muted,rgba(255,255,255,.6));font-size:.55rem;font-weight:700;letter-spacing:.14em}
/* Only the interactive variant lifts. A card in a list is content, and moving it under the
   cursor promises something a click there does not do. */
.bankcard-tap{cursor:pointer;font:inherit;color:#fff;
transition:transform .3s cubic-bezier(.4,0,.2,1),box-shadow .3s ease,border-color .3s ease}
.bankcard-tap:hover{transform:translateY(-2px);box-shadow:0 18px 34px -18px rgba(0,0,0,.7)}
.bankcard-tap:focus-visible{outline:2px solid var(--arc);outline-offset:3px}
.bankcard-tap[data-copied='1']{border-color:rgba(52,211,153,.7)}
/* Inside a card the copy pill cannot use the page's glass fill: it would sit as a grey block
   on top of the bank's colours. */
.bankcard .copy-pill{border-color:rgba(255,255,255,.28);background:rgba(0,0,0,.22);color:#fff;
font-size:.64rem;padding:.22rem .6rem}
.bankcard[data-copied='1'] .copy-pill{border-color:rgba(52,211,153,.7);background:rgba(52,211,153,.2)}
/* The compact mark, for list rows where a full face would dominate the row. */
.bankchip{display:inline-flex;align-items:center;justify-content:center;flex:none;
width:2rem;height:1.25rem;margin-inline-end:.45rem;border-radius:.3rem;vertical-align:middle;
background:var(--bc-grad,var(--glass-well));border:1px solid rgba(255,255,255,.22);
box-shadow:0 2px 6px -2px rgba(0,0,0,.5)}
.bankchip b{font-size:.5rem;font-weight:800;line-height:1;color:var(--bc-brand,#e2e8f0)}

/* --- controls ----------------------------------------------------------- */
/*
 * One button shell, three weights. Depth comes from a layered gradient and an inset light
 * edge rather than a bigger glow, and a diagonal sheen sweeps across on hover. Only
 * transform and opacity animate, so none of it triggers layout.
 */
.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:.45rem;
cursor:pointer;overflow:hidden;white-space:nowrap;
border-radius:var(--radius-sm);padding:.5rem .85rem;font-size:.78rem;font-weight:600;
border:1px solid var(--glass-line);background:var(--glass-bg);color:var(--ice);
-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
transition:background .3s ease,border-color .3s ease,box-shadow .3s ease,transform .3s cubic-bezier(.4,0,.2,1)}
.btn:hover{background:var(--glass-bg-2);border-color:rgba(90,163,255,.5);color:var(--ice);text-decoration:none}
.btn:active{transform:scale(.97)}
.btn:disabled{opacity:.55;cursor:not-allowed;transform:none}
.btn:disabled::after{display:none}
.btn[data-copied='1']{border-color:rgba(52,211,153,.6);color:var(--settled);
box-shadow:0 0 0 3px rgba(52,211,153,.12)}
.btn-primary{color:#fff;font-weight:700;border-color:rgba(255,255,255,.10);
background-image:linear-gradient(160deg,#4B90FF 0%,var(--signal) 45%,var(--signal-dim) 100%);
box-shadow:inset 0 1px 0 rgba(255,255,255,.22),
0 10px 26px -12px rgba(47,125,255,.65),0 0 34px -8px rgba(47,125,255,.4)}
.btn-primary:hover{background-image:linear-gradient(160deg,#5AA3FF 0%,#3B86FF 45%,#2470FF 100%);
box-shadow:inset 0 1px 0 rgba(255,255,255,.28),
0 14px 32px -12px rgba(47,125,255,.8),0 0 44px -6px rgba(47,125,255,.55)}
/* The sheen. pointer-events:none keeps it out of hit-testing entirely. */
.btn-primary::after,.btn:not(.btn-primary)::after{content:'';position:absolute;inset-block:0;
inset-inline-start:-60%;width:45%;transform:skewX(18deg);opacity:0;pointer-events:none;
background:linear-gradient(90deg,transparent,rgba(255,255,255,.16),transparent);
transition:inset-inline-start .6s ease,opacity .35s ease}
.btn:hover::after{inset-inline-start:115%;opacity:1}
.btn-block{width:100%;padding:.8rem 1rem;font-size:.9rem;margin-top:1.25rem}

/* =========================================================================
   THE PAYMENT PAGE
   ========================================================================= */
/*
 * A wider arrangement than the centred card, and deliberately so. This page answers three
 * questions in order — where do I send it, how much, and how long have I got — and stacking
 * them in one narrow column on a phone is what makes the customer scroll past the number
 * they are supposed to be checking. The header states the outcome, the step bar states how
 * far the payment has actually got, and the numbered sections are the instructions in the
 * order they are performed.
 */
.pay-bg{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.pay-bg::before{content:'';position:absolute;inset:0;
background-image:linear-gradient(rgba(142,194,255,.06) 1px,transparent 1px),
linear-gradient(90deg,rgba(142,194,255,.06) 1px,transparent 1px);
background-size:46px 46px;
-webkit-mask-image:radial-gradient(ellipse at 50% 0%,#000,transparent 74%);
mask-image:radial-gradient(ellipse at 50% 0%,#000,transparent 74%)}
.pay-shell{position:relative;max-width:62rem;margin:0 auto;padding:1.5rem 1rem 3rem}
.pay-top{display:flex;align-items:center;justify-content:space-between;gap:1rem;
flex-wrap:wrap;margin-bottom:1.25rem}
.pay-brandmark{display:flex;align-items:center;gap:.75rem;min-width:0}
.pay-brandmark b{display:block;font-family:var(--display);font-weight:900;font-size:1.05rem;
letter-spacing:-.015em;line-height:1.4}
.pay-brandmark span{display:block;font-size:.72rem;color:var(--haze);line-height:1.5}
/* The status pill: the page's headline answer, and the only place a payment's colour
   appears at the top of the screen. The dot pulses only while the page is still waiting. */
.pay-statepill{display:inline-flex;align-items:center;gap:.45rem;flex:none;
padding:.4rem .85rem;border-radius:999px;font-size:.74rem;font-weight:700;
color:var(--state-ink,var(--beam));
border:1px solid color-mix(in srgb,var(--state,var(--signal)) 34%,transparent);
background:color-mix(in srgb,var(--state,var(--signal)) 12%,transparent)}
.pay-statepill i{width:.42rem;height:.42rem;border-radius:50%;flex:none;
background:var(--state,var(--signal));box-shadow:0 0 10px var(--state,var(--signal))}
.pay-statepill[data-live='1'] i{animation:glow 1.6s ease-in-out infinite}
/*
 * The step bar. Structure as information: a step is lit only when the fact behind it exists
 * in the database. It cannot claim progress that has not happened, which is the one thing a
 * progress indicator on a payment page must never do.
 */
/*
 * A vertical list, not three columns. Three equal columns on a phone give a Persian step
 * title about 6rem to wrap in, which is two lines of two words — and the hint under it
 * either wraps to three more or has to be dropped. Stacked, each step keeps its title and
 * its hint on one line each at any width, which is the whole reason the hint is there.
 */
.pay-steps{list-style:none;margin:0 0 1.25rem;padding:.375rem;display:grid;gap:.125rem;
border-radius:var(--radius);background:var(--glass-bg);border:1px solid var(--glass-line);
-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur)}
.pay-step{display:flex;align-items:center;gap:.6rem;padding:.55rem .7rem;border-radius:12px;
min-width:0;transition:background .3s ease}
.pay-step[data-state='active']{background:rgba(255,255,255,.06)}
.pay-step-num{width:1.75rem;height:1.75rem;flex:none;display:grid;place-items:center;
border-radius:10px;border:1px solid var(--glass-line);background:var(--glass-well);
font-size:.75rem;font-weight:900;color:var(--haze)}
.pay-step[data-state='done'] .pay-step-num{border-color:rgba(52,211,153,.4);
background:rgba(52,211,153,.15);color:var(--settled)}
.pay-step[data-state='active'] .pay-step-num{border-color:rgba(90,163,255,.45);
background:rgba(47,125,255,.16);color:var(--beam)}
.pay-step-text{min-width:0}
.pay-step-text b{display:block;font-size:.78rem;font-weight:700;color:rgba(226,232,240,.85);
line-height:1.5}
.pay-step-text span{display:block;font-size:.68rem;color:var(--haze);line-height:1.5}
/* Two columns on a wide screen: the instructions, and what is behind them. Nothing is
   repeated between the two columns. */
.pay-grid{display:grid;gap:1.25rem;grid-template-columns:minmax(0,1fr)}
.pay-main{border-radius:var(--radius-lg);padding:1.35rem;display:grid;gap:1.1rem;min-width:0;
background:var(--glass-bg);border:1px solid var(--glass-line);
-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);
box-shadow:var(--glass-hi),var(--glass-lift)}
.pay-side{display:grid;gap:1rem;align-content:start;min-width:0}
.pay-side-card{border-radius:var(--radius);padding:1rem 1.1rem;
background:var(--glass-well);border:1px solid var(--glass-line)}
.pay-side-card h2{margin:0 0 .7rem;font-size:.8rem;font-weight:700;color:rgba(226,232,240,.85)}
.pay-sec{min-width:0}
.pay-sec-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;
flex-wrap:wrap;margin-bottom:.2rem}
.pay-sec-head h2{display:flex;align-items:center;gap:.5rem;margin:0;
font-size:.86rem;font-weight:700;color:rgba(226,232,240,.85)}
.pay-num{width:1.5rem;height:1.5rem;flex:none;display:grid;place-items:center;
border-radius:9px;border:1px solid rgba(90,163,255,.28);background:rgba(47,125,255,.12);
font-size:.7rem;font-weight:900;color:var(--beam)}
.pay-sec-hint{font-size:.7rem;color:var(--haze)}
/* A rule that fades at both ends: it separates two steps without reading as a table border. */
.pay-divider{height:1px;border:0;margin:0;
background:linear-gradient(to right,transparent,var(--glass-line-2),transparent)}

/* --- the deadline: owed money, finite time ------------------------------ */
/* The bar is the deadline. A number reads as information; a bar that is nearly gone reads
   as a reason to hurry, which is the only thing that changes behaviour at two minutes. */
.timer{border-radius:var(--radius);padding:.9rem 1rem;
background:linear-gradient(90deg,rgba(47,125,255,.10),rgba(52,211,153,.07));
border:1px solid rgba(90,163,255,.24)}
.timer-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem}
.timer-label{display:flex;align-items:center;gap:.45rem;font-size:.76rem;font-weight:700;
color:rgba(226,232,240,.85)}
.timer-label i{width:.42rem;height:.42rem;border-radius:50%;flex:none;background:var(--beam);
animation:glow 2.4s ease-in-out infinite}
.timer-value{font-family:var(--display);font-size:1.35rem;font-weight:900;
font-variant-numeric:tabular-nums;letter-spacing:.02em;color:var(--ice)}
.timer-track{margin-top:.7rem;height:.375rem;border-radius:999px;overflow:hidden;
background:rgba(255,255,255,.10)}
.timer-fill{display:block;height:100%;border-radius:999px;width:100%;
background:linear-gradient(90deg,var(--signal),var(--arc));transition:width 1s linear}
.timer[data-tone='soon']{border-color:rgba(251,191,36,.34);
background:linear-gradient(90deg,rgba(251,191,36,.10),rgba(251,191,36,.04))}
.timer[data-tone='soon'] .timer-value{color:var(--owed)}
.timer[data-tone='soon'] .timer-fill{background:linear-gradient(90deg,#F59E0B,var(--owed))}
.timer[data-tone='urgent']{border-color:rgba(251,113,133,.4);
background:linear-gradient(90deg,rgba(251,113,133,.12),rgba(251,113,133,.04))}
.timer[data-tone='urgent'] .timer-value{color:var(--failed);animation:pulse 1.5s ease-in-out infinite}
.timer[data-tone='urgent'] .timer-fill{background:linear-gradient(90deg,#FB7185,#FDA4AF)}
.timer-msg{margin:.6rem 0 0;font-size:.72rem;font-weight:700;line-height:1.8;text-align:center}
.timer[data-tone='soon'] .timer-msg{color:#FDE68A}
.timer[data-tone='urgent'] .timer-msg{color:#FECDD3}
.timer[data-tone='ok'] .timer-msg,.timer[data-tone='expired'] .timer-msg{display:none}
.pay-live{margin:.9rem 0 0;display:flex;align-items:center;justify-content:center;gap:.45rem;
font-size:.73rem;color:var(--beam)}
.pay-live i{width:.5rem;height:.5rem;border-radius:50%;flex:none;background:var(--arc);
animation:pulse 1.6s ease-in-out infinite}
.pay-actions{display:grid;gap:.6rem;margin-top:1.1rem}
.pay-actions .btn{width:100%;padding:.7rem 1rem;font-size:.82rem}
.btn-danger{color:#FECDD3;border-color:rgba(251,113,133,.3);background:rgba(251,113,133,.06)}
.btn-danger:hover{color:#FFE4E6;border-color:rgba(251,113,133,.5);background:rgba(251,113,133,.14)}
/* The guide is three sentences read in order, so it is numbered — the same device as the
   sections above, for the same reason. */
.pay-guide{list-style:none;margin:0;padding:0;display:grid;gap:.7rem}
.pay-guide li{display:flex;gap:.6rem;align-items:flex-start}
.pay-guide b{width:1.35rem;height:1.35rem;flex:none;display:grid;place-items:center;
border-radius:8px;background:var(--glass-well);border:1px solid var(--glass-line);
font-size:.66rem;font-weight:900;color:var(--beam)}
.pay-guide span{font-size:.75rem;line-height:1.85;color:var(--steel)}
.pay-facts{margin:0;display:grid;gap:.55rem}
.pay-fact{display:flex;justify-content:space-between;gap:.75rem;font-size:.74rem}
.pay-fact dt{color:var(--haze);margin:0}
.pay-fact dd{margin:0;font-weight:500;text-align:left;min-width:0;overflow-wrap:break-word}
.pay-note-sm{margin:0;font-size:.72rem;line-height:1.9;color:var(--haze)}
.pay-note-sm b{color:var(--steel);font-weight:600}
@media (min-width:900px){
.pay-grid{grid-template-columns:minmax(0,1fr) 20rem}
}

/* =========================================================================
   FORMS
   ========================================================================= */
/* These live in the base sheet, not the application one, because the sign-in and sign-up
   pages render on PAY_CSS alone. Two homes for one vocabulary is how a field ends up
   looking like two different fields on two pages of the same product. */
.form{display:grid;gap:1rem;max-width:34rem}
.field{display:grid;gap:.4rem;min-width:0}
/* The group label for a field whose control is not labelable — a third-party widget that
   renders a div cannot be the target of a for attribute, so its label is a span. It is still a label
   and must look like one, which is why this rule and the one above are kept identical. */
.field label,.field-label{display:flex;align-items:center;gap:.4rem;font-size:.77rem;
color:var(--steel);font-weight:500}
.field label svg{flex:none;opacity:.65}
.field .hint{font-size:.71rem;color:var(--haze);line-height:1.85}
.field-error{display:flex;align-items:flex-start;gap:.4rem;font-size:.71rem;font-weight:500;
line-height:1.85;color:#FDA4AF}
.field-error svg{flex:none;margin-top:.25rem}
.input,select.input,textarea.input{width:100%;padding:.7rem .85rem;border-radius:var(--radius-sm);
border:1px solid var(--glass-line);background:var(--glass-well);font-size:.85rem;color:var(--ice);
transition:border-color .18s ease,box-shadow .18s ease,background-color .18s ease}
.input:hover{border-color:var(--glass-line-2)}
.input:focus{border-color:var(--arc);outline:none;background:var(--glass-bg);
box-shadow:0 0 0 3px rgba(47,125,255,.20)}
.input::placeholder{color:rgba(226,232,240,.34)}
textarea.input{min-height:6rem;resize:vertical;line-height:1.9}
/*
 * Native select dropdowns are painted by the OS, not by this stylesheet. Without an explicit
 * color-scheme the open list is drawn with the light widget theme — a white panel — while the
 * text stays light, so every option is invisible until it is hovered.
 */
select.input{color-scheme:dark;appearance:none;
background-image:linear-gradient(45deg,transparent 50%,var(--haze) 50%),
linear-gradient(135deg,var(--haze) 50%,transparent 50%);
background-position:calc(0% + .9rem) 1.15rem,calc(0% + 1.15rem) 1.15rem;
background-size:.25rem .25rem,.25rem .25rem;background-repeat:no-repeat}
select.input option{background-color:#0B101D;color:#F5F7FF}
/*
 * An invalid field has to LOOK invalid.
 *
 * aria-invalid tells assistive technology what happened and tells a sighted customer
 * nothing, so the one field they have to go back and fix used to look exactly like the five
 * they had already filled in correctly. The ring is drawn in the same shape as the focus
 * ring, so "this one is wrong" and "this one is focused" are distinguishable at a glance.
 */
.input[aria-invalid='true']{border-color:rgba(251,113,133,.6);background:rgba(251,113,133,.06);
box-shadow:0 0 0 3px rgba(251,113,133,.14)}
.input[aria-invalid='true']:focus{border-color:var(--failed);
box-shadow:0 0 0 3px rgba(251,113,133,.22)}
/*
 * A field carrying the reveal button.
 *
 * direction:ltr on the WRAPPER, and that is the load-bearing part. The input is LTR (it
 * holds a password or a phone number) while the card around it is RTL, so a logical
 * property on the wrapper and the same property on the input resolve to opposite physical
 * edges — padding-inline-start on the input would reserve space on the left while the
 * button sat on the right. Matching the wrapper's direction to the input's makes both
 * resolve to the same edge, which is where the reveal belongs: at the end of the value.
 */
.input-wrap{position:relative;display:block;direction:ltr}
.input-wrap .input{padding-inline-start:2.75rem}
.pw-toggle{position:absolute;inset-block:0;inset-inline-start:0;width:2.75rem;display:grid;
place-items:center;border:0;background:none;cursor:pointer;color:var(--haze);
border-radius:var(--radius-sm);transition:color .2s ease}
.pw-toggle:hover{color:var(--ice)}
/* One button, two icons, and CSS picks between them off aria-pressed — so what a sighted
   user sees and what a screen reader announces cannot drift apart. */
.pw-eye-off{display:none}
.pw-toggle[aria-pressed='true'] .pw-eye{display:none}
.pw-toggle[aria-pressed='true'] .pw-eye-off{display:block}
/*
 * The error summary is an index, not a second copy of the form.
 *
 * It used to be every message joined by line breaks with no field names, printed above
 * fields that then repeated each message verbatim — so the reader got the same sentences
 * twice and, in the summary, no way to tell which field the third one belonged to. Each
 * line now names its field and links to it, which is the only thing a summary is for.
 */
.error-summary{margin:0 0 1.25rem;padding:.85rem 1rem;border-radius:var(--radius-sm);
background:rgba(251,113,133,.09);border:1px solid rgba(251,113,133,.34)}
.error-summary b{display:flex;align-items:center;gap:.45rem;font-size:.78rem;color:#FDA4AF}
.error-summary ul{margin:.55rem 0 0;padding-inline-start:1.15rem;display:grid;gap:.3rem}
.error-summary li{font-size:.75rem;line-height:1.8;color:#FECDD3}
.error-summary a{color:#FECDD3;text-decoration:underline;text-underline-offset:3px}
/* A group of fields. Eight inputs in one stack is a wall; the same eight under three
   headings is a form, and the headings are what let a person stop halfway. */
/* display:block, deliberately. A legend is not a normal flow child of a fieldset — giving
   the fieldset display:grid promotes it to a grid item in some engines and drops it in
   others, so the grid goes on the wrapper and the legend stays where the spec puts it. */
.form-group{display:block;margin:0 0 1.5rem;padding:0;min-width:0;border:0}
.form-group legend{display:flex;align-items:baseline;gap:.55rem;flex-wrap:wrap;padding:0 0 .85rem;
font-size:.8rem;font-weight:700;color:rgba(226,232,240,.85)}
.form-group legend span{font-size:.69rem;font-weight:400;color:var(--haze)}
.form-group .fields{display:grid;gap:1rem}
.form-submit{width:100%;padding:.8rem 1rem;font-size:.9rem}

/* =========================================================================
   SIGN-IN AND SIGN-UP
   ========================================================================= */
/*
 * Two columns, and the second one is the point. A single centred form on a 1440px screen is
 * a small card floating in an empty room, and the registration form in that shape is a
 * 60rem-tall column of inputs with nothing anywhere to say why. The aside answers the
 * question someone hesitating on this page is actually asking — what is behind this form —
 * and it is hidden below 900px, where the form should simply be the page.
 */
.auth-shell{position:relative;max-width:64rem;margin:0 auto;padding:2rem 1rem 3.5rem;
display:grid;gap:2.5rem;align-items:start;grid-template-columns:minmax(0,1fr)}
.auth-aside{display:none}
.auth-col{display:grid;gap:1.15rem;align-content:start;min-width:0}
.auth-mark{display:flex;align-items:center;gap:.7rem;min-width:0}
.auth-mark-text{min-width:0}
.auth-mark b{display:block;font-family:var(--display);font-weight:900;font-size:1.02rem;line-height:1.45}
.auth-mark-text span{display:block;font-size:.72rem;color:var(--haze)}
/* The way out of the form. A sign-in page is reached from the site and from a merchant's
   own link, so it has to offer a route back to the site at any width — including the
   narrow widths, where the aside carrying the other one is hidden. */
.auth-out{margin-inline-start:auto;flex:none;font-size:.74rem;color:var(--haze)}
.auth-out:hover{color:var(--ice)}
.auth-heading{margin:0;font-family:var(--display);font-weight:900;
font-size:clamp(1.5rem,3.4vw,2.05rem);line-height:1.4;letter-spacing:-.03em}
.auth-heading em{font-style:normal;
background-image:linear-gradient(to left,#8EC2FF,#5AA3FF 45%,#B3D6FF);
-webkit-background-clip:text;background-clip:text;color:transparent}
.auth-lede{margin:.85rem 0 0;font-size:.85rem;line-height:2;color:var(--steel);max-width:30rem}
.auth-features{list-style:none;margin:1.75rem 0 0;padding:0;display:grid;gap:.6rem}
.auth-features li{display:flex;gap:.7rem;align-items:flex-start;padding:.75rem .85rem;
border-radius:14px;background:var(--glass-well);border:1px solid var(--glass-line)}
.auth-features b{display:block;font-size:.8rem;font-weight:600;color:var(--ice)}
.auth-features span{display:block;margin-top:.15rem;font-size:.73rem;line-height:1.8;color:var(--haze)}
.auth-trust{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1.25rem}
.auth-trust span{display:inline-flex;align-items:center;gap:.4rem;padding:.35rem .7rem;
border-radius:999px;background:var(--glass-well);border:1px solid var(--glass-line);
font-size:.7rem;color:var(--steel)}
.auth-card{border-radius:var(--radius-lg);padding:1.5rem 1.35rem;position:relative;min-width:0;
background:var(--glass-bg);border:1px solid var(--glass-line);
-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);
box-shadow:var(--glass-hi),var(--glass-lift),0 0 70px -40px rgba(47,125,255,.6)}
.auth-card-head{display:flex;align-items:center;gap:.75rem}
.auth-card-head b{display:block;font-family:var(--display);font-weight:900;font-size:1.05rem;
letter-spacing:-.015em;line-height:1.5}
.auth-card-head span{display:block;font-size:.72rem;color:var(--haze);line-height:1.7}
.auth-body{margin-top:1.35rem}
.auth-foot{margin-top:1.35rem;padding-top:1rem;border-top:1px solid var(--glass-line);
display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap;
font-size:.78rem}
.auth-foot a{color:var(--beam)}
.auth-foot .auth-out{color:var(--haze)}
@media (min-width:900px){
.auth-shell{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:3.5rem}
.auth-aside{display:grid;gap:.5rem;align-content:start}
}

/* --- the instruction note ---------------------------------------------- */
.pay-note{margin-top:1.25rem;padding:.875rem 1rem;border-radius:var(--radius);font-size:.81rem;
color:var(--steel);line-height:1.95;white-space:pre-wrap;word-break:break-word;
background:rgba(47,125,255,.07);border:1px solid rgba(90,163,255,.22)}
.dot{width:.5rem;height:.5rem;border-radius:50%;flex:none;background:var(--state,var(--signal));
box-shadow:0 0 0 3px color-mix(in srgb,var(--state,var(--signal)) 18%,transparent)}
/* --- the bank slip: the bank's own words, redacted --------------------- */
.slip{margin-top:1.25rem;border:1px solid var(--glass-line);border-radius:var(--radius);overflow:hidden;
background:var(--glass-bg)}
.slip-head{display:flex;align-items:center;gap:.5rem;padding:.6rem .875rem;border-bottom:1px solid var(--glass-line);
font-size:.75rem;color:var(--steel);font-weight:500}
.slip-head span{margin-inline-start:auto;font-weight:400;color:var(--haze);letter-spacing:0}
.slip-body{padding:.875rem;font-size:.79rem;line-height:2.1;color:var(--steel);white-space:pre-wrap;
word-break:break-word;background:rgba(5,7,13,.6)}
.slip-body mark{background:rgba(52,211,153,.13);color:var(--settled);padding:.05rem .3rem;border-radius:4px;
font-variant-numeric:tabular-nums}
.slip-foot{padding:.6rem .875rem;border-top:1px solid var(--glass-line);font-size:.69rem;color:var(--haze)}
.receipt-rows{margin:1.25rem 0 0;display:grid;gap:.625rem}
.receipt-row{display:flex;justify-content:space-between;gap:1rem;font-size:.81rem;padding-bottom:.625rem;
border-bottom:1px solid var(--glass-line)}
.receipt-row dt{color:var(--haze);margin:0}
.receipt-row dd{margin:0;text-align:left;font-weight:500}
/* A flex item's automatic minimum size is its min-content width, and a Jalali timestamp
   (۱۴۰۵/۰۶/۳۱ - ۰۶:۲۴) has no break opportunity in it — so a receipt row in a narrow column
   pushed its panel wider than the grid track and the whole page sideways. min-width:0 lets the
   item shrink, and break-word lets the timestamp itself break when it still cannot fit. */
.receipt-row dt,.receipt-row dd{min-width:0}
.receipt-row dd{overflow-wrap:break-word}
.receipt-row:last-child{border-bottom:0;padding-bottom:0}
/*
 * The payment state, in one place.
 *
 * --state is the mark itself (the pill's dot, the status dot) and --state-ink is the same
 * hue lifted to a readable tint for small text on a dark ground. Declaring the pair per
 * state is what makes a FAILED payment and a PAID one impossible to draw the same way, and
 * it is why nothing downstream needs its own three-way class list.
 */
.state-success{--state:var(--settled);--state-ink:#A7F3D0}
.state-pending{--state:var(--owed);--state-ink:#FDE68A}
.state-failed{--state:var(--failed);--state-ink:#FECDD3}
.state-review{--state:var(--signal);--state-ink:#B3D6FF}
.test-flag{margin-top:1rem;padding:.6rem .8rem;border-radius:var(--radius-sm);text-align:center;
font-size:.78rem;font-weight:500;
background:rgba(47,125,255,.12);border:1px solid rgba(90,163,255,.34);color:var(--beam)}
@media (max-width:380px){
.amount-card{padding:.875rem .9rem}
.amount-card-value b{font-size:1.6rem}
.amount-card-sub .amount-card-value b{font-size:1.25rem}
/* Tracking has to shrink with the type or the number overflows the card on the narrowest
   phones, and an overflow here is a clipped digit rather than a scrollbar. */
.bankcard-digits{font-size:.9rem;letter-spacing:.08em}
.pay-card{padding:1.25rem 1rem}
.pay-shell{padding:1rem .75rem 2.5rem}
.pay-step{padding:.45rem .55rem;gap:.5rem}
.pay-step-num{width:1.5rem;height:1.5rem;font-size:.7rem}
}
`;

/**
 * Application stylesheet: everything in PAY_CSS plus the aurora, the public chrome,
 * the landing page, the docs and the two operator consoles.
 *
 * Layered on the payment base rather than duplicating it, so a token change can
 * never land on one surface and miss the other.
 */
export const APP_CSS = `${PAY_CSS}${FONT_FACES_APP}

/* =========================================================================
   SHELL — the rail and the main column
   ========================================================================= */
.shell{display:grid;grid-template-columns:16rem minmax(0,1fr);min-height:100dvh;position:relative;z-index:1}
/*
 * The two wrappers below exist only for the narrow layout: they give the brand and the nav
 * groups their own rows there. On a wide screen they are made transparent, so the rail's
 * children sit directly in it exactly as they did before, so the rail's bottom-anchored
 * account cluster keeps its margin-top:auto.
 */
.nav-top,.nav-links{display:contents}
.nav-account{display:none}
/*
 * The rail, and the seam is on the wrong side of a first-column nav.
 *
 * .shell's first grid column is laid out at the inline start, which in an RTL document is
 * the right edge of the screen. That makes the nav's inline-START edge the viewport edge —
 * so a border there puts a line beside the scrollbar and leaves the actual seam between the
 * rail and the content, its inline-end, undrawn. border-inline-end is the edge that faces
 * the content, which is where the reference puts it (border-e on a first-child aside).
 */
.nav{position:sticky;top:0;height:100dvh;overflow-y:auto;display:flex;flex-direction:column;gap:1.1rem;
padding:1.15rem .8rem 1rem;background-color:var(--strata2);
border-inline-end:1px solid var(--seam)}
.nav-brand{display:flex;align-items:center;gap:.6rem;padding:.15rem .5rem .9rem;
border-bottom:1px solid var(--seam-soft)}
.nav-brand b{font-family:var(--display);font-weight:900;font-size:1rem;letter-spacing:-.015em}
/* The brand mark: a tile, the way the public header and the console both draw one. */
.brand-tile{width:2.15rem;height:2.15rem;border-radius:12px;flex:none;display:grid;place-items:center;
font-family:var(--display);font-weight:900;font-size:1rem;color:var(--beam);
background:rgba(47,125,255,.16);border:1px solid rgba(90,163,255,.32)}
.nav-brand i{width:.4rem;height:.4rem;border-radius:50%;background:var(--signal);flex:none;
box-shadow:0 0 12px var(--signal);animation:glow 2.6s ease-in-out infinite}
.nav-brand span{font-size:.7rem;color:var(--haze);display:block;margin-top:-.1rem}
.nav-group{display:flex;flex-direction:column;gap:.125rem}
.nav-group h2{font-size:.68rem;font-weight:600;color:var(--haze);padding:0 .6rem;
letter-spacing:.12em;text-transform:uppercase;margin:.85rem 0 .35rem}
.nav-link{display:flex;align-items:center;gap:.55rem;padding:.5rem .6rem;border-radius:var(--radius-xs);
color:var(--steel);font-size:.83rem;border:1px solid transparent;position:relative;
transition:background .18s ease,color .18s ease}
.nav-link:hover{background:rgba(148,163,184,.08);color:var(--ice);text-decoration:none}
.nav-link[aria-current='page']{background:rgba(47,125,255,.14);color:#D9EBFF;font-weight:600}
/* The active rail: a lit bar on the reading start edge. It marks position, which is the one
   thing a sparse rail cannot otherwise communicate, and it is the only place the accent
   appears in the frame. */
.nav-link[aria-current='page']::before{content:'';position:absolute;inset-block:.45rem;
inset-inline-start:-.35rem;width:2px;border-radius:2px;background:var(--arc);
box-shadow:0 0 12px var(--signal)}
.nav-foot{margin-top:auto;padding-top:1rem;border-top:1px solid var(--seam-soft);font-size:.71rem;
color:var(--haze);display:grid;gap:.4rem}
.nav-foot .btn{font-size:.68rem;padding:.25rem .5rem;justify-self:start}
.nav-foot a{color:var(--haze)}
.main{padding:1.5rem 1.75rem 4rem;min-width:0;width:100%;max-width:1600px;margin-inline:auto}
.top{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;
margin-bottom:1.75rem;padding-bottom:1.25rem;border-bottom:1px solid var(--hairline-soft);flex-wrap:wrap}
.top>*{min-width:0}
.top h1{margin:0;font-family:var(--display);font-weight:900;font-size:1.5rem;letter-spacing:-.02em}
.top p{margin:.45rem 0 0;color:var(--steel);font-size:.82rem;max-width:46rem}
.top-actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
/*
 * The vertical-rhythm container, and the third place this same trap appears.
 *
 * An implicit grid column is auto, and an auto track is sized to max-content — so one panel
 * holding a single unbreakable token (an invoice id in a heading, a bank SMS) widened its track
 * past the column, stretched every sibling to match, and pushed the whole page sideways. Naming
 * the column minmax(0,1fr) lets the track shrink and hands the overflow to whatever is
 * supposed to contain it. Same shape of bug as the shell grid and the receipt row: a minimum
 * size that defaults to "as wide as the content says" instead of zero.
 */
.stack{display:grid;gap:1rem;grid-template-columns:minmax(0,1fr)}
.grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1rem}
.grid-3{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:1rem}
.grid-4{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.875rem}
.grid-2>*,.grid-3>*,.grid-4>*{min-width:0}

/* =========================================================================
   PANELS — frosted glass
   ========================================================================= */
.panel{border-radius:var(--radius);padding:1.15rem 1.25rem;position:relative;min-width:0;
background:var(--glass-bg);border:1px solid var(--glass-line);
-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);
box-shadow:var(--glass-hi),var(--glass-lift)}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:1rem;
min-width:0}
.panel-head h2{margin:0;font-family:var(--display);font-weight:800;font-size:1rem;letter-spacing:-.015em}
.panel-head a{font-size:.74rem}
.panel-head>*{min-width:0}
/*
 * An identifier inside a heading or a page title.
 *
 * inv_01M33GJ0MWNXV8TBJV6H14B2D0 has no break opportunity in it, so its min-content width is
 * the whole string: as a flex item the heading could not shrink below it and the panel grew
 * past its column, pushing the page sideways. Here the token should break rather than widen
 * anything, so anywhere is right — collapsing min-content is exactly what lets the heading fit.
 * This is the opposite of the table rule further down, and the two are not interchangeable.
 */
.panel-head .mono,.top .mono{overflow-wrap:anywhere}

/* =========================================================================
   STATS — a figure, its label, and a bar that appears when you point at it
   ========================================================================= */
.stat{border-radius:var(--radius);padding:1.15rem 1.2rem;position:relative;overflow:hidden;
background:var(--glass-bg);border:1px solid var(--glass-line);
-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);
box-shadow:var(--glass-hi),var(--glass-lift);
transition:transform .3s cubic-bezier(.4,0,.2,1),box-shadow .3s ease,background-color .3s ease}
.stat:hover{transform:translateY(-3px);background:var(--glass-bg-2);
box-shadow:var(--glass-hi),var(--glass-lift),var(--signal-glow)}
.stat-label{font-size:.73rem;color:var(--haze);margin:0 0 .55rem}
.stat-value{font-family:var(--display);font-size:1.7rem;font-weight:900;letter-spacing:-.02em;line-height:1.3;
font-variant-numeric:tabular-nums;color:var(--ice)}
.stat-value small{font-family:${FONT_STACK.ui};font-size:.72rem;color:var(--steel);font-weight:500;
margin-inline-start:.3rem}
.stat-sub{font-size:.72rem;color:var(--haze);margin:.5rem 0 0}
.stat-amber .stat-value{color:var(--owed);text-shadow:0 0 26px rgba(251,191,36,.22)}
.stat-settle .stat-value{color:var(--settled);text-shadow:0 0 26px rgba(52,211,153,.22)}
.stat-reject .stat-value{color:var(--failed);text-shadow:0 0 26px rgba(251,113,133,.22)}

/* =========================================================================
   TABLES
   ========================================================================= */
table{width:100%;border-collapse:collapse;font-size:.81rem}
thead th{text-align:right;font-weight:600;font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;
color:var(--haze);padding:.6rem .6rem;border-bottom:1px solid var(--seam);white-space:nowrap}
tbody td{padding:.7rem .6rem;border-bottom:1px solid var(--seam-soft);vertical-align:middle;
font-variant-numeric:tabular-nums}
tbody tr{transition:background .18s ease}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--glass-well)}
.table-wrap{overflow-x:auto;margin:0 -1.25rem;padding:0 1.25rem}
/*
 * An identifier is one long token with no break opportunity, so it overflows its cell and is
 * clipped by the table wrapper — silently truncating the exact string a person is about to
 * copy. Allowing a break is the cheap fix; a wider column only moves the threshold.
 *
 * break-word, deliberately, not anywhere. The two look interchangeable and are not: only
 * anywhere counts the new break opportunities when computing a box's min-content width. With
 * it, an identifier's min-content width collapses to a single character — so a table narrow
 * enough to scroll squeezed its SP-1001 and 09120000099 columns down to one glyph per line,
 * stacking a merchant code vertically down the page. break-word still breaks the token when it
 * genuinely cannot fit, but leaves min-content honest so the table scrolls instead.
 */
.table-wrap .mono{overflow-wrap:break-word}

/* =========================================================================
   BADGES — status words from the state machine, never from a URL
   ========================================================================= */
.badge{display:inline-flex;align-items:center;gap:.35rem;padding:.2rem .6rem;border-radius:999px;
font-size:.7rem;font-weight:500;white-space:nowrap;
border:1px solid var(--glass-line-2);background:var(--glass-well);color:var(--steel)}
.badge i{width:.36rem;height:.36rem;border-radius:50%;background:currentColor;flex:none;
box-shadow:0 0 8px currentColor}
.badge-paid,.badge-active,.badge-delivered,.badge-connected{color:var(--settled);
border-color:rgba(52,211,153,.32);background:rgba(52,211,153,.10)}
.badge-pending,.badge-open,.badge-in_progress{color:var(--owed);
border-color:rgba(251,191,36,.32);background:rgba(251,191,36,.10)}
.badge-expired,.badge-failed,.badge-dead,.badge-cancelled,.badge-suspended,.badge-banned,.badge-rejected{
color:var(--failed);border-color:rgba(251,113,133,.32);background:rgba(251,113,133,.10)}
.badge-review,.badge-manual_review,.badge-waiting_for_admin,.badge-waiting_for_user{
color:var(--beam);border-color:rgba(90,163,255,.32);background:rgba(47,125,255,.12)}

/* =========================================================================
   THE PIPELINE SPINE
   Structure as information: a stage is lit only when that stage actually
   happened, read from the database. The connector between lit stages is drawn
   as a signal line rather than a divider, because that is what it represents.
   ========================================================================= */
.spine{display:flex;align-items:center;gap:.375rem;flex-wrap:wrap}
.spine-node{display:flex;align-items:center;gap:.4rem;padding:.35rem .65rem;border-radius:999px;
border:1px solid var(--glass-line);background:var(--glass-well);font-size:.72rem;color:var(--haze)}
.spine-node[data-state='done']{color:var(--settled);border-color:rgba(52,211,153,.32);background:rgba(52,211,153,.08)}
.spine-node[data-state='current']{color:var(--owed);border-color:rgba(251,191,36,.34);background:rgba(251,191,36,.08)}
.spine-node[data-state='blocked']{color:var(--failed);border-color:rgba(251,113,133,.32);background:rgba(251,113,133,.08)}
.spine-node b{font-weight:500}
.spine-sep{width:.9rem;height:1px;background:linear-gradient(90deg,var(--seam),var(--seam-soft));flex:none}

/* Forms: the field and control vocabulary lives in the base sheet (PAY_CSS). The console
   only re-points the input at its own recessed well, below. */

/* =========================================================================
   ALERTS — the badge recipe at prose scale
   ========================================================================= */
.alert{padding:.8rem 1rem;border-radius:var(--radius-sm);font-size:.8rem;line-height:1.9;
border:1px solid var(--glass-line-2);background:var(--glass-well)}
.alert-error{border-color:rgba(251,113,133,.34);background:rgba(251,113,133,.09);color:#FFD6DC}
.alert-success{border-color:rgba(52,211,153,.34);background:rgba(52,211,153,.09);color:#C6F6E4}
.alert-info{border-color:rgba(90,163,255,.34);background:rgba(47,125,255,.10);color:#D6E4FF}
.alert-warn{border-color:rgba(251,191,36,.34);background:rgba(251,191,36,.09);color:#FFE7BC}

/* =========================================================================
   ONE-TIME SECRET REVEAL
   ========================================================================= */
.key-reveal{font-family:${FONT_STACK.code};font-size:.79rem;word-break:break-all;padding:.9rem 1rem;
border-radius:var(--radius);color:var(--ice);display:flex;gap:.6rem;align-items:center;
justify-content:space-between;flex-wrap:wrap;
background:rgba(47,125,255,.10);border:1px dashed rgba(90,163,255,.45);
box-shadow:var(--glass-hi),0 0 40px -22px rgba(47,125,255,.9)}
/* A checklist row: state chip, then the step and its next action, packed from the reading
   start. The action sits beside its step rather than at the far end of a wide panel — a
   button 900px away from the thing it acts on reads as a different control. */
.setup-step{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap;padding:.6rem .75rem;
border-radius:var(--radius-sm);background:var(--glass-well);border:1px solid var(--glass-line)}
.setup-step-body{flex:1 1 12rem;min-width:0;font-size:.83rem}
.empty{text-align:center;padding:3rem 1rem;color:var(--steel)}
.empty h3{margin:0 0 .5rem;font-family:var(--display);font-size:1.1rem;color:var(--ice);font-weight:800}
.empty p{margin:0 0 1.1rem;font-size:.82rem;line-height:1.95}
.spark{display:flex;align-items:flex-end;gap:3px;height:3.5rem}
.spark i{flex:1;border-radius:3px 3px 0 0;min-height:3px;
background:linear-gradient(180deg,var(--arc),rgba(47,125,255,.35))}
.spark i[data-zero='1']{background:var(--seam)}
.bar-row{display:flex;align-items:center;gap:.6rem;font-size:.75rem}
.bar-row .bar{flex:1;height:.45rem;border-radius:999px;background:var(--glass-well);overflow:hidden}
.bar-row .bar span{display:block;height:100%;border-radius:999px;
background:linear-gradient(90deg,var(--signal),var(--arc))}

/* =========================================================================
   SUPPORT CONVERSATION
   ========================================================================= */
.chat{display:grid;gap:.75rem;max-height:26rem;overflow-y:auto;padding:.25rem}
.msg{max-width:78%;padding:.7rem .9rem;border-radius:var(--radius);font-size:.82rem;line-height:1.95;
border:1px solid var(--glass-line);background:var(--glass-bg);word-break:break-word;white-space:pre-wrap}
.msg[data-mine='1']{margin-inline-start:auto;border-color:rgba(90,163,255,.28);
background:rgba(47,125,255,.14)}
.msg-meta{font-size:.67rem;color:var(--haze);margin-top:.35rem;font-family:${FONT_STACK.code}}

/* =========================================================================
   PUBLIC CHROME — a floating glass bar, not a full-bleed strip
   ========================================================================= */
.site-nav{position:sticky;top:0;z-index:40;padding:1rem 1rem 0}
.site-nav-inner{max-width:72rem;margin:0 auto;display:flex;align-items:center;gap:1rem;
padding:.7rem 1rem;border-radius:var(--radius);
/*
 * The fill is opaque enough to carry the bar on its own. The frosted look comes from the
 * blur, but the blur is not guaranteed to composite, and a header floating over content that
 * scrolled under it must still hide that content when it does not.
 */
background:rgba(7,10,20,.78);border:1px solid var(--glass-line);
-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);
box-shadow:var(--glass-hi),var(--glass-lift)}
.site-brand{display:flex;align-items:center;gap:.6rem;font-family:var(--display);font-weight:900;
font-size:1.02rem;letter-spacing:-.015em;color:var(--ice);text-decoration:none}
.site-brand:hover{color:var(--ice);text-decoration:none}
.site-brand span{font-family:${FONT_STACK.code};font-size:.58rem;letter-spacing:.18em;text-transform:uppercase;
color:var(--haze);display:block;margin-top:-.2rem;font-weight:500}
.site-links{display:flex;align-items:center;gap:.6rem;margin-inline-start:auto}
.site-links a{font-size:.82rem;color:var(--steel)}
.site-links a:hover{color:var(--ice);text-decoration:none}
.site-links .btn{font-size:.79rem;padding:.5rem .95rem}
.wrap{max-width:72rem;margin:0 auto;padding:0 1.5rem}

/*
 * The hero's own light: a wide bloom behind the headline over a faint blueprint grid. The
 * grid is what grounds the art — without it the bloom is a gradient, with it the top of the
 * page reads as a lit surface with a structure under it.
 */
.hero{position:relative;overflow:hidden;padding:4.5rem 1.5rem 4rem}
.hero-glow{position:absolute;top:-16rem;inset-inline-start:50%;transform:translateX(50%);
width:54rem;height:38rem;pointer-events:none;
background:radial-gradient(50% 50% at 50% 50%,rgba(47,125,255,.26),rgba(90,163,255,.08) 55%,transparent 74%)}
.grid-field{position:absolute;inset:0;pointer-events:none;opacity:.7}
.grid-field::before{content:'';position:absolute;inset:0;
background-image:linear-gradient(rgba(142,194,255,.06) 1px,transparent 1px),
linear-gradient(90deg,rgba(142,194,255,.06) 1px,transparent 1px);
background-size:44px 44px;
-webkit-mask-image:radial-gradient(70% 60% at 50% 35%,#000,transparent 78%);
mask-image:radial-gradient(70% 60% at 50% 35%,#000,transparent 78%)}
.hero-inner{position:relative;max-width:74rem;margin:0 auto;
display:grid;grid-template-columns:1.05fr .95fr;gap:3rem;align-items:center}
.hero-title{font-family:var(--display);font-size:clamp(2.05rem,5vw,3.3rem);line-height:1.3;margin:0;
font-weight:900;letter-spacing:-.03em}
.hero-title em{font-style:normal;
background-image:linear-gradient(to left,#8EC2FF,#5AA3FF 45%,#B3D6FF);
-webkit-background-clip:text;background-clip:text;color:transparent}
.hero-lede{margin:1.2rem 0 0;font-size:1rem;line-height:2.05;color:var(--steel);max-width:34rem}
.hero-actions{display:flex;gap:.7rem;margin-top:1.9rem;flex-wrap:wrap}
.btn-lg{padding:.8rem 1.5rem;font-size:.9rem;border-radius:16px}
.btn-sm{padding:.3rem .62rem;font-size:.72rem;border-radius:10px}
/*
 * The slot a card face sits in.
 *
 * A card is a wide object and a panel is a narrow one on a phone, so the slot caps the
 * width and lets the aspect ratio decide the height. Without the cap the card would take the
 * panel's full width on a 1600px console and become a banner rather than a card.
 */
.card-slot{margin:.9rem 0 1rem;max-width:24rem}
.card-slot-sm{max-width:19rem}
.hero-facts{list-style:none;margin:2.25rem 0 0;padding:0;display:flex;gap:1.75rem;flex-wrap:wrap}
.hero-facts li{display:grid;gap:.15rem}
.hero-facts b{font-family:var(--display);font-size:1.35rem;font-weight:900;
font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.hero-facts span{font-size:.73rem;color:var(--haze)}

/*
 * The forged amount: the product's own artifact, shown at the top of the page
 * because it is the most characteristic thing this system produces. The digits
 * change; everything around them holds still.
 */
.forge{border-radius:var(--radius-lg);padding:1.4rem 1.35rem 1.3rem;position:relative;overflow:hidden;
background:var(--glass-bg);border:1px solid var(--glass-line);
-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);
box-shadow:var(--glass-hi),var(--glass-lift),0 0 80px -40px rgba(47,125,255,.7)}
.forge::before{content:'';position:absolute;inset:0 0 auto 0;height:1px;
background:linear-gradient(90deg,transparent,var(--arc),transparent);animation:trace 4s linear infinite;
background-size:200% 100%}
.forge::after{content:'';position:absolute;top:0;bottom:0;width:30%;pointer-events:none;
background:linear-gradient(90deg,transparent,rgba(142,194,255,.09),transparent);animation:sweep 6s linear infinite}
.forge-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;
font-size:.72rem;color:var(--haze)}
.forge-head .tracked{font-size:.62rem}
.forge-amount{display:flex;align-items:baseline;gap:.45rem;justify-content:center;
margin:1.15rem 0 .4rem;position:relative}
.forge-amount b{font-family:var(--display);font-size:clamp(2rem,4.8vw,2.75rem);font-weight:900;
letter-spacing:-.025em;font-variant-numeric:tabular-nums;text-shadow:0 0 38px rgba(47,125,255,.55)}
.forge-amount span{font-size:.9rem;color:var(--steel)}
.forge-rial{text-align:center;font-family:${FONT_STACK.code};font-size:.72rem;color:var(--haze);
padding-top:.6rem;border-top:1px dashed var(--glass-line-2)}
.forge-rows{margin:1.15rem 0 0;display:grid;gap:.5rem;position:relative}
.forge-rows div{display:flex;justify-content:space-between;gap:1rem;font-size:.76rem;
padding-bottom:.5rem;border-bottom:1px solid var(--glass-line);color:var(--steel)}
.forge-rows div:last-child{border-bottom:0;padding-bottom:0}
.forge-rows b{color:var(--ice);font-weight:500;font-variant-numeric:tabular-nums}
.forge-rows .ok{color:var(--settled)}
.forge-rows .wait{color:var(--owed)}

/* Bands: the page's sections. The title row is a two-column arrangement so the
   heading and its supporting paragraph never fight for the same line. */
.band{padding:5rem 1.5rem;position:relative}
.band-alt{background:linear-gradient(180deg,rgba(8,13,24,.72),rgba(5,7,13,0))}
.band-head{max-width:74rem;margin:0 auto 2.5rem;display:grid;grid-template-columns:1fr 1fr;
gap:2rem;align-items:end}
.band-head h2{margin:0;font-family:var(--display);font-size:clamp(1.5rem,2.8vw,2.1rem);font-weight:900;
letter-spacing:-.025em;line-height:1.4}
.band-head p{margin:0;color:var(--steel);font-size:.9rem;line-height:2.05}

/* The pipeline, numbered because it genuinely is a sequence with an order the
   reader must understand — money moves through these stages in this order. */
.steps{margin:0;padding:0;list-style:none;display:grid;gap:1px;background:var(--glass-line);
border:1px solid var(--glass-line);border-radius:var(--radius-lg);overflow:hidden;
-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur)}
.step{display:grid;grid-template-columns:3.5rem 1fr;gap:1.25rem;align-items:start;
padding:1.45rem 1.5rem;background:rgba(8,13,24,.72)}
.step-num{font-family:${FONT_STACK.code};font-size:.78rem;font-weight:500;color:var(--beam);
padding-top:.15rem;letter-spacing:.04em}
.step h3{margin:0 0 .4rem;font-family:var(--display);font-size:1.02rem;font-weight:800;letter-spacing:-.015em}
.step p{margin:0;font-size:.85rem;line-height:2;color:var(--steel)}
.step code{font-family:${FONT_STACK.code};font-size:.78rem;color:var(--beam);
background:rgba(47,125,255,.12);padding:.08rem .35rem;border-radius:5px;direction:ltr;display:inline-block}

.split{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;align-items:start}
/* Code surface: a terminal window, because the audience for this section is
   about to paste it into one. */
.code{border:1px solid var(--glass-line);border-radius:var(--radius);overflow:hidden;
background:rgba(5,7,13,.72);
-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur);
box-shadow:var(--glass-hi),var(--glass-lift)}
.code-bar{display:flex;align-items:center;gap:.5rem;padding:.6rem .9rem;border-bottom:1px solid var(--glass-line);
background:var(--glass-well);font-family:${FONT_STACK.code};font-size:.65rem;letter-spacing:.1em;
text-transform:uppercase;color:var(--haze)}
/* The label grows instead of each trailing item pushing itself right. If two items both
   carried margin-inline-start:auto the free space would be split between them, stranding
   the note in the middle of the bar; this way the markup order is the screen order. */
.code-bar>span:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.code-bar b{font-weight:500;color:var(--steel);text-transform:none;letter-spacing:0}
/* A real button, not a styled span: it is a control, so it is keyboard focusable and its
   label changes to confirm the copy rather than relying on colour alone. */
.code-copy{flex:none;font-family:${FONT_STACK.ui};font-size:.68rem;letter-spacing:0;
color:var(--steel);background:var(--glass);border:1px solid var(--glass-line);border-radius:999px;
padding:.22rem .6rem;cursor:pointer;transition:color .16s,border-color .16s,background .16s}
.code-copy:hover{color:var(--ice);border-color:var(--glass-edge)}
.code-copy:focus-visible{outline:2px solid var(--arc);outline-offset:2px}
.code-copy[data-copied]{color:var(--settled);border-color:rgba(52,211,153,.45)}
.code-body{margin:0;padding:.95rem 1.05rem;font-family:${FONT_STACK.code};font-size:.75rem;line-height:2.05;
color:var(--steel);overflow-x:auto;direction:ltr;text-align:left;white-space:pre}
.code-body .k{color:var(--beam)}
.code-body .s{color:var(--settled)}
.code-body .n{color:var(--arc)}
.code-body .c{color:var(--haze)}
.code-body .p{color:var(--ice)}
/* Bidi isolation. A Persian string or comment inside an LTR code line is an RTL run, and
   without isolating it the neutral characters around it — quotes, commas, the comment
   marker — are reordered by the bidi algorithm. The result is not merely ugly: a sample
   whose quotes move is a sample a reader copies wrong. Isolating each run lets the
   surrounding line keep its LTR order while the Persian inside keeps its own. */
.code-body .c,.code-body .s,.code-body .p{unicode-bidi:isolate}
.code-body .c{white-space:pre}

.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:1px;
background:var(--glass-line);border:1px solid var(--glass-line);border-radius:var(--radius-lg);overflow:hidden;
-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur)}
.fact{padding:1.45rem 1.4rem;background:rgba(8,13,24,.72)}
.fact b{display:block;font-family:var(--display);font-size:1.65rem;font-weight:900;letter-spacing:-.025em;
font-variant-numeric:tabular-nums;color:var(--ice)}
.fact b em{font-style:normal;font-family:${FONT_STACK.ui};font-size:.8rem;color:var(--haze);
font-weight:400;margin-inline-start:.3rem}
.fact span{display:block;margin-top:.45rem;font-size:.8rem;color:var(--steel);line-height:1.95}
.fact code{font-family:${FONT_STACK.code};font-size:.75rem;color:var(--arc)}

.site-foot{border-top:1px solid var(--glass-line);padding:2.5rem 1.5rem;margin-top:2rem;
background:linear-gradient(180deg,rgba(8,13,24,.6),rgba(5,7,13,0))}
.site-foot-inner{max-width:74rem;margin:0 auto;display:flex;gap:1.75rem;align-items:flex-start;
justify-content:space-between;flex-wrap:wrap;font-size:.78rem;color:var(--haze)}
.site-foot a{color:var(--steel)}

/* =========================================================================
   DOCS
   ========================================================================= */
/* The rail and the reading measure are one unit, centred together. Left uncapped, the
   measure floats in the middle of the remaining column with a wide gap to the rail, which
   reads as an unfinished layout rather than a deliberate one. */
.docs-shell{grid-template-columns:15rem minmax(0,1fr);max-width:84rem;margin:0 auto;width:100%}
.docs-nav{position:sticky;top:0;height:100dvh;overflow-y:auto;padding:1.15rem .8rem 2rem;
border-inline-end:1px solid var(--glass-line);background:rgba(7,10,20,.6);
-webkit-backdrop-filter:var(--glass-blur);backdrop-filter:var(--glass-blur)}
.docs-body{max-width:52rem;margin:0 auto;padding:2.5rem 1.75rem 5rem;min-width:0}
.docs-head h1{font-family:var(--display);font-size:2rem;margin:0 0 .6rem;font-weight:900;letter-spacing:-.03em}
.docs-head p{margin:0;color:var(--steel);font-size:.92rem;line-height:2.1;max-width:42rem}
.docs-section{margin-top:3.25rem;scroll-margin-top:1.5rem}
.docs-section > h2{font-family:var(--display);font-size:1.35rem;margin:0 0 .35rem;font-weight:900;
letter-spacing:-.02em;display:flex;align-items:center;gap:.7rem}
.docs-section > h2::after{content:'';flex:1;height:1px;background:var(--glass-line)}
.docs-section > p{color:var(--steel);font-size:.87rem;line-height:2.1}
.docs-section h3{font-family:var(--display);font-size:1rem;margin:1.9rem 0 .5rem;font-weight:800;color:var(--ice)}
.docs-section ul,.docs-section ol{color:var(--steel);font-size:.86rem;line-height:2.1;padding-inline-start:1.2rem}
.docs-section li{margin-bottom:.3rem}
.docs-section code{font-family:${FONT_STACK.code};font-size:.78rem;color:var(--arc);
background:rgba(47,125,255,.12);padding:.1rem .35rem;border-radius:5px}
.docs-section strong{color:var(--ice);font-weight:600}
.docs-section a{color:var(--beam)}
.docs-note{padding:.85rem 1.05rem;border-radius:var(--radius-sm);margin:1.1rem 0;font-size:.82rem;
line-height:2;background:rgba(47,125,255,.07);border:1px solid rgba(90,163,255,.22);color:var(--steel)}
.docs-note b{color:var(--ice);font-weight:600}
/* Endpoint headers: the method is the most useful thing to scan for, so it leads
   and carries its own colour. Semantics match HTTP, not the palette. */
.ep{display:flex;align-items:center;gap:.7rem;margin:1.1rem 0 .6rem;flex-wrap:wrap}
.ep-method{font-family:${FONT_STACK.code};font-size:.68rem;font-weight:500;letter-spacing:.08em;
padding:.22rem .5rem;border-radius:6px;border:1px solid transparent}
.ep-get{color:var(--beam);background:rgba(90,163,255,.12);border-color:rgba(90,163,255,.3)}
.ep-post{color:var(--settled);background:rgba(52,211,153,.10);border-color:rgba(52,211,153,.3)}
.ep-del{color:var(--failed);background:rgba(251,113,133,.10);border-color:rgba(251,113,133,.3)}
.ep-path{font-family:${FONT_STACK.code};font-size:.82rem;color:var(--ice);direction:ltr}
.docs-table{margin:1rem 0}
.docs-nav .nav-group h2{margin-top:1.15rem}

/* =========================================================================
   OPERATOR CONSOLES — a different material on the same markup
   -------------------------------------------------------------------------
   The public site is frosted glass: translucent fills that let the aurora bleed
   through, 20-24px radii, a glow on hover. That reads well for a landing page and
   badly for a tool — an operator auditing a ledger needs edges that hold still, not
   panels that shimmer over a moving gradient.

   So the console gets matte plates on a darker chassis: opaque, flat, 14px radii,
   cool slate hairlines instead of blur, and every glow replaced by a crisp accent
   outline. Everything below is scoped to .adm-root, so the public surfaces keep
   their glass untouched.
   ========================================================================= */
.adm-root{
/*
 * An opaque ground on purpose: it covers the aurora so the animated gradient stops
 * drifting behind data an operator is reading.
 */
background-color:var(--adm-ground)}
.adm-root .nav{background-color:var(--adm-chassis);border-inline-end:1px solid var(--adm-line)}
.adm-root .nav-brand{border-bottom:1px solid var(--adm-line-soft)}
.adm-root .nav-group h2{color:rgba(226,232,240,.5)}
.adm-root .nav-link{color:rgba(226,232,240,.58)}
.adm-root .nav-link:hover{background:rgba(148,163,184,.08);color:#EEF2FF}
.adm-root .nav-link[aria-current='page']{background:rgba(47,125,255,.14);color:#D9EBFF}
.adm-root .nav-link[aria-current='page']::before{background:var(--arc);box-shadow:none}
.adm-root .nav-foot{border-top:1px solid var(--adm-line-soft);color:rgba(226,232,240,.4)}
/* The page header is bare type over a hairline. A title inside a panel inside a panel
   was the main source of visual noise on these pages. */
.adm-root .top{border-bottom:1px solid var(--adm-line-soft);padding-bottom:1.15rem;margin-bottom:1.5rem}
.adm-root .top h1{font-size:1.45rem}
.adm-root .top p{color:rgba(226,232,240,.5)}
.adm-root .eyebrow{color:rgba(226,232,240,.5);opacity:1}
/* Materials: plates float above the chassis, wells recede into them. */
.adm-root .panel,.adm-root .stat{background-color:var(--adm-plate);border:1px solid var(--adm-line);
border-radius:14px;box-shadow:var(--adm-lift);
-webkit-backdrop-filter:none;backdrop-filter:none}
.adm-root .stat{transition:background-color .18s ease,transform .18s ease}
.adm-root .stat:hover{background-color:var(--adm-plate-hover);transform:none;
box-shadow:var(--adm-lift),0 0 0 1px rgba(47,125,255,.4)}
.adm-root .panel-head h2{font-family:${FONT_STACK.ui};font-weight:600;font-size:.95rem;letter-spacing:-.01em}
.adm-root .stat-value{font-family:${FONT_STACK.ui};font-weight:700;font-size:1.6rem;letter-spacing:-.02em}
.adm-root .stat-amber .stat-value,.adm-root .stat-settle .stat-value,.adm-root .stat-reject .stat-value{text-shadow:none}
.adm-root .stat-label{color:rgba(226,232,240,.4)}
.adm-root .stat-sub{color:rgba(226,232,240,.4)}
/* Tables. Header labels become the console's eyebrow; row separators stay quieter than
   the plate edge they sit inside. */
.adm-root thead th{border-bottom-color:var(--adm-line);color:rgba(226,232,240,.4);
font-size:.68rem;font-weight:600;letter-spacing:.1em}
.adm-root tbody td{border-bottom-color:var(--adm-line-soft)}
.adm-root tbody tr:hover{background-color:var(--adm-plate-hover)}
/* Controls: tighter radii, no blur, no glow. A console control is a bezel on a plate. */
.adm-root .btn{border-radius:var(--radius-xs);background-color:rgba(148,163,184,.06);
border-color:var(--adm-line);box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none;
transition:background-color .18s ease,border-color .18s ease,color .18s ease}
.adm-root .btn:hover{background-color:rgba(148,163,184,.13);border-color:var(--adm-line-strong);
color:#EEF2FF;box-shadow:none}
.adm-root .btn:active{transform:none}
.adm-root .btn::after{display:none}
.adm-root .btn-primary{background-image:none;background-color:var(--signal);
border-color:rgba(47,125,255,.5);box-shadow:0 14px 28px -18px rgba(47,125,255,.9)}
.adm-root .btn-primary:hover{background-image:none;background-color:#4B90FF;box-shadow:0 14px 28px -18px rgba(47,125,255,.9)}
.adm-root .input{border-radius:var(--radius-xs);background-color:var(--adm-well);
border-color:var(--adm-line)}
.adm-root .input:focus{background-color:var(--adm-well);border-color:var(--arc)}
.adm-root .key-reveal,.adm-root .setup-step,.adm-root .code,.adm-root .msg,
.adm-root .alert,.adm-root .docs-note{border-radius:14px}
.adm-root .key-reveal{background-color:rgba(47,125,255,.10);border-color:rgba(47,125,255,.4);
box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none}
.adm-root .setup-step{background-color:var(--adm-well);border-color:var(--adm-line)}
.adm-root .setup-step,.adm-root .msg,.adm-root .alert{-webkit-backdrop-filter:none;backdrop-filter:none}
.adm-root .alert{background-color:var(--adm-well)}
.adm-root .alert-error{background-color:rgba(251,113,133,.09)}
.adm-root .alert-success{background-color:rgba(52,211,153,.09)}
.adm-root .alert-info{background-color:rgba(47,125,255,.10)}
.adm-root .alert-warn{background-color:rgba(251,191,36,.09)}
.adm-root .empty{padding:2.5rem 1rem}
.adm-root .spine-node{background-color:var(--adm-well);border-color:var(--adm-line)}
.adm-root .spine-sep{background:linear-gradient(90deg,var(--adm-line),var(--adm-line-soft))}
.adm-root .grid-field,.adm-root .hero-glow,.adm-root .trace{display:none}

/* =========================================================================
   RESPONSIVE
   ========================================================================= */
@media (max-width:1024px){
.hero-inner{grid-template-columns:1fr;gap:2.5rem}
.band-head{grid-template-columns:1fr;gap:.9rem;align-items:start}
.split{grid-template-columns:1fr}
}
/*
 * Narrow layout.
 *
 * The rail becomes a two-row sticky header: who you are on the first row, where you can go on
 * the second. Navigation that is a single horizontally scrolling line of links is a real
 * pattern — but it only works if the links cannot be shrunk, and a flex item will happily
 * shrink until a two-word Persian label wraps onto a second line and the row grows a stripe
 * of orphaned text. A flex:none on every item is what makes the strip scroll instead.
 */
@media (max-width:880px){
/*
 * minmax(0,1fr), not 1fr.
 *
 * 1fr means minmax(auto,1fr), and that auto is a min-content floor: a single child that
 * cannot shrink — the account cluster with a name in it, a long unbroken id — widens the
 * whole column past the viewport, which then pushes the entire page sideways and clips the
 * opposite edge. The floor has to be zero so the overflow is contained by whichever element
 * is meant to scroll.
 */
.shell,.docs-shell{grid-template-columns:minmax(0,1fr)}

.nav{position:sticky;top:0;z-index:30;height:auto;width:100%;max-width:100%;overflow:visible;
flex-direction:column;gap:.5rem;padding:.55rem .85rem .6rem;
background-color:var(--adm-chassis);
-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
border-inline-end:0;border-bottom:1px solid var(--adm-line)}
.nav-top{display:flex;align-items:center;justify-content:space-between;gap:.65rem;min-width:0}
.nav-brand{padding:0;border-bottom:0;min-width:0;flex:0 1 auto}
.nav-brand>div{min-width:0}
.nav-brand b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nav-brand span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nav-account{display:flex;align-items:center;gap:.5rem;flex:0 1 auto;min-width:0;font-size:.71rem;color:var(--haze)}
.nav-account-name{max-width:7rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--steel)}
.nav-account form{margin:0}
.nav-account .btn{font-size:.68rem;padding:.25rem .55rem;flex:none}
.nav-foot{display:none}

.nav-links{display:flex;flex-wrap:nowrap;gap:.3rem;overflow-x:auto;overscroll-behavior-x:contain;
scrollbar-width:none;margin:0 -.85rem;padding:0 .85rem;
/* The fading edge is the only hint that the strip scrolls further. */
-webkit-mask-image:linear-gradient(to left,#000 calc(100% - 1.9rem),transparent);
mask-image:linear-gradient(to left,#000 calc(100% - 1.9rem),transparent)}
.nav-links::-webkit-scrollbar{display:none}
.nav-group{flex:none;flex-direction:row;gap:.3rem}
.nav-group h2{display:none}
.nav-link{flex:none;white-space:nowrap;font-size:.78rem;padding:.42rem .62rem}

.docs-shell{display:block}
.docs-nav{position:sticky;top:0;z-index:30;height:auto;padding:.5rem .9rem;border-inline-end:0;
border-bottom:1px solid var(--glass-line);
-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}
.docs-nav .nav-links{margin:0 -.9rem;padding:0 .9rem}

.site-nav{padding:.75rem .75rem 0}
.site-links{gap:.4rem}
.site-links a:not(.btn){display:none}
.hero{padding:3rem 1.25rem 2.5rem}
.band{padding:3.25rem 1.25rem}
}

/*
 * Narrow content.
 *
 * A second breakpoint because the two concerns are genuinely different. The navigation has to
 * change as soon as a 16rem rail stops earning its column, which is around 880px. Content does
 * not: a 768px tablet has a perfectly good 46rem of width for two panels side by side, and
 * stacking them there trades density for nothing. So anything that is about *density* rather
 * than *navigation* lives here, at the width where a phone actually is a phone.
 */
@media (max-width:600px){
/*
 * Stat cards go two-up here: one column wastes the width and quadruples the scroll, and three
 * would break a seven-figure amount onto extra lines. Their floor drops to 9rem to make that
 * happen. Panels are left alone — .grid-2 uses minmax(15rem,1fr) and collapses to a single
 * column by itself, at exactly the width where two of them stop fitting, which is sooner than
 * this breakpoint and sooner than a stat card needs to stack.
 */
.grid-3,.grid-4{grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem}
.stat{padding:.85rem .9rem;border-radius:16px}
.stat-label{font-size:.68rem;margin-bottom:.35rem}
.stat-value{font-size:1.3rem;letter-spacing:-.01em}
.stat-value small{font-size:.66rem}
.stat-sub{font-size:.67rem;margin-top:.3rem}
.panel{padding:1rem}

/* A form that shares a line with its button gets the whole line first, so the field is not
   fighting the button for width. */
.top{gap:.75rem;margin-bottom:1.35rem}
.top h1{font-size:1.3rem}
.top form{width:100%}
.top form>*{min-width:0}
.top-actions{width:100%}

/*
 * A panel header stacks.
 *
 * Side by side, the title and the action buttons split the row, and the actions — three of
 * them, in a nowrap row — end up with a third of the panel, which is not enough for two of
 * them to share a line. They then wrap one per line and the header doubles in height. Given
 * the whole row, they sit on one line again.
 */
.panel-head{flex-wrap:wrap;align-items:flex-start;row-gap:.6rem}
.panel-head>*:not(h2){flex:1 1 100%}

/* Denser tables. Every column kept is a column the reader does not have to scroll to. */
thead th{padding:.5rem .45rem;font-size:.66rem}
tbody td{padding:.6rem .45rem}
table{font-size:.78rem}

.main{padding-block:1.15rem 3.5rem;
padding-inline:max(1rem,env(safe-area-inset-right)) max(1rem,env(safe-area-inset-left))}
.docs-body{padding:1.75rem 1rem 3.5rem}
}

/* Very narrow phones. Below this the account name costs more than it is worth: the brand
   already says which panel this is, and the row has to hold the queue count and the exit. */
@media (max-width:400px){
.nav-account-name{display:none}
.main{padding-inline:max(.8rem,env(safe-area-inset-right)) max(.8rem,env(safe-area-inset-left))}
.grid-3,.grid-4{grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.6rem}
.stat{padding:.7rem .75rem}
.stat-value{font-size:1.15rem}
.top h1{font-size:1.18rem}
.table-wrap{margin:0 -.8rem;padding:0 .8rem}
}
`;

/**
 * Inline script, served as an external asset (see scripts/build-assets.mjs) because the
 * CSP is `script-src 'self'` — an inline block would be blocked by the browser with no
 * server-side symptom.
 *
 * It does six things, all small and dependency-free: copy to clipboard, run the
 * countdown from a server-provided absolute instant, poll the payment status, reveal
 * one-time secrets, animate scroll reveals, and drive the amount forge on the landing
 * page. Nothing here decides anything about money.
 */
export const CLIENT_JS = `
(function(){
'use strict';
var reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function fa(n){var d='۰۱۲۳۴۵۶۷۸۹';return String(n).replace(/[0-9]/g,function(c){return d[+c]})}
function en(s){var d='۰۱۲۳۴۵۶۷۸۹';return String(s).replace(/[۰-۹]/g,function(c){return String(d.indexOf(c))})}
function tens(n){return String(n).padStart(2,'0')}
function group(s){return String(s).replace(/\\B(?=(\\d{3})+(?!\\d))/g,'٬')}

/* --- clipboard ---------------------------------------------------------- */
/*
 * Two shapes of copy target, and the difference is not cosmetic.
 *
 * A small button carries its own label, so the label IS its text and swapping textContent
 * is fine. The payment page's card and amount are whole click targets though — the thing to
 * tap is the card, because that is what the customer is looking at — and replacing the text
 * of one of those would delete the card number it just copied. When the target contains an
 * element marked data-copy-label, only that element's text is swapped.
 */
function copy(text,btn){
  var inner=btn.querySelector('[data-copy-label]');
  var done=function(){
    if(inner){
      if(!inner.getAttribute('data-label'))inner.setAttribute('data-label',inner.textContent);
      btn.setAttribute('data-copied','1');
      inner.textContent='کپی شد ✓';
      setTimeout(function(){
        btn.removeAttribute('data-copied');
        inner.textContent=inner.getAttribute('data-label');
      },1800);
      return;
    }
    var label=btn.getAttribute('data-label')||btn.textContent;
    if(!btn.getAttribute('data-label'))btn.setAttribute('data-label',label);
    btn.setAttribute('data-copied','1');
    btn.textContent='کپی شد';
    setTimeout(function(){btn.removeAttribute('data-copied');btn.textContent=btn.getAttribute('data-label')},1600);
  };
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done).catch(function(){legacy(text,done)});
  } else { legacy(text,done) }
}
function legacy(text,done){
  var ta=document.createElement('textarea');
  ta.value=text;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.opacity='0';
  document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy');done()}catch(e){}
  document.body.removeChild(ta);
}

/* --- one delegated listener for every interactive affordance ------------ */
document.addEventListener('click',function(event){
  var target=event.target;
  if(!(target instanceof Element))return;

  /*
   * A code block copies its own rendered text rather than carrying a copy of it in an
   * attribute. The attribute would have to be escaped separately from the markup, and
   * the two would drift: a reader would copy a command the page does not show.
   */
  var codeBtn=target.closest('[data-copy-code]');
  if(codeBtn){
    event.preventDefault();
    var block=codeBtn.closest('.code');
    var pre=block?block.querySelector('.code-body'):null;
    if(pre)copy(pre.textContent,codeBtn);
    return
  }

  var btn=target.closest('[data-copy]');
  if(btn){event.preventDefault();copy(btn.getAttribute('data-copy'),btn);return}

  var dismiss=target.closest('[data-secret-dismiss]');
  if(dismiss){
    var secret=document.querySelector('[data-secret-once]');
    if(secret)secret.setAttribute('hidden','');
    dismiss.setAttribute('hidden','');
    return;
  }

  /* Reveal a password. The two icons are both in the markup and CSS picks one off
     aria-pressed, so this only flips the attribute, the input type and the words a
     screen reader reads out — the state a sighted user sees and the state announced
     to everyone else cannot drift apart. */
  var pw=target.closest('[data-pw-toggle]');
  if(pw){
    var pwInput=document.getElementById(pw.getAttribute('data-pw-toggle'));
    if(pwInput){
      var revealed=pwInput.getAttribute('type')==='text';
      pwInput.setAttribute('type',revealed?'password':'text');
      pw.setAttribute('aria-pressed',revealed?'false':'true');
      var pwLabel=revealed?'نمایش گذرواژه':'پنهان‌کردن گذرواژه';
      pw.setAttribute('aria-label',pwLabel);
      pw.setAttribute('title',pwLabel);
    }
    return;
  }

  // Docs navigation: jump to a section without losing the sticky offset.
  var jump=target.closest('[data-jump]');
  if(jump){
    var el=document.getElementById(jump.getAttribute('data-jump'));
    if(el){event.preventDefault();el.scrollIntoView({behavior:reduced?'auto':'smooth',block:'start'});
      history.replaceState(null,'','#'+el.id)}
  }
});

/* --- countdown ---------------------------------------------------------- */
/* Reads the server-provided absolute expiry, not a duration, so a reload or a
   skewed client clock cannot restart the timer. */
var timer=document.querySelector('[data-expires-at]');
if(timer){
  var expires=new Date(timer.getAttribute('data-expires-at')).getTime();
  var out=timer.querySelector('[data-countdown]');
  var fill=timer.querySelector('[data-timer-fill]');
  /* The total the window was opened with, so the bar shows how much of the deadline is
     LEFT rather than counting down from an assumed duration. */
  var total=Number(timer.getAttribute('data-total-ms')||0);
  var tone=function(left){
    if(left<120000)return 'urgent';
    if(left<300000)return 'soon';
    return 'ok';
  };
  var tick=function(){
    var left=expires-Date.now();
    if(left<=0){
      if(out)out.textContent='۰۰:۰۰';
      if(fill)fill.style.width='0%';
      timer.setAttribute('data-tone','expired');
      if(!timer.hasAttribute('data-expired')){
        timer.setAttribute('data-expired','1');
        setTimeout(function(){location.reload()},1200);
      }
      return;
    }
    var s=Math.floor(left/1000);
    if(out)out.textContent=fa(tens(Math.floor(s/60))+':'+tens(s%60));
    if(left<120000&&out)out.setAttribute('data-urgent','1');
    /* The fill is the deadline, and it is what makes a two-minute warning land: a number
       reads as information, a bar that is nearly gone reads as a reason to hurry. */
    if(fill&&total>0)fill.style.width=(Math.max(0,Math.min(100,(left/total)*100))).toFixed(2)+'%';
    timer.setAttribute('data-tone',tone(left));
  };
  tick();setInterval(tick,1000);
}

/* --- status polling: stops as soon as the state is final ---------------- */
var poll=document.querySelector('[data-poll-url]');
if(poll){
  var url=poll.getAttribute('data-poll-url');
  var terminal=['paid','expired','cancelled','failed','refunded'];
  var attempts=0;
  var handle=setInterval(function(){
    attempts++;
    if(attempts>180){clearInterval(handle);return}
    if(document.hidden)return;
    fetch(url,{headers:{accept:'application/json'},cache:'no-store'})
      .then(function(r){return r.ok?r.json():null})
      .then(function(data){
        if(!data)return;
        var status=String(data.status||'').toLowerCase();
        if(terminal.indexOf(status)>=0){location.reload()}
      })
      .catch(function(){});
  },5000);
}

/* --- scroll reveal ----------------------------------------------------- */
var reveals=document.querySelectorAll('.reveal');
if(reveals.length){
  if(reduced||!('IntersectionObserver' in window)){
    for(var i=0;i<reveals.length;i++)reveals[i].setAttribute('data-shown','1');
  } else {
    var io=new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if(entry.isIntersecting){
          var delay=entry.target.getAttribute('data-delay')||'0';
          entry.target.style.animationDelay=delay+'ms';
          entry.target.setAttribute('data-shown','1');
          io.unobserve(entry.target);
        }
      });
    },{rootMargin:'0px 0px -12% 0px',threshold:.08});
    for(var j=0;j<reveals.length;j++)io.observe(reveals[j]);
  }
}

/* --- the amount forge: the landing page's one moving part -------------- */
/* It shows the algorithm, not random noise: the base is the merchant's amount
   plus the fee, and the suffix is appended on top. The digits are the only thing
   that changes, because they are the only thing the reader should be watching. */
var forge=document.querySelector('[data-forge]');
if(forge&&!reduced){
  var base=362000;
  var outs={
    amount:forge.querySelector('[data-forge-amount]'),
    rial:forge.querySelector('[data-forge-rial]'),
    suffix:forge.querySelector('[data-forge-suffix]'),
    total:forge.querySelector('[data-forge-total]')
  };
  var cycle=function(){
    var suffix=1000+Math.floor(Math.random()*9000);
    var total=base+suffix;
    if(outs.amount)outs.amount.textContent=group(fa(total));
    if(outs.rial)outs.rial.textContent=group(fa(total*10))+' ریال';
    if(outs.suffix)outs.suffix.textContent=fa(suffix)+' تومان';
    if(outs.total)outs.total.textContent=group(fa(total))+' تومان';
  };
  cycle();
  setInterval(cycle,3400);
}
})();
`;
