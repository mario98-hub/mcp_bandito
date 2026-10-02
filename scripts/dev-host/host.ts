// Minimal MCP Apps host for local development: renders the Conti view in a
// sandboxed iframe and proxies its tool calls to a real Conti server.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const log = (kind: string, text: string) => {
  const el = document.createElement('div');
  el.className = 'ev ' + kind;
  el.textContent = `${kind}: ${text}`;
  document.getElementById('log')!.prepend(el);
  (window as unknown as { __events: unknown[] }).__events.push({ kind, text });
};
(window as unknown as { __events: unknown[] }).__events = [];

async function api(path: string, body?: unknown) {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

async function main() {
  const q = new URLSearchParams(location.search);
  const theme = q.get('theme') === 'dark' ? 'dark' : 'light';
  const html: string = (await api('/api/ui')).html;
  const frame = document.getElementById('app') as HTMLIFrameElement;
  const bridge = new AppBridge(null, { name: 'conti-dev-host', version: '0.0.0' }, {
    serverTools: {}, message: { text: {} }, updateModelContext: { text: {} }, downloadFile: {}, openLinks: {},
  }, { hostContext: { theme, locale: q.get('locale') ?? 'it-IT', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], platform: 'web' } });
  bridge.oncalltool = async (params) => {
    log('tool', params.name);
    return api('/api/tool', { name: params.name, arguments: params.arguments ?? {} });
  };
  bridge.onmessage = async (p) => {
    log('message', (p.content as { text?: string }[]).map((c) => c.text).join(' '));
    return {};
  };
  bridge.onupdatemodelcontext = async (p) => {
    log('context', JSON.stringify(p.content));
    return {};
  };
  bridge.ondownloadfile = async (p) => {
    log('download', JSON.stringify(p.contents).slice(0, 120));
    return {};
  };
  bridge.onrequestdisplaymode = async (p) => ({ mode: p.mode });
  bridge.onsizechange = (p) => {
    if (p.height) frame.style.height = `${p.height}px`;
  };
  bridge.oninitialized = async () => {
    const tool = q.get('tool') ?? 'conti_dashboard';
    const args = JSON.parse(q.get('args') ?? '{}');
    bridge.sendToolInput({ arguments: args });
    const result = await api('/api/tool', { name: tool, arguments: args });
    bridge.sendToolResult(result);
    log('init', tool);
  };
  // connect before loading the view, so its ui/initialize request is not lost
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  frame.srcdoc = html;
}
main();
