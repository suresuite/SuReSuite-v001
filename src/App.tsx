import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, useState, type ReactNode } from 'react';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { CapabilitiesProvider, useCapabilities } from '@/hooks/useCapabilities';
import { GlobalProjectProvider } from '@/hooks/useGlobalProject';
import { ViewportProvider } from '@/hooks/useViewport';
import { ConfirmProvider } from '@/components/shared/confirm/ConfirmProvider';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import ProtectedRoute from '@/components/ProtectedRoute';
import RoleGuard from '@/components/RoleGuard';
import RouteErrorBoundary from '@/components/RouteErrorBoundary';
import PageSpinner from '@/components/PageSpinner';
import { PageLayout } from '@/components/shared/PageLayout';
import { passwordStatus } from '@/lib/auth/passwordPolicy';
import { lazyChunk } from '@/lib/lazyChunk';

// Renders on every route, but never in the first frame that matters — so the
// chat tree and its dependencies come after the page, not with it.
const FloatingChatBubble = lazyChunk(() =>
  import('@/components/chat/FloatingChatBubble').then((m) => ({ default: m.FloatingChatBubble })),
);

// The two unauthenticated entry points stay eager. Everything else is lazy.
//
// A lazy route costs one extra round trip — the entry chunk has to run before
// the browser learns the page chunk exists. On an app route that is invisible
// (you arrive already authenticated, and Phase 2's prefetch-on-intent will hide
// it entirely). On the public landing page it would land squarely in LCP, for
// the one visitor whose first impression is the whole point. So `/` and `/auth`
// are paid for up front; the 25 pages behind the login are not.
import Landing from './pages/Landing';
import Auth from './pages/Auth';
// `/demo` is NOT one of the two eager entry points above: imported eagerly it
// pushed the initial graph past the bundle-size ceiling (audit:bundle), so it
// is lazy like every other page.
const DemoEntry = lazyChunk(() => import('./pages/DemoEntry'));
// Renders nothing and acts only in a demo session — no reason to be in the
// initial graph either.
const DemoProjectSelector = lazyChunk(() =>
  import('@/components/demo/DemoProjectSelector').then((m) => ({ default: m.DemoProjectSelector })),
);

const OrbitMrpCallback = lazyChunk(() => import('./pages/OrbitMrpCallback'));
const DataManager = lazyChunk(() => import('./pages/DataManager'));
const ProductLevelNetwork = lazyChunk(() => import('./pages/ProductLevelNetwork'));
const ProcessLevelNetwork = lazyChunk(() => import('./pages/ProcessLevelNetwork'));
const FirmLevelNetwork = lazyChunk(() => import('./pages/FirmLevelNetwork'));
const InteractiveNetworkSpace = lazyChunk(() => import('./pages/InteractiveNetworkSpace'));
const GettingStarted = lazyChunk(() => import('./pages/GettingStarted'));
const ProjectPolicies = lazyChunk(() => import('./pages/ProjectPolicies'));
const SimulationLab = lazyChunk(() => import('./pages/SimulationLab'));
const ProjectIntelligence = lazyChunk(() => import('./pages/ProjectIntelligence'));
const Profile = lazyChunk(() => import('./pages/Profile'));
const DeveloperApi = lazyChunk(() => import('./pages/DeveloperApi'));
const Forbidden = lazyChunk(() => import('./pages/Forbidden'));
const NotFound = lazyChunk(() => import('./pages/NotFound'));
const About = lazyChunk(() => import('./pages/About'));
const DocsLayout = lazyChunk(() => import('./components/docs/DocsLayout'));
const DocsHome = lazyChunk(() => import('./components/docs/DocsHome'));
const DocPage = lazyChunk(() => import('./components/docs/DocPage'));
const HelpSlugRedirect = lazyChunk(() => import('./components/docs/legacyRedirects'));
const AdminDashboard = lazyChunk(() => import('./pages/admin/AdminDashboard'));
const AdminUsers = lazyChunk(() => import('./pages/admin/AdminUsers'));
const AdminUserAccess = lazyChunk(() => import('./pages/admin/AdminUserAccess'));
const AdminRoles = lazyChunk(() => import('./pages/admin/AdminRoles'));
const AdminOrganizations = lazyChunk(() => import('./pages/admin/AdminOrganizations'));
const AdminProjects = lazyChunk(() => import('./pages/admin/AdminProjects'));
const AdminModels = lazyChunk(() => import('./pages/admin/AdminModels'));
const AdminUsage = lazyChunk(() => import('./pages/admin/AdminUsage'));
const AdminAudit = lazyChunk(() => import('./pages/admin/AdminAudit'));
const AdminDocs = lazyChunk(() => import('./pages/admin/AdminDocs'));

/** Shown while a route chunk arrives. Deliberately the same spinner
 *  `ProtectedRoute` and `RoleGuard` show (`PageSpinner`) — from the user's side
 *  all are "the page is coming", and two different waits would read as two
 *  different kinds of slow. */
const RouteFallback = PageSpinner;

/** The manual's door. Each SECTION has an audience a super admin sets from
 *  /admin/docs (public · internal · confidential — `docsVisibility.ts`), so the
 *  door opens when the reader may read at least one section, and DocPage
 *  answers a page in a closed section itself. Nothing open: a signed-out
 *  visitor is sent to sign in, a signed-in one to /forbidden. The one rule is
 *  `canAccessPage`, the same call the sidebar and phone drawer make. */
function DocsGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const { canAccessPage, docs, ready } = useCapabilities();
  const location = useLocation();
  // `ready`: a signed-in reader's Confidential grant is in the server's set,
  // not in the role fallback — deciding before it lands sends them to /forbidden.
  if (loading || docs.loading || !ready) return <RouteFallback />;
  // RoleGuard's rule, kept here because a signed-in reader does not pass through it.
  if (user && passwordStatus(user).mustChange) {
    return <Navigate to="/profile?tab=password&forced=1" replace />;
  }
  if (canAccessPage('/docs')) return <>{children}</>;
  if (!user) return <Navigate to="/auth" replace state={{ from: location }} />;
  return <Navigate to="/forbidden" replace />;
}

/** Renders its children except during a demo session (src/lib/demo). */
function HideInDemo({ children }: { children: ReactNode }) {
  const { demo } = useAuth();
  return demo ? null : <>{children}</>;
}

const queryClient = new QueryClient();

function App() {
  // The desktop sidebar opens expanded by default; the user can still collapse it.
  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Light-locked: the product has no dark design. forcedTheme pins the class
          regardless of the OS setting or a stale localStorage value. The .dark block
          in index.css is legacy and inert once this is set — do not delete it. */}
      <ThemeProvider
        attribute="class"
        defaultTheme="light"
        enableSystem={false}
        forcedTheme="light"
      >
        {/* One viewport listener for the app (v2 §5.1). Everything that sizes
            itself to the device reads this; nothing adds a resize listener of
            its own. */}
        <ViewportProvider>
        <AuthProvider>
          <CapabilitiesProvider>
          <GlobalProjectProvider>
            <Router>
              {/* useConfirm(): window.confirm on desktop, the ConfirmSheet on a
                  phone (mobile redesign §2.3). Inside the router — the sheet
                  reads the route to know whether a tab bar sits under it. */}
              <ConfirmProvider>
              <RouteErrorBoundary>
              <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/auth" element={<Auth />} />
                <Route path="/demo" element={<DemoEntry />} />
                <Route path="/integrations/orbit-mrp/callback" element={<ProtectedRoute><OrbitMrpCallback /></ProtectedRoute>} />
              <Route path="/forbidden" element={<Forbidden isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} />} />
                <Route path="/" element={<Landing />} />
                <Route
                  path="/app"
                  element={
                    <ProtectedRoute>
                    <RoleGuard><GettingStarted 
                        isCollapsed={isCollapsed} 
                        setIsCollapsed={setIsCollapsed} 
                    /></RoleGuard>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/project-manager"
                  element={
                    <ProtectedRoute>
                    <RoleGuard><DataManager 
                        isCollapsed={isCollapsed} 
                        setIsCollapsed={setIsCollapsed} 
                    /></RoleGuard>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/network/firm-level"
                  element={
                    <ProtectedRoute>
                    <RoleGuard><FirmLevelNetwork 
                        isCollapsed={isCollapsed} 
                        setIsCollapsed={setIsCollapsed} 
                    /></RoleGuard>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/network/product-level"
                  element={
                    <ProtectedRoute>
                    <RoleGuard><ProductLevelNetwork 
                        isCollapsed={isCollapsed} 
                        setIsCollapsed={setIsCollapsed} 
                    /></RoleGuard>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/network/process-level"
                  element={
                    <ProtectedRoute>
                    <RoleGuard><ProcessLevelNetwork 
                        isCollapsed={isCollapsed} 
                        setIsCollapsed={setIsCollapsed} 
                    /></RoleGuard>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/network/interactive-space"
                  element={
                    <ProtectedRoute>
                    <RoleGuard><InteractiveNetworkSpace 
                        isCollapsed={isCollapsed} 
                        setIsCollapsed={setIsCollapsed} 
                    /></RoleGuard>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/policies"
                  element={
                    <ProtectedRoute>
                      <RoleGuard><ProjectPolicies isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} /></RoleGuard>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/simulation-lab"
                  element={
                    <ProtectedRoute>
                      <RoleGuard><SimulationLab isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} /></RoleGuard>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/project-intelligence/*"
                  element={
                    <ProtectedRoute>
                    <RoleGuard><ProjectIntelligence 
                        isCollapsed={isCollapsed} 
                        setIsCollapsed={setIsCollapsed} 
                    /></RoleGuard>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/developer"
                  element={
                    <ProtectedRoute>
                      <RoleGuard><DeveloperApi isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} /></RoleGuard>
                    </ProtectedRoute>
                  }
                />
              <Route
                path="/profile"
                element={
                  <ProtectedRoute>
                    <RoleGuard><Profile isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} /></RoleGuard>
                  </ProtectedRoute>
                }
              />
                {/* The manual (PLAN.md §6). Meant to be public: §6.5's argument for
                    publishing the architecture is that a prospective customer, a
                    researcher and a new modeller all ask the same opening question,
                    and answering it should not require an account. Whether it does
                    is now a per-SECTION setting a super admin changes at /admin/docs
                    (`docs_section_releases`, src/lib/ui/docsVisibility.ts); every
                    section starts confidential, and DocsGate reads the answer.

                    /docs is the address §6 names throughout. /help is what the
                    archived site used and what anything older links to, so it
                    redirects rather than 404s — `replace` so the old address does
                    not accumulate in the reader's history.

                    NOTE for later packages: `public/docs/` serves three real files
                    (the CSV upload guides). Static files win over the SPA fallback,
                    and every one of them ends in `.md` while no slug does — but a
                    slug ending `.md` would be shadowed by that directory. The
                    registry test asserts none is. */}
                <Route path="/docs" element={<DocsGate><DocsLayout /></DocsGate>}>
                  {/* The index is the manual's front door, not its first
                      article: /docs is linked from the public top bar next to
                      /about, so it is reached by people deciding whether to
                      read anything at all. DocsHome answers that; DocPage
                      still serves every :slug, the first article among them. */}
                  <Route index element={<DocsHome />} />
                  <Route path=":slug" element={<DocPage />} />
                </Route>
                <Route path="/help" element={<DocsGate><Navigate to="/docs" replace /></DocsGate>} />
                <Route path="/help/:slug" element={<DocsGate><HelpSlugRedirect /></DocsGate>} />
                <Route path="/about" element={<About />} />

                {/* Super Admin routes */}
                <Route path="/admin" element={<ProtectedRoute><RoleGuard><AdminDashboard isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} /></RoleGuard></ProtectedRoute>} />
                <Route path="/admin/users" element={<ProtectedRoute><RoleGuard><AdminUsers isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} /></RoleGuard></ProtectedRoute>} />
                <Route path="/admin/users/:userId" element={<ProtectedRoute><RoleGuard><AdminUserAccess isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} /></RoleGuard></ProtectedRoute>} />
                <Route path="/admin/roles" element={<ProtectedRoute><RoleGuard><AdminRoles isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} /></RoleGuard></ProtectedRoute>} />
                <Route path="/admin/organizations" element={<ProtectedRoute><RoleGuard><AdminOrganizations isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} /></RoleGuard></ProtectedRoute>} />
                <Route path="/admin/projects" element={<ProtectedRoute><RoleGuard><AdminProjects isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} /></RoleGuard></ProtectedRoute>} />
                <Route path="/admin/models" element={<ProtectedRoute><RoleGuard><AdminModels isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} /></RoleGuard></ProtectedRoute>} />
                <Route path="/admin/usage" element={<ProtectedRoute><RoleGuard><AdminUsage isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} /></RoleGuard></ProtectedRoute>} />
                <Route path="/admin/docs" element={<ProtectedRoute><RoleGuard><AdminDocs isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} /></RoleGuard></ProtectedRoute>} />
                <Route path="/admin/audit" element={<ProtectedRoute><RoleGuard><AdminAudit isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} /></RoleGuard></ProtectedRoute>} />

                {/* Unknown URL — the host rewrites every path to index.html so the
                    SPA can deep-link, which means 404s land here, not on the host. */}
                <Route path="*" element={<NotFound isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} />} />
              </Routes>
              </Suspense>
              </RouteErrorBoundary>
              {/* Own boundary: the bubble renders on every route, so a throw
                  here must not take the routed page down with it. Its own
                  Suspense too — the bubble arriving a beat late is invisible,
                  but sharing the route boundary would hold the whole page
                  behind it. */}
              {/* The demo shows the three network pages and nothing that costs money. */}
              <HideInDemo>
                <RouteErrorBoundary fallback={null}>
                  <Suspense fallback={null}>
                    <FloatingChatBubble />
                  </Suspense>
                </RouteErrorBoundary>
              </HideInDemo>
              <Suspense fallback={null}>
                <DemoProjectSelector />
              </Suspense>
              </ConfirmProvider>
            </Router>
          </GlobalProjectProvider>
          </CapabilitiesProvider>
        </AuthProvider>
        </ViewportProvider>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;