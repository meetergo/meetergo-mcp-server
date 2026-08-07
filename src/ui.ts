/**
 * ChatGPT Apps SDK components, served as MCP UI resources by the HOSTED
 * entry only (stdio clients have no way to render them; the extra listing
 * would just be noise there).
 *
 * The contract: a tool names its template via `_meta["openai/outputTemplate"]`,
 * ChatGPT fetches the `ui://` resource (mime `text/html+skybridge`), renders it
 * in a sandboxed iframe, and the component reads the tool's structured output
 * from `window.openai.toolOutput`. Everything below is defensive: a component
 * that receives no data renders nothing rather than a broken card.
 *
 * These need live verification inside ChatGPT developer mode before directory
 * submission — the sandbox's exact capabilities move faster than any doc.
 */

export const UI_MIME = 'text/html+skybridge'

export const SETUP_STATUS_TEMPLATE_URI = 'ui://meetergo/setup-status.html'
export const UPGRADE_CARD_TEMPLATE_URI = 'ui://meetergo/upgrade-card.html'

/** Shared look: meetergo violet, system stack, calm card. */
const BASE_CSS = `
  :root { --accent:#564FE3; --text:#171923; --muted:#5c6474; --border:#e4e7ee; --good:#059669; --bg:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --text:#e8eaf2; --muted:#9aa1b5; --border:#2a2f3f; --bg:#151824; --accent:#8b85ff; }
  }
  * { box-sizing: border-box; margin: 0; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--text); background: transparent; }
  .card { background: var(--bg); border: 1px solid var(--border); border-radius: 14px; padding: 16px 18px; max-width: 520px; }
  .title { font-size: 15px; font-weight: 700; }
  .sub { color: var(--muted); font-size: 13px; margin-top: 2px; }
  .row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--border); }
  .row:first-of-type { border-top: 0; }
  .dot { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; flex-shrink: 0; }
  .done { background: #e8f7f0; color: var(--good); }
  .open { border: 2px dashed var(--border); color: var(--muted); }
  .meter { height: 6px; border-radius: 99px; background: var(--border); overflow: hidden; margin-top: 12px; }
  .meter i { display: block; height: 100%; background: var(--accent); border-radius: 99px; }
  .btn { display: inline-block; background: var(--accent); color: #fff; border-radius: 9px; padding: 8px 14px; font-size: 13px; font-weight: 700; text-decoration: none; margin-top: 12px; }
  .muted { color: var(--muted); font-size: 12.5px; }
`

/**
 * Renders get_setup_status: the launch checklist as a card, mirroring the
 * dashboard's runway so chat and dashboard tell one story.
 */
export const SETUP_STATUS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head>
<body>
<div class="card" id="root" hidden>
  <div class="title" id="headline"></div>
  <div class="sub" id="subline"></div>
  <div class="meter"><i id="meter" style="width:0%"></i></div>
  <div id="steps" style="margin-top:10px"></div>
</div>
<script>
  const LABELS = {
    bookable: 'A bookable meeting type',
    assistant: 'Website assistant configured',
    knowledge: 'Answers from the company website',
    testDrive: 'Proven with a test drive',
    install: 'Widget installed on the site',
    live: 'Live for visitors',
  };
  const data = window.openai && window.openai.toolOutput;
  const status = data && data.steps ? data : null;
  if (status) {
    document.getElementById('root').hidden = false;
    const remaining = status.total - status.done;
    document.getElementById('headline').textContent =
      remaining === 0 ? 'Live — visitors can book through the assistant'
        : remaining + (remaining === 1 ? ' step' : ' steps') + ' from live';
    document.getElementById('subline').textContent =
      status.done + ' of ' + status.total + ' done';
    document.getElementById('meter').style.width =
      Math.round((status.done / status.total) * 100) + '%';
    const steps = document.getElementById('steps');
    for (const step of status.steps) {
      const row = document.createElement('div');
      row.className = 'row';
      const dot = document.createElement('span');
      dot.className = 'dot ' + (step.done ? 'done' : 'open');
      dot.textContent = step.done ? '✓' : '';
      const label = document.createElement('span');
      label.textContent = LABELS[step.key] || step.key;
      if (!step.done) label.className = 'muted';
      row.append(dot, label);
      steps.append(row);
    }
  }
</script>
</body></html>`

/**
 * Renders a plan-limit moment: which allowance is used up and the one door
 * onward. Shown only when an action the user asked for hit the wall — the
 * component itself enforces nothing; the tools decide when it appears.
 */
export const UPGRADE_CARD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head>
<body>
<div class="card" id="root" hidden>
  <div class="title" id="headline"></div>
  <div class="sub" id="subline"></div>
  <div class="meter"><i style="width:100%; background:linear-gradient(90deg,#b45309,#b91c1c)"></i></div>
  <a class="btn" id="cta" target="_blank" rel="noreferrer">Upgrade &amp; keep going</a>
  <div class="muted" style="margin-top:8px">Everything already built keeps working on the current plan.</div>
</div>
<script>
  const data = window.openai && window.openai.toolOutput;
  const limit = data && data.planLimit ? data.planLimit : null;
  if (limit && limit.upgradeUrl) {
    document.getElementById('root').hidden = false;
    document.getElementById('headline').textContent =
      'The current plan\\u2019s ' + (limit.feature || 'allowance') + ' is used up';
    document.getElementById('subline').textContent = limit.detail || '';
    document.getElementById('cta').href = limit.upgradeUrl;
  }
</script>
</body></html>`
