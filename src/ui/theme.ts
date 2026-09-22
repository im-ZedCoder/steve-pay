/**
 * Design system.
 *
 * ===========================================================================
 * THE DESIGN THESIS — "signal in the dark"
 * ===========================================================================
 *
 * This is a console for money that arrives on its own. The subject is not a
 * dashboard; it is a machine that listens to bank SMS messages and decides, in
 * the dark, whether money arrived. Everything below is derived from that.
 *
 * ATMOSPHERE. The base is not black and not flat. `void` carries real blue, and
 * the page is lit by two cold sources — an ultramarine glow high-left and a cyan
 * one high-right — so surfaces sit in a lit room rather than a void. Panels are
 * layered strata with a hairline seam and a top-edge highlight, which is what
 * makes them read as glass over a lit substrate without paying for a blur.
 *
 * THE SIGNAL. One electric blue (`signal`) is the interactive register, and it
 * behaves like a live signal rather than a brand colour: it traces along the top
 * edge of important surfaces, travels, and glows at its midpoint. `arc` (cyan) is
 * reserved for *data in motion* — traces, sparklines, the sweep on an amount
 * plate. Two blues with two jobs, never used interchangeably.
 *
 * MONEY IS THE ONLY OTHER COLOUR. Every non-blue hue in this system means an
 * amount of money and nothing else. `owed` is money the customer still owes and
 * time still running. `settled` is money that arrived and is confirmed. `failed`
 * is money that did not arrive or was refused. This was true of the previous
 * system and it is the single most valuable thing about it: a colour on screen
 * always answers the question a merchant is actually asking. Nothing is tinted
 * for decoration, so nothing has to be decoded.
 *
 * TYPE. Vazirmatn carries Persian, and it is used with intent — 700 at display
 * size with negative tracking for headings, 400 for prose, and tabular figures
 * everywhere a number can change, because the exact figure is the thing a human
 * verifies digit by digit. IBM Plex Mono carries the machine register: identifiers,
 * eyebrow labels, keys, and code. Mono labels in wide-tracked Latin are the
 * structural device of this interface — a mono label above a Persian heading marks
 * the boundary between what the machine knows and what the person is being told,
 * and it is the reason the layout reads as instrumentation rather than marketing.
 *
 * TWO STYLESHEETS, SPLIT BY WEIGHT. The payment page is opened on a phone, often
 * on a bad connection, by someone who needs exactly one number to be legible. It
 * must not pay for dashboard chrome. `PAY_CSS` is standalone and small; `APP_CSS`
 * carries the dashboard, docs and landing on top of it.
 */

export const TOKENS = {
  // --- surfaces: layered strata, all carrying blue ---------------------------
  /** Page base. Deepest layer, and still visibly blue rather than black. */
  void: '#04060E',
  /** First lift: cards inside panels, table hovers. */
  strata: '#080D1B',
  /** Panel base, the workhorse surface. */
  strata2: '#0C1428',
  /** Raised: inputs, code blocks, active nav. */
  strata3: '#111B36',
  /** Every border. A seam, not a line. */
  seam: '#1B2A55',
  seamSoft: '#131F3F',

  // --- type ------------------------------------------------------------------
  /** Primary text. Cool white with a blue cast, never pure #fff. */
  ice: '#E8F0FF',
  /** Secondary: labels, supporting copy. */
  steel: '#94A6D0',
  /** Tertiary: metadata, timestamps, hints. */
  haze: '#64739E',

  // --- the signal -----------------------------------------------------------
  /** Interactive register: links, focus, primary action. */
  signal: '#3D7BFF',
  signalDim: '#2A5BD7',
  /** Glow and emphasis within the signal register. */
  beam: '#8FBBFF',
  /** Data in motion: traces, sparklines, the plate sweep. Cyan, never chrome. */
  arc: '#35D6FF',

  // --- money, and only money ------------------------------------------------
  /** Money owed, time running out. */
  owed: '#FFB424',
  /** Money arrived and confirmed. */
  settled: '#2EE0A2',
  /** Money failed, refused, or disputed. */
  failed: '#FF6070',
} as const;

/**
 * Font stacks. Both faces are self-hosted; see scripts/sync-fonts.mjs.
 *
 * No web font is fetched from a third party. A payment page that calls out to a
 * font CDN leaks its visitors to that CDN and fails closed on a filtered network,
 * which in this market is not a hypothetical.
 */
export const FONT_STACK = {
  ui: "'Vazirmatn', system-ui, -apple-system, 'Segoe UI', sans-serif",
  code: "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
} as const;

const ARABIC_RANGE = 'U+0600-06FF,U+0750-077F,U+FB50-FDFF,U+FE70-FEFF,U+200C-200D';
const LATIN_RANGE = 'U+0000-00FF,U+0131,U+0152-0153,U+2000-206F';

/**
 * Payment page faces: two Persian weights plus one mono.
 *
 * The payment page declares exactly the faces it uses. Regular and bold cover the
 * body and the amount; Plex Mono 400 is there for the two Latin-digit strings the
 * customer must read carefully — the invoice id and the bank card number — where
 * tabular alignment across a break actually matters. Nothing else ships.
 */
const FONT_FACES_PAY = `
@font-face{font-family:'Vazirmatn';src:url('/fonts/vazirmatn-arabic-400.woff2')format('woff2');
font-weight:400;font-display:swap;unicode-range:${ARABIC_RANGE}}
@font-face{font-family:'Vazirmatn';src:url('/fonts/vazirmatn-arabic-700.woff2')format('woff2');
font-weight:700;font-display:swap;unicode-range:${ARABIC_RANGE}}
@font-face{font-family:'IBM Plex Mono';src:url('/fonts/plex-mono-400.woff2')format('woff2');
font-weight:400;font-display:swap}
`;

/** Dashboard, docs and landing: the 500 weight, Latin coverage and mono 500. */
const FONT_FACES_APP = `
@font-face{font-family:'Vazirmatn';src:url('/fonts/vazirmatn-arabic-500.woff2')format('woff2');
font-weight:500;font-display:swap;unicode-range:${ARABIC_RANGE}}
@font-face{font-family:'Vazirmatn';src:url('/fonts/vazirmatn-latin-400.woff2')format('woff2');
font-weight:400;font-display:swap;unicode-range:${LATIN_RANGE}}
@font-face{font-family:'Vazirmatn';src:url('/fonts/vazirmatn-latin-700.woff2')format('woff2');
font-weight:700;font-display:swap;unicode-range:${LATIN_RANGE}}
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

--radius:13px;--radius-lg:18px;--radius-sm:9px;
--mono:${FONT_STACK.code};
}
`;

const RESET = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
/* The room the interface sits in: two cold light sources over a blue-black base,
   fixed so the page does not appear to relight as it scrolls. */
body{margin:0;color:var(--ice);font-family:${FONT_STACK.ui};line-height:1.85;font-weight:400;
-webkit-font-smoothing:antialiased;
background:
radial-gradient(85% 55% at 10% -8%,rgba(61,123,255,.17),transparent 62%),
radial-gradient(65% 42% at 96% -4%,rgba(53,214,255,.09),transparent 58%),
var(--void);
background-attachment:fixed}
img,svg{max-width:100%;display:block}
button,input,select,textarea{font:inherit;color:inherit}
a{color:var(--beam);text-decoration:none}
a:hover{color:var(--ice);text-decoration:underline;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--signal);outline-offset:2px;border-radius:5px}
::selection{background:rgba(61,123,255,.35)}
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
 * The structural device: a mono Latin label in wide tracking that sits above a
 * Persian heading. It marks the boundary between machine vocabulary and human
 * language, and it is what makes a section read as instrumentation.
 */
const EYEBROW = `
.eyebrow{font-family:${FONT_STACK.code};font-size:.68rem;font-weight:500;letter-spacing:.16em;
text-transform:uppercase;color:var(--haze);margin:0 0 .6rem;display:flex;align-items:center;gap:.55rem}
.eyebrow::before{content:'';width:.5rem;height:1px;background:var(--signal);flex:none}
.eyebrow em{font-style:normal;color:var(--signal)}
`;

/** Motion shared by every surface. Everything here is gated off by reduced-motion. */
const MOTION = `
@keyframes sweep{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}
@keyframes trace{0%{background-position:0% 50%}100%{background-position:200% 50%}}
@keyframes glow{0%,100%{opacity:.45}50%{opacity:1}}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes pulse{50%{opacity:.5}}
@keyframes spin{to{transform:rotate(360deg)}}
.trace{height:1px;background:var(--seam-soft);position:relative;overflow:hidden}
.trace::after{content:'';position:absolute;inset:0;width:38%;
background:linear-gradient(90deg,transparent,var(--arc),var(--beam),transparent);
animation:sweep 4s cubic-bezier(.4,0,.6,1) infinite}
.trace-live{height:2px;border-radius:2px;background:linear-gradient(90deg,transparent,var(--signal),var(--arc),var(--signal),transparent);
background-size:200% 100%;animation:trace 3.2s linear infinite}
.reveal{opacity:0}
.reveal[data-shown='1']{animation:rise .55s cubic-bezier(.2,.7,.3,1) forwards}
@media (prefers-reduced-motion:reduce){
*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
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
export const PAY_CSS = `${TOKEN_VARS}${FONT_FACES_PAY}${RESET}${EYEBROW}${MOTION}
/* --- page frame --------------------------------------------------------- */
.pay-wrap{min-height:100dvh;display:flex;flex-direction:column;align-items:center;
justify-content:center;padding:1.5rem 1rem 2.5rem;gap:.875rem;position:relative}
.pay-card{width:100%;max-width:27rem;border-radius:var(--radius-lg);padding:1.5rem 1.25rem 1.375rem;
position:relative;overflow:hidden;
background:linear-gradient(180deg,rgba(17,27,54,.86),rgba(8,13,27,.95));
border:1px solid var(--seam);
box-shadow:inset 0 1px 0 rgba(143,187,255,.07),0 30px 70px -34px rgba(0,0,0,.95),
0 0 0 1px rgba(4,6,14,.6)}
/* The trace: the state colour runs the full width of the top edge and is lit by a
   travelling highlight, so a card in motion looks like a circuit that is live.
   This is decoration that carries information — its colour is the payment state. */
.pay-card::before{content:'';position:absolute;inset:0 0 auto 0;height:2px;
background:linear-gradient(90deg,transparent,var(--state,var(--signal)) 22%,var(--state,var(--signal)) 78%,transparent)}
.pay-card::after{content:'';position:absolute;top:0;left:0;width:30%;height:2px;
background:linear-gradient(90deg,transparent,var(--beam),transparent);animation:sweep 3.6s linear infinite}

.pay-head{display:flex;align-items:center;gap:.75rem;padding-bottom:1rem;border-bottom:1px solid var(--seam-soft)}
.pay-logo{width:2.75rem;height:2.75rem;border-radius:12px;flex:none;overflow:hidden;
display:grid;place-items:center;font-weight:700;font-size:1.05rem;color:var(--beam);
background:linear-gradient(160deg,rgba(61,123,255,.22),rgba(53,214,255,.08));
border:1px solid rgba(143,187,255,.28);box-shadow:0 0 22px -10px var(--signal)}
.pay-logo img{width:100%;height:100%;object-fit:cover}
.pay-merchant{font-weight:700;font-size:1rem;line-height:1.5;letter-spacing:-.01em}
.pay-meta{color:var(--haze);font-size:.72rem;line-height:1.7;margin-top:.1rem}
.pay-desc{margin:1.125rem 0 0;font-size:.93rem;color:var(--ice);word-break:break-word;line-height:1.95}
.pay-label{font-size:.75rem;color:var(--haze);margin:0 0 .45rem;display:block}

/* --- the amount plate: the signature element ---------------------------- */
/* The exact figure is the thing a human verifies digit by digit, so it is set
   large, in tabular figures, on an engraved plate with a single slow sweep. The
   scanline is why the number reads as a reading rather than as a headline. */
.plate{margin-top:1.25rem;padding:1.25rem 1rem;border-radius:var(--radius);position:relative;overflow:hidden;
background:radial-gradient(130% 140% at 100% 0%,rgba(61,123,255,.16),transparent 58%),
linear-gradient(180deg,var(--strata-3),var(--strata));
border:1px solid rgba(143,187,255,.2)}
.plate::after{content:'';position:absolute;top:0;bottom:0;width:34%;pointer-events:none;
background:linear-gradient(90deg,transparent,rgba(53,214,255,.09),transparent);
animation:sweep 5.5s linear infinite}
.plate-amount{display:flex;align-items:baseline;gap:.45rem;justify-content:center;flex-wrap:wrap;position:relative}
.plate-value{font-size:2.4rem;font-weight:700;letter-spacing:-.02em;line-height:1.22;color:var(--ice);
font-variant-numeric:tabular-nums;text-shadow:0 0 30px rgba(61,123,255,.45)}
.plate-unit{font-size:.92rem;color:var(--steel);font-weight:500}
.plate-rial{display:flex;justify-content:center;gap:.35rem;font-size:.78rem;color:var(--haze);
padding-top:.5rem;border-top:1px dashed var(--seam);margin-top:.8rem;
font-family:${FONT_STACK.code};position:relative}
.plate-warning{display:flex;gap:.45rem;align-items:flex-start;font-size:.73rem;color:var(--owed);
margin-top:.8rem;line-height:1.8;padding:0 .1rem}

/* --- bank card ---------------------------------------------------------- */
.card-row{margin-top:1.25rem}
.card-line{display:flex;align-items:center;gap:.625rem;padding:.75rem .875rem;border-radius:var(--radius);
border:1px solid var(--seam);background:var(--strata)}
.card-digits{flex:1;min-width:0;font-size:1.04rem;letter-spacing:.09em;direction:ltr;text-align:left;
font-family:${FONT_STACK.code};color:var(--ice)}
.card-holder{font-size:.71rem;color:var(--haze);margin-top:.45rem;display:flex;gap:.5rem;flex-wrap:wrap}

/* --- controls ----------------------------------------------------------- */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;cursor:pointer;
border-radius:var(--radius-sm);padding:.5rem .8rem;font-size:.78rem;white-space:nowrap;
border:1px solid var(--seam);background:var(--strata-3);color:var(--ice);
transition:background .14s ease,border-color .14s ease,box-shadow .14s ease,transform .1s ease}
.btn:hover{background:#16224A;border-color:rgba(143,187,255,.34);text-decoration:none}
.btn:active{transform:translateY(1px)}
.btn[data-copied='1']{border-color:var(--settled);color:var(--settled);box-shadow:0 0 0 3px rgba(46,224,162,.12)}
.btn-primary{background:linear-gradient(180deg,var(--signal),var(--signal-dim));border-color:rgba(143,187,255,.42);
color:#fff;font-weight:600;box-shadow:0 0 0 1px rgba(61,123,255,.3),0 10px 26px -12px rgba(61,123,255,.9)}
.btn-primary:hover{background:linear-gradient(180deg,#4E88FF,#2F63E4);box-shadow:0 0 0 1px rgba(143,187,255,.6),0 14px 30px -12px rgba(61,123,255,1)}
.btn-block{width:100%;padding:.8rem 1rem;font-size:.9rem;margin-top:1.25rem}
.copy-amount{margin-top:.875rem;width:100%}

/* --- countdown: owed money, finite time --------------------------------- */
.countdown{margin-top:1.25rem;display:flex;align-items:baseline;justify-content:space-between;gap:.75rem;
padding-top:1rem;border-top:1px solid var(--seam-soft)}
.countdown-value{font-size:1.6rem;font-weight:700;color:var(--owed);letter-spacing:.04em;
font-variant-numeric:tabular-nums;text-shadow:0 0 26px rgba(255,180,36,.3)}
.countdown-value[data-urgent='1']{animation:pulse 1.5s ease-in-out infinite}
.countdown-label{font-size:.75rem;color:var(--haze)}

/* --- the instruction note ---------------------------------------------- */
.pay-note{margin-top:1.25rem;padding:.875rem 1rem;border-radius:var(--radius);font-size:.81rem;
color:var(--steel);line-height:1.95;white-space:pre-wrap;word-break:break-word;
background:var(--strata);border:1px solid var(--seam);border-inline-start:2px solid var(--signal)}
.pay-status{margin-top:1.25rem;display:flex;align-items:center;gap:.6rem;font-size:.84rem;
padding:.7rem .875rem;border-radius:var(--radius);border:1px solid var(--seam);background:var(--strata)}
.dot{width:.5rem;height:.5rem;border-radius:50%;flex:none;background:var(--state,var(--signal));
box-shadow:0 0 0 3px color-mix(in srgb,var(--state,var(--signal)) 18%,transparent)}
.pay-foot{margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--seam-soft);
display:flex;align-items:center;justify-content:space-between;gap:.75rem;font-size:.71rem;
color:var(--haze);flex-wrap:wrap}
.pay-brand{display:flex;align-items:center;gap:.45rem;font-weight:600;color:var(--steel);
font-family:${FONT_STACK.code};letter-spacing:.04em}
.pay-brand i{width:.45rem;height:.45rem;border-radius:50%;background:var(--signal);display:inline-block;
box-shadow:0 0 10px var(--signal);animation:glow 2.6s ease-in-out infinite}

/* --- the bank slip: the bank's own words, redacted --------------------- */
.slip{margin-top:1.25rem;border:1px solid var(--seam);border-radius:var(--radius);overflow:hidden;background:var(--strata)}
.slip-head{display:flex;align-items:center;gap:.5rem;padding:.6rem .875rem;border-bottom:1px solid var(--seam-soft);
font-size:.75rem;color:var(--steel);font-weight:500}
.slip-head span{margin-inline-start:auto;font-weight:400;color:var(--haze);letter-spacing:0}
.slip-body{padding:.875rem;font-size:.79rem;line-height:2.1;color:var(--steel);white-space:pre-wrap;
word-break:break-word;background:var(--void)}
.slip-body mark{background:rgba(46,224,162,.13);color:var(--settled);padding:.05rem .3rem;border-radius:4px;
font-variant-numeric:tabular-nums}
.slip-foot{padding:.6rem .875rem;border-top:1px solid var(--seam-soft);font-size:.69rem;color:var(--haze)}
.receipt-rows{margin:1.25rem 0 0;display:grid;gap:.625rem}
.receipt-row{display:flex;justify-content:space-between;gap:1rem;font-size:.81rem;padding-bottom:.625rem;
border-bottom:1px solid var(--seam-soft)}
.receipt-row dt{color:var(--haze);margin:0}
.receipt-row dd{margin:0;text-align:left;font-weight:500}
/* A flex item's automatic minimum size is its min-content width, and a Jalali timestamp
   (۱۴۰۵/۰۶/۳۱ - ۰۶:۲۴) has no break opportunity in it — so a receipt row in a narrow column
   pushed its panel wider than the grid track and the whole page sideways. min-width:0 lets the
   item shrink, and anywhere lets the timestamp itself break when it still cannot fit. */
.receipt-row dt,.receipt-row dd{min-width:0}
.receipt-row dd{overflow-wrap:break-word}
.receipt-row:last-child{border-bottom:0;padding-bottom:0}
.state-success{--state:var(--settled)}
.state-pending{--state:var(--owed)}
.state-failed{--state:var(--failed)}
.state-review{--state:var(--signal)}
.test-flag{margin-top:1rem;padding:.6rem .8rem;border-radius:var(--radius-sm);text-align:center;
font-size:.78rem;font-weight:500;
background:rgba(61,123,255,.12);border:1px solid rgba(143,187,255,.34);color:var(--beam)}
@media (max-width:380px){.plate-value{font-size:1.95rem}.pay-card{padding:1.25rem 1rem}}
`;

/**
 * Application stylesheet: everything in PAY_CSS plus the shell, the operator
 * surfaces, the landing page and the docs.
 *
 * Layered on the payment base rather than duplicating it, so a token change can
 * never land on one surface and miss the other.
 */
export const APP_CSS = `${PAY_CSS}${FONT_FACES_APP}

/* =========================================================================
   SHELL — rail + main
   ========================================================================= */
.shell{display:grid;grid-template-columns:16rem 1fr;min-height:100dvh;position:relative;z-index:1}
/*
 * The two wrappers below exist only for the narrow layout: they give the brand and the nav
 * groups their own rows there. On a wide screen they are made transparent, so the rail's
 * children sit directly in it exactly as they did before, so the rail's bottom-anchored
 * account cluster keeps its margin-top:auto.
 */
.nav-top,.nav-links{display:contents}
.nav-account{display:none}
/* RTL: the rail sits on the right, where a Persian reader begins. Written as a
   grid column rather than float/rTL tricks so reading order and visual order agree. */
.nav{position:sticky;top:0;height:100dvh;overflow-y:auto;display:flex;flex-direction:column;gap:1.1rem;
padding:1.15rem .8rem 1rem;
background:linear-gradient(180deg,rgba(11,18,37,.9),rgba(6,10,21,.94));
border-inline-start:1px solid var(--seam)}
.nav-brand{display:flex;align-items:center;gap:.6rem;padding:.15rem .5rem .9rem;
border-bottom:1px solid var(--seam-soft)}
.nav-brand b{font-size:.98rem;letter-spacing:-.01em}
.nav-brand i{width:.45rem;height:.45rem;border-radius:50%;background:var(--signal);flex:none;
box-shadow:0 0 12px var(--signal);animation:glow 2.6s ease-in-out infinite}
.nav-brand span{font-size:.7rem;color:var(--haze);display:block;margin-top:-.1rem}
.nav-group{display:flex;flex-direction:column;gap:.1rem}
.nav-group h2{font-size:.7rem;font-weight:500;color:var(--haze);padding:0 .6rem;margin:.75rem 0 .3rem}
.nav-link{display:flex;align-items:center;gap:.55rem;padding:.5rem .6rem;border-radius:var(--radius-sm);
color:var(--steel);font-size:.83rem;border:1px solid transparent;position:relative;
transition:background .14s ease,color .14s ease}
.nav-link:hover{background:var(--strata-2);color:var(--ice);text-decoration:none}
.nav-link[aria-current='page']{background:linear-gradient(90deg,rgba(61,123,255,.16),rgba(61,123,255,.03));
color:var(--ice);border-color:rgba(143,187,255,.26);font-weight:600}
/* The active rail: a lit edge on the reading start side. It marks position, which
   is the one thing a sparse rail cannot otherwise communicate. */
.nav-link[aria-current='page']::before{content:'';position:absolute;inset-block:.35rem;inset-inline-start:-.35rem;
width:2px;border-radius:2px;background:var(--signal);box-shadow:0 0 12px var(--signal)}
.nav-foot{margin-top:auto;padding-top:1rem;border-top:1px solid var(--seam-soft);font-size:.71rem;color:var(--haze);display:grid;gap:.4rem}
.nav-foot .btn{font-size:.68rem;padding:.25rem .5rem;justify-self:start}
.nav-foot a{color:var(--haze)}
.main{padding:1.5rem 1.75rem 4rem;min-width:0}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap}
.top>*{min-width:0}
.top h1{font-size:1.32rem;margin:0;font-weight:700;letter-spacing:-.015em}
.top p{margin:.35rem 0 0;color:var(--steel);font-size:.82rem}
/*
 * The vertical-rhythm container, and the third place this same trap appears.
 *
 * An implicit grid column is auto, and an auto track is sized to max-content — so one panel
 * holding a single unbreakable token (an invoice id in a heading, a bank SMS) widened its track
 * past the column, stretched every sibling to match, and pushed the whole page sideways. Naming
 * the column minmax(0,1fr) lets the track shrink and hands the overflow to whatever is supposed
 * to contain it. Same shape of bug as the shell grid and the receipt row: a minimum size that
 * defaults to "as wide as the content says" instead of zero.
 */
.stack{display:grid;gap:1rem;grid-template-columns:minmax(0,1fr)}
.grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1rem}
.grid-3{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:1rem}
.grid-4{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.875rem}
/* A 1fr track is really minmax(auto,1fr), and that auto refuses to shrink below the
   content's min-content width. So one panel holding a single long unbroken token — an invoice
   id, a raw bank message, a webhook URL — was enough to widen its track past the viewport and
   shove the panel beside it off the left edge of the screen. min-width:0 is what lets a track
   shrink and hand the overflow to the element that is supposed to scroll. */
.grid-2>*,.grid-3>*,.grid-4>*{min-width:0}

/* =========================================================================
   PANELS — glass strata
   ========================================================================= */
/* min-width:0 for the same reason as the grids: a panel is usually a grid or flex item, and
   its automatic minimum size is its min-content width, which one unbreakable token inflates. */
.panel{border-radius:var(--radius);padding:1.1rem 1.2rem;position:relative;min-width:0;
background:linear-gradient(180deg,rgba(17,27,54,.66),rgba(12,20,40,.9));
border:1px solid var(--seam);
box-shadow:inset 0 1px 0 rgba(143,187,255,.06),0 18px 40px -30px rgba(0,0,0,.9)}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:.9rem;
min-width:0}
.panel-head h2{margin:0;font-size:.93rem;font-weight:600;letter-spacing:-.01em}
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
   STATS
   ========================================================================= */
.stat{border-radius:var(--radius);padding:1rem 1.05rem;position:relative;overflow:hidden;
background:linear-gradient(180deg,rgba(17,27,54,.6),rgba(12,20,40,.88));border:1px solid var(--seam)}
.stat::before{content:'';position:absolute;inset:0 0 auto 0;height:1px;
background:linear-gradient(90deg,transparent,var(--signal),transparent);opacity:.5}
/* No letter-spacing and no uppercase on anything that carries Persian.
   Persian is a connected script: tracking inserts a gap after every letter and the word
   visibly comes apart ("پ ر د ا خ ت"). Latin labels keep their wide tracking — that contrast
   is the structural device — but a Persian label is set as Persian is written. */
.stat-label{font-size:.72rem;color:var(--haze);margin:0 0 .5rem}
.stat-value{font-size:1.5rem;font-weight:700;letter-spacing:-.02em;line-height:1.3;
font-variant-numeric:tabular-nums;color:var(--ice)}
.stat-value small{font-size:.71rem;color:var(--steel);font-weight:400;margin-inline-start:.3rem}
.stat-sub{font-size:.71rem;color:var(--haze);margin:.45rem 0 0}
.stat-amber .stat-value{color:var(--owed);text-shadow:0 0 26px rgba(255,180,36,.22)}
.stat-settle .stat-value{color:var(--settled);text-shadow:0 0 26px rgba(46,224,162,.22)}
.stat-reject .stat-value{color:var(--failed);text-shadow:0 0 26px rgba(255,96,112,.22)}

/* =========================================================================
   TABLES
   ========================================================================= */
table{width:100%;border-collapse:collapse;font-size:.81rem}
thead th{text-align:right;font-weight:500;font-size:.72rem;
color:var(--haze);padding:.5rem .6rem;border-bottom:1px solid var(--seam);white-space:nowrap}
tbody td{padding:.66rem .6rem;border-bottom:1px solid var(--seam-soft);vertical-align:middle}
tbody tr{transition:background .12s ease}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:rgba(17,27,54,.6)}
.table-wrap{overflow-x:auto;margin:0 -1.2rem;padding:0 1.2rem}
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
.badge{display:inline-flex;align-items:center;gap:.35rem;padding:.18rem .55rem;border-radius:999px;
font-size:.7rem;font-weight:500;white-space:nowrap;
border:1px solid var(--seam);background:var(--strata);color:var(--steel)}
.badge i{width:.36rem;height:.36rem;border-radius:50%;background:currentColor;flex:none;
box-shadow:0 0 8px currentColor}
.badge-paid,.badge-active,.badge-delivered,.badge-connected{color:var(--settled);border-color:rgba(46,224,162,.34);
background:rgba(46,224,162,.08)}
.badge-pending,.badge-open,.badge-in_progress{color:var(--owed);border-color:rgba(255,180,36,.34);
background:rgba(255,180,36,.08)}
.badge-expired,.badge-failed,.badge-dead,.badge-cancelled,.badge-suspended,.badge-banned,.badge-rejected{
color:var(--failed);border-color:rgba(255,96,112,.34);background:rgba(255,96,112,.08)}
.badge-review,.badge-manual_review,.badge-waiting_for_admin,.badge-waiting_for_user{
color:var(--beam);border-color:rgba(143,187,255,.38);background:rgba(61,123,255,.1)}

/* =========================================================================
   THE PIPELINE SPINE
   Structure as information: a stage is lit only when that stage actually
   happened, read from the database. The connector between lit stages is drawn
   as a signal line rather than a divider, because that is what it represents.
   ========================================================================= */
.spine{display:flex;align-items:center;gap:.375rem;flex-wrap:wrap}
.spine-node{display:flex;align-items:center;gap:.4rem;padding:.33rem .6rem;border-radius:999px;
border:1px solid var(--seam);background:var(--strata);font-size:.72rem;
color:var(--haze)}
.spine-node[data-state='done']{color:var(--settled);border-color:rgba(46,224,162,.34);background:rgba(46,224,162,.07)}
.spine-node[data-state='current']{color:var(--owed);border-color:rgba(255,180,36,.38);background:rgba(255,180,36,.07)}
.spine-node[data-state='blocked']{color:var(--failed);border-color:rgba(255,96,112,.34);background:rgba(255,96,112,.07)}
.spine-node b{font-weight:500}
.spine-sep{width:.9rem;height:1px;background:linear-gradient(90deg,var(--seam),var(--seam-soft));flex:none}

/* =========================================================================
   FORMS
   ========================================================================= */
.form{display:grid;gap:1rem;max-width:34rem}
.field{display:grid;gap:.375rem}
.field label{font-size:.77rem;color:var(--steel);font-weight:500}
.field .hint{font-size:.7rem;color:var(--haze);line-height:1.8}
.input,select.input,textarea.input{width:100%;padding:.625rem .75rem;border-radius:var(--radius-sm);
border:1px solid var(--seam);background:var(--strata);font-size:.85rem;color:var(--ice);
transition:border-color .14s ease,box-shadow .14s ease}
.input:hover{border-color:#243463}
.input:focus{border-color:var(--signal);outline:none;box-shadow:0 0 0 3px rgba(61,123,255,.16)}
.input::placeholder{color:#4C5880}
textarea.input{min-height:6rem;resize:vertical;line-height:1.9}
select.input{appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--haze) 50%),
linear-gradient(135deg,var(--haze) 50%,transparent 50%);
background-position:calc(0% + .9rem) 1.1rem,calc(0% + 1.15rem) 1.1rem;
background-size:.25rem .25rem,.25rem .25rem;background-repeat:no-repeat}
.field-error{font-size:.72rem;color:var(--failed)}

/* =========================================================================
   ALERTS
   ========================================================================= */
.alert{padding:.75rem 1rem;border-radius:var(--radius);font-size:.8rem;line-height:1.9;
border:1px solid var(--seam);background:var(--strata);border-inline-start-width:2px}
.alert-error{border-color:rgba(255,96,112,.36);border-inline-start-color:var(--failed);
background:linear-gradient(90deg,rgba(255,96,112,.09),rgba(255,96,112,.02));color:#FFD3D8}
.alert-success{border-color:rgba(46,224,162,.36);border-inline-start-color:var(--settled);
background:linear-gradient(90deg,rgba(46,224,162,.09),rgba(46,224,162,.02));color:#C4F5E2}
.alert-info{border-color:rgba(61,123,255,.36);border-inline-start-color:var(--signal);
background:linear-gradient(90deg,rgba(61,123,255,.1),rgba(61,123,255,.02));color:#D3E0FF}
.alert-warn{border-color:rgba(255,180,36,.36);border-inline-start-color:var(--owed);
background:linear-gradient(90deg,rgba(255,180,36,.09),rgba(255,180,36,.02));color:#FFE4B8}

/* =========================================================================
   ONE-TIME SECRET REVEAL
   ========================================================================= */
.key-reveal{font-family:${FONT_STACK.code};font-size:.79rem;word-break:break-all;padding:.875rem 1rem;
border-radius:var(--radius);color:var(--ice);display:flex;gap:.6rem;align-items:center;
justify-content:space-between;flex-wrap:wrap;
background:linear-gradient(180deg,rgba(61,123,255,.14),rgba(61,123,255,.05));
border:1px dashed rgba(143,187,255,.5);box-shadow:0 0 34px -18px var(--signal) inset}
/* A checklist row: state chip, then the step and its next action, packed from the reading
   start. The action sits beside its step rather than at the far end of a wide panel — a
   button 900px away from the thing it acts on reads as a different control. */
.setup-step{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap;padding:.55rem .7rem;
border-radius:var(--radius-sm);background:var(--strata-2);border:1px solid var(--seam-soft)}
.setup-step-body{flex:1 1 12rem;min-width:0;font-size:.83rem}
.empty{text-align:center;padding:2.75rem 1rem;color:var(--steel)}
.empty h3{margin:0 0 .5rem;font-size:.98rem;color:var(--ice);font-weight:600}
.empty p{margin:0 0 1.1rem;font-size:.82rem;line-height:1.95}
.spark{display:flex;align-items:flex-end;gap:3px;height:3.5rem}
.spark i{flex:1;border-radius:3px 3px 0 0;min-height:3px;
background:linear-gradient(180deg,var(--arc),rgba(61,123,255,.35))}
.spark i[data-zero='1']{background:var(--seam)}
.bar-row{display:flex;align-items:center;gap:.6rem;font-size:.75rem}
.bar-row .bar{flex:1;height:.45rem;border-radius:999px;background:var(--strata-3);overflow:hidden}
.bar-row .bar span{display:block;height:100%;border-radius:999px;
background:linear-gradient(90deg,var(--signal),var(--arc))}


/* =========================================================================
   SUPPORT CONVERSATION
   ========================================================================= */
.chat{display:grid;gap:.75rem;max-height:26rem;overflow-y:auto;padding:.25rem}
.msg{max-width:78%;padding:.65rem .875rem;border-radius:var(--radius);font-size:.82rem;line-height:1.95;
border:1px solid var(--seam);background:var(--strata);word-break:break-word;white-space:pre-wrap}
.msg[data-mine='1']{margin-inline-start:auto;border-color:rgba(143,187,255,.26);
background:linear-gradient(180deg,rgba(61,123,255,.16),rgba(61,123,255,.07))}
.msg-meta{font-size:.67rem;color:var(--haze);margin-top:.35rem;font-family:${FONT_STACK.code}}

/* =========================================================================
   LANDING
   ========================================================================= */
.site-nav{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:1rem;
padding:.85rem 1.5rem;backdrop-filter:blur(10px);
background:linear-gradient(180deg,rgba(4,6,14,.88),rgba(4,6,14,.62));
border-bottom:1px solid var(--seam-soft)}
.site-brand{display:flex;align-items:center;gap:.55rem;font-weight:700;letter-spacing:-.01em;color:var(--ice)}
.site-brand i{width:.5rem;height:.5rem;border-radius:50%;background:var(--signal);flex:none;
box-shadow:0 0 14px var(--signal);animation:glow 2.6s ease-in-out infinite}
.site-brand span{font-family:${FONT_STACK.code};font-size:.58rem;letter-spacing:.18em;text-transform:uppercase;
color:var(--haze);display:block;margin-top:-.2rem;font-weight:500}
.site-links{display:flex;align-items:center;gap:1.25rem;margin-inline-start:auto}
.site-links a{font-size:.81rem;color:var(--steel)}
.site-links a:hover{color:var(--ice);text-decoration:none}
.wrap{max-width:72rem;margin:0 auto;padding:0 1.5rem}

/* The hero's own light: a single wide bloom behind the headline, plus the
   perspective field. The bloom is what makes the top of the page feel lit from
   behind rather than tinted. */
.hero{position:relative;overflow:hidden;padding:5rem 1.5rem 4rem}
.hero-glow{position:absolute;top:-14rem;inset-inline-start:50%;transform:translateX(50%);
width:52rem;height:36rem;pointer-events:none;
background:radial-gradient(50% 50% at 50% 50%,rgba(61,123,255,.22),rgba(53,214,255,.07) 55%,transparent 72%)}
.grid-field{position:absolute;inset:0;pointer-events:none;opacity:.5}
.grid-field::before{content:'';position:absolute;inset:0;
background-image:linear-gradient(rgba(27,42,85,.5) 1px,transparent 1px),
linear-gradient(90deg,rgba(27,42,85,.5) 1px,transparent 1px);
background-size:58px 58px;
-webkit-mask-image:radial-gradient(70% 55% at 50% 25%,#000,transparent 78%);
mask-image:radial-gradient(70% 55% at 50% 25%,#000,transparent 78%)}
.hero-inner{position:relative;max-width:74rem;margin:0 auto;
display:grid;grid-template-columns:1.05fr .95fr;gap:3rem;align-items:center}
.hero-title{font-size:clamp(2rem,5vw,3.15rem);line-height:1.28;margin:0;font-weight:700;letter-spacing:-.03em}
.hero-title em{font-style:normal;position:relative;
background:linear-gradient(180deg,var(--beam),var(--signal));
-webkit-background-clip:text;background-clip:text;color:transparent}
.hero-lede{margin:1.15rem 0 0;font-size:1rem;line-height:2.05;color:var(--steel);max-width:34rem}
.hero-actions{display:flex;gap:.7rem;margin-top:1.85rem;flex-wrap:wrap}
.btn-lg{padding:.75rem 1.35rem;font-size:.88rem;border-radius:11px}
.hero-facts{list-style:none;margin:2.25rem 0 0;padding:0;display:flex;gap:1.75rem;flex-wrap:wrap}
.hero-facts li{display:grid;gap:.1rem}
.hero-facts b{font-size:1.3rem;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.hero-facts span{font-size:.73rem;color:var(--haze)}
/* Latin-only tracking. Used where a label mixes scripts: the Latin half keeps the wide,
   tracked instrument look and the Persian half is left as written. */
.tracked{font-family:${FONT_STACK.code};letter-spacing:.14em;text-transform:uppercase;font-size:.68rem}

/* The forged amount: the product's own artifact, shown at the top of the page
   because it is the most characteristic thing this system produces. The digits
   change; everything around them holds still. */
.forge{border-radius:var(--radius-lg);padding:1.35rem 1.3rem 1.25rem;position:relative;overflow:hidden;
background:linear-gradient(180deg,rgba(17,27,54,.8),rgba(8,13,27,.94));
border:1px solid rgba(143,187,255,.24);
box-shadow:inset 0 1px 0 rgba(143,187,255,.08),0 40px 80px -40px rgba(0,0,0,.95),
0 0 60px -30px rgba(61,123,255,.5)}
.forge::before{content:'';position:absolute;inset:0 0 auto 0;height:1px;
background:linear-gradient(90deg,transparent,var(--arc),transparent);animation:trace 4s linear infinite;
background-size:200% 100%}
.forge::after{content:'';position:absolute;top:0;bottom:0;width:30%;pointer-events:none;
background:linear-gradient(90deg,transparent,rgba(53,214,255,.07),transparent);animation:sweep 6s linear infinite}
.forge-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;
font-size:.72rem;color:var(--haze)}
.forge-head .tracked{font-size:.62rem}
.forge-amount{display:flex;align-items:baseline;gap:.45rem;justify-content:center;
margin:1.1rem 0 .35rem;position:relative}
.forge-amount b{font-size:clamp(1.9rem,4.6vw,2.6rem);font-weight:700;letter-spacing:-.02em;
font-variant-numeric:tabular-nums;text-shadow:0 0 38px rgba(61,123,255,.5)}
.forge-amount span{font-size:.9rem;color:var(--steel)}
.forge-rial{text-align:center;font-family:${FONT_STACK.code};font-size:.72rem;color:var(--haze);
padding-top:.6rem;border-top:1px dashed var(--seam)}
.forge-rows{margin:1.1rem 0 0;display:grid;gap:.5rem;position:relative}
.forge-rows div{display:flex;justify-content:space-between;gap:1rem;font-size:.76rem;
padding-bottom:.5rem;border-bottom:1px solid var(--seam-soft);color:var(--steel)}
.forge-rows div:last-child{border-bottom:0;padding-bottom:0}
.forge-rows b{color:var(--ice);font-weight:500;font-variant-numeric:tabular-nums}
.forge-rows .ok{color:var(--settled)}
.forge-rows .wait{color:var(--owed)}

/* Bands: the page's sections. The title row is a two-column arrangement so the
   heading and its supporting paragraph never fight for the same line. */
.band{padding:4rem 1.5rem;position:relative}
.band-alt{background:linear-gradient(180deg,rgba(8,13,27,.7),rgba(4,6,14,0))}
.band-head{max-width:74rem;margin:0 auto 2.25rem;display:grid;grid-template-columns:1fr 1fr;
gap:2rem;align-items:end}
.band-head h2{margin:0;font-size:clamp(1.4rem,2.6vw,1.95rem);font-weight:700;letter-spacing:-.025em;line-height:1.4}
.band-head p{margin:0;color:var(--steel);font-size:.9rem;line-height:2.05}
.band-body{max-width:74rem;margin:0 auto}

/* The pipeline, numbered because it genuinely is a sequence with an order the
   reader must understand — money moves through these stages in this order. */
.steps{margin:0;padding:0;list-style:none;display:grid;gap:1px;background:var(--seam-soft);
border:1px solid var(--seam);border-radius:var(--radius-lg);overflow:hidden}
.step{display:grid;grid-template-columns:3.5rem 1fr;gap:1.25rem;align-items:start;
padding:1.35rem 1.4rem;background:linear-gradient(180deg,rgba(12,20,40,.94),rgba(8,13,27,.94))}
.step-num{font-family:${FONT_STACK.code};font-size:.78rem;font-weight:500;color:var(--signal);
padding-top:.15rem;letter-spacing:.04em}
.step h3{margin:0 0 .4rem;font-size:.98rem;font-weight:600;letter-spacing:-.01em}
.step p{margin:0;font-size:.85rem;line-height:2;color:var(--steel)}
.step code{font-family:${FONT_STACK.code};font-size:.78rem;color:var(--arc);
background:rgba(53,214,255,.08);padding:.08rem .35rem;border-radius:5px;direction:ltr;display:inline-block}

.split{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;align-items:start}
/* Code surface: a terminal window, because the audience for this section is
   about to paste it into one. */
.code{border:1px solid var(--seam);border-radius:var(--radius);overflow:hidden;background:var(--void)}
.code-bar{display:flex;align-items:center;gap:.5rem;padding:.55rem .85rem;border-bottom:1px solid var(--seam-soft);
background:var(--strata);font-family:${FONT_STACK.code};font-size:.65rem;letter-spacing:.1em;
text-transform:uppercase;color:var(--haze)}
.code-bar b{margin-inline-start:auto;font-weight:500;color:var(--steel);text-transform:none;letter-spacing:0}
.code-body{margin:0;padding:.9rem 1rem;font-family:${FONT_STACK.code};font-size:.75rem;line-height:2.05;
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
background:var(--seam-soft);border:1px solid var(--seam);border-radius:var(--radius-lg);overflow:hidden}
.fact{padding:1.35rem 1.3rem;background:linear-gradient(180deg,rgba(12,20,40,.94),rgba(8,13,27,.94))}
.fact b{display:block;font-size:1.5rem;font-weight:700;letter-spacing:-.025em;font-variant-numeric:tabular-nums;
color:var(--ice)}
.fact b em{font-style:normal;font-size:.8rem;color:var(--haze);font-weight:400;margin-inline-start:.25rem}
.fact span{display:block;margin-top:.4rem;font-size:.8rem;color:var(--steel);line-height:1.95}
.fact code{font-family:${FONT_STACK.code};font-size:.75rem;color:var(--arc)}

.site-foot{border-top:1px solid var(--seam-soft);padding:2.25rem 1.5rem;margin-top:2rem;
background:linear-gradient(180deg,rgba(8,13,27,.5),rgba(4,6,14,0))}
.site-foot-inner{max-width:74rem;margin:0 auto;display:flex;gap:1.5rem;align-items:flex-start;
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
border-inline-start:1px solid var(--seam);background:linear-gradient(180deg,rgba(11,18,37,.7),rgba(6,10,21,.8))}
.docs-body{max-width:52rem;margin:0 auto;padding:2rem 1.75rem 5rem;min-width:0}
.docs-head h1{font-size:1.85rem;margin:0 0 .6rem;font-weight:700;letter-spacing:-.03em}
.docs-head p{margin:0;color:var(--steel);font-size:.92rem;line-height:2.1;max-width:42rem}
.docs-section{margin-top:3rem;scroll-margin-top:1.5rem}
.docs-section > h2{font-size:1.25rem;margin:0 0 .35rem;font-weight:700;letter-spacing:-.02em;
display:flex;align-items:center;gap:.7rem}
.docs-section > h2::after{content:'';flex:1;height:1px;background:var(--seam-soft)}
.docs-section > p{color:var(--steel);font-size:.87rem;line-height:2.1}
.docs-section h3{font-size:.95rem;margin:1.75rem 0 .5rem;font-weight:600;color:var(--ice)}
.docs-section ul,.docs-section ol{color:var(--steel);font-size:.86rem;line-height:2.1;padding-inline-start:1.2rem}
.docs-section li{margin-bottom:.3rem}
.docs-section code{font-family:${FONT_STACK.code};font-size:.78rem;color:var(--arc);
background:rgba(53,214,255,.08);padding:.1rem .35rem;border-radius:5px}
.docs-section strong{color:var(--ice);font-weight:600}
.docs-section a{color:var(--beam)}
.docs-note{padding:.8rem 1rem;border-radius:var(--radius);margin:1.1rem 0;font-size:.82rem;line-height:2;
background:var(--strata);border:1px solid var(--seam);border-inline-start:2px solid var(--signal);color:var(--steel)}
.docs-note b{color:var(--ice);font-weight:600}
/* Endpoint headers: the method is the most useful thing to scan for, so it leads
   and carries its own colour. Semantics match HTTP, not the palette. */
.ep{display:flex;align-items:center;gap:.7rem;margin:1.1rem 0 .6rem;flex-wrap:wrap}
.ep-method{font-family:${FONT_STACK.code};font-size:.68rem;font-weight:500;letter-spacing:.08em;
padding:.22rem .5rem;border-radius:6px;border:1px solid transparent}
.ep-get{color:var(--arc);background:rgba(53,214,255,.1);border-color:rgba(53,214,255,.3)}
.ep-post{color:var(--settled);background:rgba(46,224,162,.1);border-color:rgba(46,224,162,.3)}
.ep-del{color:var(--failed);background:rgba(255,96,112,.1);border-color:rgba(255,96,112,.3)}
.ep-path{font-family:${FONT_STACK.code};font-size:.82rem;color:var(--ice);direction:ltr}
.docs-table{margin:1rem 0}
.docs-nav .nav-group h2{margin-top:1.15rem}

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
background:linear-gradient(180deg,rgba(8,13,28,.96),rgba(6,10,21,.88));
-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
border-inline-start:0;border-bottom:1px solid var(--seam)}
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
-webkit-mask-image:linear-gradient(to left,#000 calc(100% - 1.9rem),transparent);
mask-image:linear-gradient(to left,#000 calc(100% - 1.9rem),transparent)}
.nav-links::-webkit-scrollbar{display:none}
.nav-group{flex:none;flex-direction:row;gap:.3rem}
.nav-group h2{display:none}
.nav-link{flex:none;white-space:nowrap;font-size:.78rem;padding:.42rem .62rem}

.docs-shell{display:block}
.docs-nav{position:sticky;top:0;z-index:30;height:auto;padding:.5rem .9rem;border-inline-start:0;
border-bottom:1px solid var(--seam);
-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}
.docs-nav .nav-links{margin:0 -.9rem;padding:0 .9rem}

.site-links a:not(.btn){display:none}
.hero{padding:3rem 1.25rem 2.5rem}
.band{padding:2.75rem 1.25rem}
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
.stat{padding:.8rem .85rem}
.stat-label{font-size:.68rem;margin-bottom:.35rem}
.stat-value{font-size:1.22rem;letter-spacing:-.01em}
.stat-value small{font-size:.65rem}
.stat-sub{font-size:.67rem;margin-top:.3rem}

/* A form that shares a line with its button gets the whole line first, so the field is not
   fighting the button for width. */
.top{gap:.75rem;margin-bottom:1.2rem}
.top h1{font-size:1.2rem}
.top form{width:100%}
.top form>*{min-width:0}

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

/* Denser tables. Every column kept is a column the reader does not have to scroll to, and the
   faint fade at the scrolling edge is the only hint that there are more of them. */
thead th{padding:.45rem .45rem;font-size:.69rem}
tbody td{padding:.55rem .45rem}
table{font-size:.78rem}

.main{padding-block:1.15rem 3.5rem;
padding-inline:max(1rem,env(safe-area-inset-right)) max(1rem,env(safe-area-inset-left))}
.docs-body{padding:1.5rem 1rem 3.5rem}
}

/* Very narrow phones. Below this the account name costs more than it is worth: the brand
   already says which panel this is, and the row has to hold the queue count and the exit. */
@media (max-width:400px){
.nav-account-name{display:none}
.main{padding-inline:max(.8rem,env(safe-area-inset-right)) max(.8rem,env(safe-area-inset-left))}
.grid-3,.grid-4{grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.6rem}
.stat{padding:.7rem .75rem}
.stat-value{font-size:1.1rem}
.top h1{font-size:1.12rem}
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
function copy(text,btn){
  var done=function(){
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

  var btn=target.closest('[data-copy]');
  if(btn){event.preventDefault();copy(btn.getAttribute('data-copy'),btn);return}

  var dismiss=target.closest('[data-secret-dismiss]');
  if(dismiss){
    var secret=document.querySelector('[data-secret-once]');
    if(secret)secret.setAttribute('hidden','');
    dismiss.setAttribute('hidden','');
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
  var tick=function(){
    var left=expires-Date.now();
    if(left<=0){
      if(out)out.textContent='۰۰:۰۰';
      if(!timer.hasAttribute('data-expired')){
        timer.setAttribute('data-expired','1');
        setTimeout(function(){location.reload()},1200);
      }
      return;
    }
    var s=Math.floor(left/1000);
    if(out)out.textContent=fa(tens(Math.floor(s/60))+':'+tens(s%60));
    if(left<120000&&out)out.setAttribute('data-urgent','1');
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
