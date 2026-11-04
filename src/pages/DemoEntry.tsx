// /demo — the front door of the demo session (src/lib/demo/demoSession.ts).
//
// A visitor with no account lands here, the session flag is set, and the app is
// reloaded onto the first network page. A reload rather than a client-side navigation
// on purpose: the auth and project-selection providers read the flag when they mount,
// and a fresh mount is the one way to be sure neither carries a previous state across.
//
// A person who is already signed in has the app and does not need the demo, so they
// are sent to the page directly. With no demo account configured there is nothing to
// start, and the page says so.
import { useEffect } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import PageSpinner from '@/components/PageSpinner';
import { useAuth } from '@/hooks/useAuth';
import { DEMO_HOME, demoConfigured, startDemoSession } from '@/lib/demo/demoSession';

const DemoEntry = () => {
  const { user, demo } = useAuth();
  const configured = demoConfigured();
  const startable = configured && !(user && !demo);

  useEffect(() => {
    console.log('[DEMO] /demo opened:', { configured, personSignedIn: !!(user && !demo), startable });
    if (!startable) return;
    startDemoSession();
    window.location.replace(DEMO_HOME);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the page opens
  }, [startable]);

  if (user && !demo) return <Navigate to={DEMO_HOME} replace />;

  if (!configured) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center gap-4 px-4">
        <h1 className="text-lg font-semibold">The demo is not available</h1>
        <p className="text-sm text-muted-foreground">
          This installation has no demo set up. You can sign in with your account instead.
        </p>
        <Button asChild>
          <Link to="/auth">Sign in</Link>
        </Button>
      </main>
    );
  }

  return <PageSpinner />;
};

export default DemoEntry;
