/**
 * Design system.
 *
 * Two stylesheets, deliberately split by page weight. The payment page is opened by
 * a customer on a phone who may be on a slow connection and who needs exactly one
 * number to be legible; it should not pay for dashboard chrome. So `PAY_CSS` is
 * standalone, self-contained and small, and `APP_CSS` carries the dashboard on top
 * of it.
 *
 * THE DESIGN THESIS, since a token list alone does not explain itself:
 *
 *   Colour is money. The interface is cool, blue-black and desaturated — every
 *   accent hue in the palette is reserved for a financial state and appears nowhere
 *   else. Amber means money is owed and time is running out. Green means money
 *   arrived and is confirmed. The signal blue is interactive chrome, not emphasis.
 *   Nothing is tinted for decoration, so a colour on a screen always means
 *   something.
 *
 *   The base is not black. `ink` carries real blue in it, which reads as banking
 *   infrastructure rather than a media player, and it gives the glass panels
 *   something to sit on rather than a void.
 *
 *   Money is an instrument, not a headline. Amounts are set in tabular figures at
 *   display size because the exact figure is the thing a human must verify
 *   digit-by-digit, not a marketing number to admire.
 */

export const TOKENS = {
  // --- surfaces ------------------------------------------------------------
  ink: '#060915', // page base: blue-black, not neutral black
  inkRaised: '#0A1020',
  basalt: '#0D1224', // panel base under glass
  basaltStrong: '#131A31',
  hairline: '#1E2745', // every border and rule
  hairlineSoft: '#161E38',

  // --- type ----------------------------------------------------------------
  glacier: '#E8EDFB', // primary text: cool white, not #FFF
  muted: '#93A0C4',
  faint: '#6B7899',

  // --- the only three accents, each with a single meaning -------------------
  signal: '#4C7DFF', // interactive chrome: links, focus, primary action
  signalDeep: '#2B54D6',
  /** Money owed, time running out. Nowhere else. */
  amber: '#FFB020',
  /** Money arrived, confirmed. Nowhere else. */
  settle: '#35D69B',
  /** Money failed, was rejected, or is disputed. Nowhere else. */
  reject: '#FF6B6B',
} as const;

/** Font stacks. Both faces are self-hosted; see scripts/sync-fonts.mjs. */
export const FONT_STACK = {
  /** Persian UI text and Persian digits. */
  ui: "'Vazirmatn', system-ui, -apple-system, 'Segoe UI', sans-serif",
  /** Latin identifiers: API keys, invoice ids, curl samples, card digests. */
  code: "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
} as const;

/**
 * Font faces.
 *
 * Vazirmatn ships as static weights, so the weight set is a budget decision, not a
 * byproduct. The payment page declares exactly two Persian faces — regular and bold,
 * ~43 KB together — and nothing else. Two weights are also all the page's typography
 * needs: body copy at 400, the amount and the countdown at 700, and hierarchy comes
 * from size and colour rather than from a run of intermediate weights that would each
 * cost another 21 KB on a phone on a bad connection.
 *
 * Latin text on this page (the brand mark, a support email) falls through to
 * `system-ui`, which costs zero bytes and is correct: the customer is not reading a
 * brand book, they are reading an amount.
 */
const ARABIC_RANGE = 'U+0600-06FF,U+0750-077F,U+FB50-FDFF,U+FE70-FEFF,U+200C-200D';
const LATIN_RANGE = 'U+0000-00FF,U+0131,U+0152-0153,U+2000-206F';

const FONT_FACES_PAY = `
@font-face{font-family:'Vazirmatn';src:url('/fonts/vazirmatn-arabic-400.woff2')format('woff2');
font-weight:400;font-display:swap;unicode-range:${ARABIC_RANGE}}
@font-face{font-family:'Vazirmatn';src:url('/fonts/vazirmatn-arabic-700.woff2')format('woff2');
font-weight:700;font-display:swap;unicode-range:${ARABIC_RANGE}}
`;

/** Dashboard additions: the 500 weight, plus the Latin and mono faces for data. */
const FONT_FACES_APP = `
@font-face{font-family:'Vazirmatn';src:url('/fonts/vazirmatn-arabic-500.woff2')format('woff2');
font-weight:500;font-display:swap;unicode-range:${ARABIC_RANGE}}
@font-face{font-family:'Vazirmatn';src:url('/fonts/vazirmatn-latin-400.woff2')format('woff2');
font-weight:400;font-display:swap;unicode-range:${LATIN_RANGE}}
@font-face{font-family:'Vazirmatn';src:url('/fonts/vazirmatn-latin-700.woff2')format('woff2');
font-weight:700;font-display:swap;unicode-range:${LATIN_RANGE}}
@font-face{font-family:'IBM Plex Mono';src:url('/fonts/plex-mono-400.woff2')format('woff2');
font-weight:400;font-display:swap}
@font-face{font-family:'IBM Plex Mono';src:url('/fonts/plex-mono-500.woff2')format('woff2');
font-weight:500;font-display:swap}
`;

const RESET = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ink);color:var(--glacier);font-family:${FONT_STACK.ui};
line-height:1.85;font-weight:400;-webkit-font-smoothing:antialiased}
img,svg{max-width:100%;display:block}
button,input,select,textarea{font:inherit;color:inherit}
a{color:var(--signal);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--signal);outline-offset:2px;border-radius:4px}
/* Persian numerals and amounts must never reflow as they change. */
.num{font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1}
.mono{font-family:${FONT_STACK.code};font-variant-ligatures:none}
.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;

const TOKEN_VARS = `
:root{
--ink:${TOKENS.ink};--ink-raised:${TOKENS.inkRaised};--basalt:${TOKENS.basalt};
--basalt-strong:${TOKENS.basaltStrong};--hairline:${TOKENS.hairline};--hairline-soft:${TOKENS.hairlineSoft};
--glacier:${TOKENS.glacier};--muted:${TOKENS.muted};--faint:${TOKENS.faint};
--signal:${TOKENS.signal};--signal-deep:${TOKENS.signalDeep};
--amber:${TOKENS.amber};--settle:${TOKENS.settle};--reject:${TOKENS.reject};
--radius:14px;--radius-lg:20px;
}
`;

/**
 * Payment page stylesheet.
 *
 * Ordered so specificity never has to fight itself: tokens, then base, then the one
 * component, then its states. There is exactly one section-level class and it is
 * never combined with an element selector to override a margin — the rule that
 * prevents the classic "my padding disappeared" bug in a hand-written stylesheet.
 */
export const PAY_CSS = `${TOKEN_VARS}${FONT_FACES_PAY}${RESET}
.pay-wrap{min-height:100dvh;display:flex;flex-direction:column;align-items:center;
justify-content:center;padding:1.25rem 1rem 2.5rem;gap:1rem}
.pay-card{width:100%;max-width:26rem;background:linear-gradient(180deg,rgba(19,26,49,.92),rgba(13,18,36,.96));
border:1px solid var(--hairline);border-radius:var(--radius-lg);padding:1.5rem 1.25rem 1.375rem;
box-shadow:0 1px 0 rgba(255,255,255,.03) inset,0 24px 60px -30px rgba(0,0,0,.9);position:relative;overflow:hidden}
/* The single decorative move on the page: a hairline of the state colour, so the
   status is legible at a glance before any text is read. It is information. */
.pay-card::before{content:'';position:absolute;inset:0 0 auto 0;height:2px;background:var(--state,var(--signal))}
.pay-head{display:flex;align-items:center;gap:.75rem;padding-bottom:1rem;border-bottom:1px solid var(--hairline-soft)}
.pay-logo{width:2.75rem;height:2.75rem;border-radius:11px;background:var(--ink-raised);
border:1px solid var(--hairline);display:grid;place-items:center;font-weight:700;font-size:1.05rem;
color:var(--signal);flex:none;overflow:hidden}
.pay-logo img{width:100%;height:100%;object-fit:cover}
.pay-merchant{font-weight:600;font-size:.98rem;line-height:1.5}
.pay-meta{color:var(--faint);font-size:.75rem;line-height:1.6;margin-top:.1rem}
.pay-desc{margin:1.125rem 0 0;font-size:.94rem;color:var(--glacier);word-break:break-word}
.pay-label{font-size:.72rem;color:var(--faint);letter-spacing:.02em;margin:0 0 .4rem}

/* The amount plate: the one memorable element, and the one number that has to be
   right. Tabular figures so the digits align; the Rial figure sits beneath as a
   subordinate line so nobody has to guess which unit they are reading. */
.plate{margin-top:1.25rem;padding:1.125rem 1rem;border-radius:var(--radius);
background:radial-gradient(120% 150% at 100% 0%,rgba(76,125,255,.10),transparent 60%),var(--ink-raised);
border:1px solid var(--hairline)}
.plate-amount{display:flex;align-items:baseline;gap:.4rem;justify-content:center;flex-wrap:wrap}
.plate-value{font-size:2.35rem;font-weight:700;letter-spacing:-.015em;line-height:1.25;color:var(--glacier)}
.plate-unit{font-size:.95rem;color:var(--muted);font-weight:500}
.plate-rial{display:flex;justify-content:center;gap:.35rem;font-size:.8rem;color:var(--faint);
padding-top:.4rem;border-top:1px dashed var(--hairline-soft);margin-top:.75rem}
.plate-warning{display:flex;gap:.4rem;align-items:flex-start;font-size:.74rem;color:var(--amber);
margin-top:.75rem;line-height:1.75}

/* Card row: the second thing the customer needs, with the copy affordance inline. */
.card-row{margin-top:1.25rem}
.card-line{display:flex;align-items:center;gap:.625rem;padding:.75rem .875rem;border:1px solid var(--hairline);
border-radius:var(--radius);background:var(--ink-raised)}
.card-digits{flex:1;min-width:0;font-size:1.02rem;letter-spacing:.06em;direction:ltr;text-align:left}
.card-holder{font-size:.72rem;color:var(--faint);margin-top:.4rem;display:flex;gap:.5rem;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;border:1px solid var(--hairline);
background:var(--basalt-strong);color:var(--glacier);border-radius:10px;padding:.5rem .8rem;
font-size:.78rem;cursor:pointer;transition:background .12s ease,border-color .12s ease;white-space:nowrap}
.btn:hover{background:#18204160;border-color:#2a3560}
.btn:active{transform:translateY(1px)}
.btn[data-copied='1']{border-color:var(--settle);color:var(--settle)}
.btn-primary{background:var(--signal-deep);border-color:var(--signal);color:#fff;font-weight:600}
.btn-primary:hover{background:var(--signal)}
.btn-block{width:100%;padding:.8rem 1rem;font-size:.9rem;margin-top:1.25rem}
.copy-amount{margin-top:.875rem;width:100%}

/* Countdown: amber by definition — money is owed and time is finite. */
.countdown{margin-top:1.25rem;display:flex;align-items:baseline;justify-content:space-between;gap:.75rem;
padding-top:1rem;border-top:1px solid var(--hairline-soft)}
.countdown-value{font-size:1.5rem;font-weight:700;color:var(--amber);letter-spacing:.02em}
.countdown-value[data-urgent='1']{animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{opacity:.55}}
.countdown-label{font-size:.75rem;color:var(--faint)}

.pay-note{margin-top:1.25rem;padding:.875rem 1rem;border-radius:var(--radius);background:var(--ink-raised);
border:1px solid var(--hairline);border-left:3px solid var(--signal);font-size:.82rem;color:var(--muted);
line-height:1.9;white-space:pre-wrap;word-break:break-word}

.pay-status{margin-top:1.25rem;display:flex;align-items:center;gap:.6rem;font-size:.85rem;
padding:.7rem .875rem;border-radius:var(--radius);border:1px solid var(--hairline);background:var(--ink-raised)}
.dot{width:.5rem;height:.5rem;border-radius:50%;flex:none;background:var(--state,var(--signal))}
.pay-foot{margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--hairline-soft);
display:flex;align-items:center;justify-content:space-between;gap:.75rem;font-size:.73rem;color:var(--faint);flex-wrap:wrap}
.pay-brand{display:flex;align-items:center;gap:.4rem;font-weight:600;color:var(--muted)}
.pay-brand i{width:.45rem;height:.45rem;border-radius:50%;background:var(--signal);display:inline-block}

/* The bank slip: the confirmation shows the bank's own words, redacted. */
.slip{margin-top:1.25rem;border:1px solid var(--hairline);border-radius:var(--radius);overflow:hidden;background:var(--ink-raised)}
.slip-head{display:flex;align-items:center;gap:.5rem;padding:.6rem .875rem;border-bottom:1px solid var(--hairline-soft);
font-size:.73rem;color:var(--muted);font-weight:600}
.slip-head span{margin-inline-start:auto;font-weight:400;color:var(--faint)}
.slip-body{padding:.875rem;font-size:.8rem;line-height:2;color:var(--muted);white-space:pre-wrap;
word-break:break-word;background:var(--basalt)}
.slip-body mark{background:rgba(53,214,155,.14);color:var(--settle);padding:.05rem .3rem;border-radius:4px;
font-variant-numeric:tabular-nums}
.slip-foot{padding:.6rem .875rem;border-top:1px solid var(--hairline-soft);font-size:.7rem;color:var(--faint)}
.receipt-rows{margin:1.25rem 0 0;display:grid;gap:.625rem}
.receipt-row{display:flex;justify-content:space-between;gap:1rem;font-size:.82rem;padding-bottom:.625rem;
border-bottom:1px solid var(--hairline-soft)}
.receipt-row dt{color:var(--faint);margin:0}
.receipt-row dd{margin:0;text-align:left;font-weight:500}
.receipt-row:last-child{border-bottom:0;padding-bottom:0}
.state-success{--state:var(--settle)}
.state-pending{--state:var(--amber)}
.state-failed{--state:var(--reject)}
.state-review{--state:var(--signal)}
.test-flag{margin-top:1rem;padding:.6rem .8rem;border-radius:10px;background:rgba(76,125,255,.1);
border:1px solid var(--signal);color:var(--signal);font-size:.74rem;font-weight:600;text-align:center}
@media (max-width:380px){.plate-value{font-size:1.95rem}.pay-card{padding:1.25rem 1rem}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

/**
 * Dashboard stylesheet. Everything in PAY_CSS plus the shell.
 *
 * The dashboard sits on top of a shared base rather than duplicating it, so a token
 * change cannot land in one surface and miss the other.
 */
export const APP_CSS = `${PAY_CSS}${FONT_FACES_APP}

.shell{display:grid;grid-template-columns:15.5rem 1fr;min-height:100dvh}
/* RTL: the navigation rail sits on the right, which is where a Persian reader
   starts. Writing this as grid-template-columns rather than float/rTL hacks keeps
   the reading order and the visual order the same. */
.nav{border-inline-start:1px solid var(--hairline);background:var(--ink-raised);padding:1.25rem .875rem;
display:flex;flex-direction:column;gap:1.25rem;position:sticky;top:0;height:100dvh;overflow-y:auto}
.nav-brand{display:flex;align-items:center;gap:.6rem;padding:0 .5rem}
.nav-brand b{font-size:1rem}
.nav-brand i{width:.5rem;height:.5rem;border-radius:50%;background:var(--signal);box-shadow:0 0 12px var(--signal)}
.nav-group{display:flex;flex-direction:column;gap:.125rem}
.nav-group h2{font-size:.68rem;color:var(--faint);font-weight:600;letter-spacing:.03em;
padding:0 .6rem;margin:.4rem 0 .35rem}
.nav-link{display:flex;align-items:center;gap:.55rem;padding:.5rem .6rem;border-radius:9px;color:var(--muted);
font-size:.83rem;border:1px solid transparent}
.nav-link:hover{background:var(--basalt);color:var(--glacier);text-decoration:none}
.nav-link[aria-current='page']{background:var(--basalt-strong);color:var(--glacier);
border-color:var(--hairline);font-weight:600}
.nav-foot{margin-top:auto;padding-top:1rem;border-top:1px solid var(--hairline-soft);font-size:.72rem;color:var(--faint)}
.main{padding:1.5rem 1.75rem 4rem;min-width:0}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap}
.top h1{font-size:1.35rem;margin:0;font-weight:700;letter-spacing:-.01em}
.top p{margin:.3rem 0 0;color:var(--muted);font-size:.83rem}
.stack{display:grid;gap:1rem}
.grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1rem}
.grid-3{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:1rem}
.grid-4{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.875rem}

.panel{background:var(--basalt);border:1px solid var(--hairline);border-radius:var(--radius);padding:1.125rem 1.25rem}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-bottom:.875rem}
.panel-head h2{margin:0;font-size:.95rem;font-weight:600}
.panel-head a{font-size:.75rem}
.stat{padding:1rem 1.125rem;border-radius:var(--radius);border:1px solid var(--hairline);background:var(--basalt)}
.stat-label{font-size:.72rem;color:var(--faint);margin:0 0 .45rem}
.stat-value{font-size:1.5rem;font-weight:700;letter-spacing:-.01em;line-height:1.35;font-variant-numeric:tabular-nums}
.stat-value small{font-size:.72rem;color:var(--muted);font-weight:400;margin-inline-start:.3rem}
.stat-sub{font-size:.72rem;color:var(--faint);margin:.4rem 0 0}
.stat-amber .stat-value{color:var(--amber)}
.stat-settle .stat-value{color:var(--settle)}
.stat-reject .stat-value{color:var(--reject)}

table{width:100%;border-collapse:collapse;font-size:.81rem}
thead th{text-align:right;font-weight:600;font-size:.72rem;color:var(--faint);padding:.5rem .6rem;
border-bottom:1px solid var(--hairline);white-space:nowrap}
tbody td{padding:.65rem .6rem;border-bottom:1px solid var(--hairline-soft);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--ink-raised)}
.table-wrap{overflow-x:auto;margin:0 -1.25rem;padding:0 1.25rem}

.badge{display:inline-flex;align-items:center;gap:.35rem;padding:.2rem .55rem;border-radius:999px;
font-size:.7rem;font-weight:600;border:1px solid var(--hairline);background:var(--ink-raised);color:var(--muted);
white-space:nowrap}
.badge i{width:.4rem;height:.4rem;border-radius:50%;background:currentColor}
.badge-paid,.badge-active,.badge-delivered,.badge-connected{color:var(--settle);border-color:rgba(53,214,155,.35)}
.badge-pending,.badge-open,.badge-in_progress{color:var(--amber);border-color:rgba(255,176,32,.35)}
.badge-expired,.badge-failed,.badge-dead,.badge-cancelled,.badge-suspended,.badge-banned,.badge-rejected{
color:var(--reject);border-color:rgba(255,107,107,.35)}
.badge-review,.badge-manual_review,.badge-waiting_for_admin,.badge-waiting_for_user{
color:var(--signal);border-color:rgba(76,125,255,.4)}

/* The pipeline spine: the real processing lifecycle, drawn as a rail. Structure as
   information — a step is lit only when that stage actually happened. */
.spine{display:flex;align-items:center;gap:.375rem;flex-wrap:wrap}
.spine-node{display:flex;align-items:center;gap:.4rem;padding:.35rem .6rem;border-radius:999px;
border:1px solid var(--hairline);background:var(--ink-raised);font-size:.7rem;color:var(--faint)}
.spine-node[data-state='done']{color:var(--settle);border-color:rgba(53,214,155,.35)}
.spine-node[data-state='current']{color:var(--amber);border-color:rgba(255,176,32,.4)}
.spine-node[data-state='blocked']{color:var(--reject);border-color:rgba(255,107,107,.35)}
.spine-node b{font-weight:600}
.spine-sep{width:.9rem;height:1px;background:var(--hairline);flex:none}

.form{display:grid;gap:1rem;max-width:34rem}
.field{display:grid;gap:.375rem}
.field label{font-size:.78rem;color:var(--muted);font-weight:500}
.field .hint{font-size:.71rem;color:var(--faint);line-height:1.7}
.input,select.input,textarea.input{width:100%;padding:.625rem .75rem;border-radius:10px;
border:1px solid var(--hairline);background:var(--ink-raised);font-size:.85rem}
.input:focus{border-color:var(--signal);outline:none;box-shadow:0 0 0 3px rgba(76,125,255,.14)}
textarea.input{min-height:6rem;resize:vertical;line-height:1.85}
.field-error{font-size:.73rem;color:var(--reject)}
.alert{padding:.75rem 1rem;border-radius:var(--radius);font-size:.81rem;border:1px solid var(--hairline);
line-height:1.85}
.alert-error{border-color:rgba(255,107,107,.4);background:rgba(255,107,107,.07);color:#ffc9c9}
.alert-success{border-color:rgba(53,214,155,.4);background:rgba(53,214,155,.07);color:#b6f0da}
.alert-info{border-color:rgba(76,125,255,.4);background:rgba(76,125,255,.07);color:#cddbff}
.alert-warn{border-color:rgba(255,176,32,.4);background:rgba(255,176,32,.07);color:#ffe1ac}

.key-reveal{font-family:${FONT_STACK.code};font-size:.8rem;word-break:break-all;padding:.875rem 1rem;
border-radius:var(--radius);background:var(--ink-raised);border:1px dashed var(--signal);color:var(--glacier);
display:flex;gap:.6rem;align-items:center;justify-content:space-between;flex-wrap:wrap}
.empty{text-align:center;padding:2.5rem 1rem;color:var(--muted)}
.empty h3{margin:0 0 .5rem;font-size:1rem;color:var(--glacier)}
.empty p{margin:0 0 1rem;font-size:.83rem}
.spark{display:flex;align-items:flex-end;gap:3px;height:3.5rem}
.spark i{flex:1;background:linear-gradient(180deg,var(--signal),rgba(76,125,255,.25));border-radius:3px 3px 0 0;
min-height:3px}
.spark i[data-zero='1']{background:var(--hairline)}
.bar-row{display:flex;align-items:center;gap:.6rem;font-size:.76rem}
.bar-row .bar{flex:1;height:.45rem;border-radius:999px;background:var(--ink-raised);overflow:hidden}
.bar-row .bar span{display:block;height:100%;background:var(--signal)}
.bar-row .val{color:var(--muted);min-width:3.5rem;text-align:left;font-variant-numeric:tabular-nums}

/* Ticket conversation: a chat surface, because that is what support is. */
.chat{display:grid;gap:.75rem;max-height:26rem;overflow-y:auto;padding:.25rem}
.msg{max-width:78%;padding:.65rem .875rem;border-radius:14px;font-size:.83rem;line-height:1.9;
border:1px solid var(--hairline);background:var(--basalt);word-break:break-word;white-space:pre-wrap}
.msg[data-mine='1']{margin-inline-start:auto;background:var(--basalt-strong);border-color:#26314f}
.msg-meta{font-size:.68rem;color:var(--faint);margin-top:.35rem}

@media (max-width:880px){
.shell{grid-template-columns:1fr}
.nav{position:static;height:auto;border-inline-start:0;border-bottom:1px solid var(--hairline);
flex-direction:row;overflow-x:auto;gap:1rem;padding:.75rem}
.nav-group{flex-direction:row;gap:.25rem}
.nav-group h2{display:none}
.nav-foot{display:none}
.main{padding:1rem 1rem 3rem}
.grid-2,.grid-3,.grid-4{grid-template-columns:1fr}
}
`;

/**
 * Inline script. Kept as a string so the payment page can ship it without a second
 * request; it is small, dependency-free and does only three things: copy to
 * clipboard, run the countdown, and poll the payment status.
 */
export const CLIENT_JS = `
(function(){
'use strict';
function fa(n){var d='۰۱۲۳۴۵۶۷۸۹';return String(n).replace(/[0-9]/g,function(c){return d[+c]})}
function tens(n){return String(n).padStart(2,'0')}
function copy(text,btn){
  var done=function(){
    var label=btn.getAttribute('data-label')||btn.textContent;
    btn.setAttribute('data-label',label);
    btn.setAttribute('data-copied','1');
    btn.textContent='کپی شد';
    setTimeout(function(){btn.removeAttribute('data-copied');btn.textContent=label},1600);
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
document.addEventListener('click',function(event){
  var target=event.target;
  if(!(target instanceof Element))return;
  var btn=target.closest('[data-copy]');
  if(!btn)return;
  event.preventDefault();
  copy(btn.getAttribute('data-copy'),btn);
});

// Countdown. Reads the server-provided absolute expiry, not a duration, so a
// reload or a clock skew does not restart the timer.
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

// Status polling on the pending page. Stops as soon as the state is final.
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

// Reveal-once secrets: never leave a plaintext API key in the DOM after the user
// has acknowledged it.
var secret=document.querySelector('[data-secret-once]');
if(secret){
  var hide=document.querySelector('[data-secret-dismiss]');
  if(hide)hide.addEventListener('click',function(){secret.setAttribute('hidden','');hide.setAttribute('hidden','')});
}
})();
`;
