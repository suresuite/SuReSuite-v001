// A demo has exactly one project, so nobody should have to choose it. Renders nothing.
// Selects the first project the demo account can see, once, while a demo session is on
// and nothing is selected yet.
import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useGlobalProject } from '@/hooks/useGlobalProject';

// `list_projects` is not in the generated client types; the app calls it untyped everywhere.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

export function DemoProjectSelector() {
  const { user, demo } = useAuth();
  const { globalSelectedProjectId, setGlobalSelectedProjectId } = useGlobalProject();

  useEffect(() => {
    if (!demo || !user?.id || globalSelectedProjectId) return;
    let alive = true;
    void sb
      .rpc('list_projects', { p_user_id: user.id, p_user_email: user.email })
      .then(({ data }: { data: unknown }) => {
        const first = Array.isArray(data) ? (data[0] as { id?: string } | undefined) : undefined;
        if (alive && first?.id) setGlobalSelectedProjectId(first.id);
      });
    return () => {
      alive = false;
    };
  }, [demo, user?.id, user?.email, globalSelectedProjectId, setGlobalSelectedProjectId]);

  return null;
}
