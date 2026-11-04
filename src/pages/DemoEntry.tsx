// /demo — the front door of the demo session (src/lib/demo/demoSession.ts).
//
// A visitor with no account lands here, the session flag is set, and the app is
// reloaded onto the first demo page. A reload rather than a client-side navigation on
// purpose: the auth and project-selection providers read the flag when they mount, and
// a fresh mount is the one way to be sure neither carries a previous state across.
//
// A person who is already signed in has the whole app, so they are asked: open it, or
// look at the demo as a visitor would (a PREVIEW — their own session is hidden for this
// tab, not ended, and returns when they exit). With no demo account configured there is
// nothing to start, and the page says so.
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import PageSpinner from '@/components/PageSpinner';
import { useAuth } from '@/hooks/useAuth';
import { DEMO_HOME, demoConfigured, startDemoSession } from '@/lib/demo/demoSession';

const DemoEntry = () => {
  const { user, demo } = useAuth();
  const configured = demoConfigured();
  const personSignedIn = !!(user && !demo);
  const startable = configured && !personSignedIn;

  useEffect(() => {
    console.log('[DEMO] /demo opened:', { configured, personSignedIn, startable });
    if (!startable) return;
    startDemoSession('visitor');
    window.location.replace(DEMO_HOME);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the page opens
  }, [startable]);

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

  if (personSignedIn) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center gap-4 px-4">
        <h1 className="text-lg font-semibold">You are signed in</h1>
        <p className="text-sm text-muted-foreground">
          {user?.email}. The demo is what a visitor without an account sees. You can look at it
          that way without signing out: your session comes back when you exit the demo.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              startDemoSession('preview');
              window.location.replace(DEMO_HOME);
            }}
          >
            View the demo as a visitor
          </Button>
          <Button asChild variant="outline">
            <Link to={DEMO_HOME}>Open the app</Link>
          </Button>
        </div>
      </main>
    );
  }

  return <PageSpinner />;
};

export default DemoEntry;
