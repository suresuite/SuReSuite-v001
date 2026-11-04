// The demo session wired into the app: who `useAuth` says the user is, and which routes
// a demo visitor may open. Static renders, like the rest of this repository's component
// tests — the providers read their state synchronously, which is all these checks need.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '55ba1d37-7b64-41f4-a288-187099ea75ec';
const EMAIL = 'superuser3+demo-guest@suresuite.com';

function storage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

function setBrowser(opts: { demo: boolean | 'preview'; realUser?: object }) {
  vi.stubEnv('VITE_DEMO_GUEST_ID', ID);
  vi.stubEnv('VITE_DEMO_GUEST_EMAIL', EMAIL);
  vi.stubGlobal('window', { sessionStorage: storage(opts.demo ? { suresuite_demo_session: opts.demo === 'preview' ? 'preview' : '1' } : {}) });
  vi.stubGlobal(
    'localStorage',
    storage(opts.realUser ? { auth_user: JSON.stringify(opts.realUser) } : {}),
  );
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function who() {
  const { AuthProvider, useAuth } = await import('@/hooks/useAuth');
  const Probe = () => {
    const { user, demo, preview } = useAuth();
    return createElement('p', null, JSON.stringify({ id: user?.id ?? null, role: user?.role ?? null, demo, preview }));
  };
  const html = renderToStaticMarkup(createElement(AuthProvider, null, createElement(Probe)));
  return JSON.parse(html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"'));
}

describe('useAuth during a demo session', () => {
  it('names the read-only demo account as the user', async () => {
    setBrowser({ demo: true });
    expect(await who()).toEqual({ id: ID, role: 'user', demo: true, preview: false });
  });

  it('is nobody when no demo session is on', async () => {
    setBrowser({ demo: false });
    expect(await who()).toEqual({ id: null, role: null, demo: false, preview: false });
  });

  it('lets a real sign-in win over a demo flag left in the tab', async () => {
    setBrowser({ demo: true, realUser: { id: 'real-user', name: 'Real', email: 'r@x.y', role: 'modeler', organization: 'o' } });
    expect(await who()).toEqual({ id: 'real-user', role: 'modeler', demo: false, preview: false });
  });

  it('lets a signed-in person PREVIEW the demo, hiding their session without touching it', async () => {
    const real = { id: 'real-user', name: 'Real', email: 'r@x.y', role: 'modeler', organization: 'o' };
    setBrowser({ demo: 'preview', realUser: real });
    expect(await who()).toEqual({ id: ID, role: 'user', demo: true, preview: true });
    // the stored session is still there for when the preview ends
    expect(JSON.parse((globalThis as unknown as { localStorage: Storage }).localStorage.getItem('auth_user') as string).id).toBe('real-user');
  });

  it('is off when the demo account is not configured, flag or not', async () => {
    setBrowser({ demo: true });
    vi.stubEnv('VITE_DEMO_GUEST_ID', '');
    expect(await who()).toEqual({ id: null, role: null, demo: false, preview: false });
  });
});

describe('the route guard in a demo session', () => {
  // A redirect during a static render logs that <Navigate> did nothing, which is the
  // proof the guard turned the visitor away; the log is noise here.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  async function render(pathname: string, demo: boolean) {
    vi.doMock('@/hooks/useAuth', () => ({
      useAuth: () => ({ user: { id: 'u' }, loading: false, demo }),
    }));
    const { default: ProtectedRoute } = await import('@/components/ProtectedRoute');
    const page: ReactNode = createElement('main', null, 'the page');
    return renderToStaticMarkup(
      createElement(StaticRouter, { location: pathname }, createElement(ProtectedRoute, null, page)),
    );
  }

  it.each([
    '/network/product-level', '/network/process-level', '/network/firm-level',
    '/policies', '/simulation-lab', '/developer',
  ])(
    'lets a demo visitor open %s',
    async (p) => {
      expect(await render(p, true)).toContain('the page');
    },
  );

  it.each(['/project-manager', '/admin', '/admin/users', '/profile', '/project-intelligence', '/network/interactive-space', '/'])(
    'keeps a demo visitor off %s',
    async (p) => {
      expect(await render(p, true)).not.toContain('the page');
    },
  );

  it('does not restrict a person who is really signed in', async () => {
    expect(await render('/policies', false)).toContain('the page');
  });
});

describe('the demo banner', () => {
  async function banner(demo: boolean, preview = false) {
    vi.doMock('@/hooks/useAuth', () => ({ useAuth: () => ({ demo, preview, logout: async () => {} }) }));
    const { DemoBanner } = await import('@/components/demo/DemoBanner');
    return renderToStaticMarkup(createElement(StaticRouter, { location: '/' }, createElement(DemoBanner)));
  }

  it('says what this is and offers the way out', async () => {
    const html = await banner(true);
    expect(html).toContain('Read-only');
    expect(html).toContain('Sign in');
  });

  it('says it is a preview, with its own way out, when a signed-in person is previewing', async () => {
    const html = await banner(true, true);
    expect(html).toContain('previewing');
    expect(html).toContain('Exit preview');
    expect(html).not.toContain('>Sign in<');
  });

  it('is absent outside a demo', async () => {
    expect(await banner(false)).toBe('');
  });
});
