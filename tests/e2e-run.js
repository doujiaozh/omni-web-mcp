const TOKEN = 'e2e-token-0123456789abcdef';
const BASE = 'http://127.0.0.1:8802';

async function call(tool, args) {
  const res = await fetch(BASE + '/api/call', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ tool, arguments: args })
  });
  const json = await res.json();
  console.log('---', tool, JSON.stringify(args), '=> ok=' + json.ok);
  return json;
}

(async () => {
  const list = await call('list_pages', {});
  const page = list.result.pages[0];
  if (!page) throw new Error('no page');
  const clientId = page.clientId;
  console.log('page:', clientId, page.title);

  const dom = await call('get_dom_tree', { include_text: false });
  const items = dom.result.interactive.slice(0, 10).map((e) => `${e.id}:${e.role}:${e.name}`);
  console.log('interactive:', items.join(' | '));

  const typed = await call('input_text', { id: 1, text: '自动输入：中文 UTF-8 ✓', submit: false });
  console.log('input ok=', typed.result && typed.result.ok, 'chars=', typed.result && typed.result.chars);

  const added = await call('click_element', { id: 2 });
  console.log('click ok=', added.result && added.result.ok);

  const scrolled = await call('scroll_page', { direction: 'down', amount: 300 });
  console.log('scroll ok=', scrolled.result && scrolled.result.ok, 'result=', JSON.stringify(scrolled.result).slice(0, 160));

  const up = await call('scroll_page', { direction: 'top' });
  console.log('scroll top ok=', up.result && up.result.ok);

  const tools = await (await fetch(BASE + '/api/tools', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  console.log('tools:', tools.tools ? tools.tools.map((t) => t.function ? t.function.name : t.name).join(',') : JSON.stringify(tools).slice(0, 200));
})().catch((e) => { console.error('E2E_FAIL', e); process.exit(1); });
