// @ts-nocheck — schema mismatch: this file targets a supply-chain schema not yet migrated into this project. Remove once tables/RPCs are created.
import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { mintAndVerifySession } from '@/lib/auth/sessionMint';
import { roleChangeNotice, watchProfileFreshness } from '@/lib/auth/sessionRefresh';
import { toast } from 'sonner';
import { demoGuestUser, demoIdentity, demoSessionMode, endDemoSession } from '@/lib/demo/demoSession';

interface User {
  id: string;
  name: string;
  /** The parts of `name`, derived by the database and read-only to the user (D209). */
  first_name?: string | null;
  last_name?: string | null;
  email: string;
  role: string;
  organization: string;
  display_name?: string | null;
  /** A token of `AVATAR_COLORS`; the image upload is retired (D206). */
  avatar_color?: string | null;
  phone?: string | null;
  is_active?: boolean;
  force_password_change?: boolean;
  password_expires_at?: string | null;
  password_changed_at?: string | null;
  /** Computed on the database clock when the row was read (D206). */
  password_expired?: boolean;
  /** The policy, `password_max_age()`, in days (D206). */
  password_max_age_days?: number | null;
  /** D207 — the account's ORGANIZATION's plan, read through `get_my_profile`. */
  access_period?: string | null;
  access_valid_from?: string | null;
  access_valid_until?: string | null;
  /** The organization's period has ended FOR THIS ACCOUNT, on the database clock. */
  access_expired?: boolean;
  /** A super admin is not locked out by their organization's period. */
  access_exempt?: boolean;
  project_limit?: number | null;
  projects_used?: number | null;
  user_limit?: number | null;
  users_used?: number | null;
}

/**
 * The account row's fields as `get_my_profile` returns them. The user is NAMED: the
 * browser calls as `anon`, and the GUC `set_current_user_context` sets is LOCAL to its
 * own request, so a call that named nobody resolved nobody and raised
 * `not_authenticated` for everyone — which is how forced and expired password changes
 * went unenforced (PLAN.md §4 D206).
 */
async function readProfile(userId: string) {
  const { data, error } = await supabase.rpc('get_my_profile', { p_user_id: userId });
  if (error) return { profile: null, error };
  const p = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!p) return { profile: null, error: { message: 'no account row' } };
  return {
    profile: {
      name: p.name as string | null,
      first_name: p.first_name as string | null,
      last_name: p.last_name as string | null,
      role: p.role as string | null,
      organization: p.organization as string | null,
      display_name: p.display_name as string | null,
      avatar_color: p.avatar_color as string | null,
      phone: p.phone as string | null,
      is_active: p.is_active as boolean,
      force_password_change: p.force_password_change as boolean,
      password_expires_at: p.password_expires_at as string | null,
      password_changed_at: p.password_changed_at as string | null,
      password_expired: p.password_expired as boolean,
      password_max_age_days: p.password_max_age_days as number | null,
      access_period: p.access_period as string | null,
      access_valid_from: p.access_valid_from as string | null,
      access_valid_until: p.access_valid_until as string | null,
      access_expired: p.access_expired as boolean,
      access_exempt: p.access_exempt as boolean,
      project_limit: p.project_limit as number | null,
      projects_used: p.projects_used == null ? null : Number(p.projects_used),
      user_limit: p.user_limit as number | null,
      users_used: p.users_used == null ? null : Number(p.users_used),
    },
    error: null,
  };
}

interface AuthContextType {
  user: User | null;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  loading: boolean;
  /** A demo session is on: `user` is the read-only demo account, not a person who signed in. */
  demo: boolean;
  /** The demo is being PREVIEWED by a person who is signed in: their own session is
   *  hidden for this tab, not ended, and returns when the preview does. */
  preview: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(() => {
    console.log('[AUTH] Initializing from localStorage');
    try {
      const stored = localStorage.getItem('auth_user');
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      console.error('[AUTH] Failed to parse stored user on init:', error);
      localStorage.removeItem('auth_user');
      return null;
    }
  });
  const [loading, setLoading] = useState(false);
  // The demo session (src/lib/demo). A real sign-in always wins over it, and it is never
  // written to `auth_user`: the account the pages see is derived here, per render.
  const [demoMode, setDemoMode] = useState<'visitor' | 'preview' | null>(() => {
    const mode = demoSessionMode();
    console.log('[DEMO] demo session on load:', mode);
    return mode;
  });
  const preview = demoMode === 'preview';
  const demoId = demoMode ? demoIdentity() : null;
  const demoUser = demoId ? demoGuestUser(demoId) : null;
  // A person's own session wins over a visitor demo — and loses to a preview they asked for.
  const realUser = preview ? null : user;

  const login = async (email: string, password: string) => {
    try {
      setLoading(true);
      console.log('[AUTH] Starting login process for:', email);
      
      // Call our custom authentication function
      const { data, error } = await supabase.rpc('authenticate_approved_user', {
        user_email: email,
        user_password: password
      });

      console.log('[AUTH] Authentication response:', { data, error });

      if (error) {
        console.error('[AUTH] Authentication error:', error);
        return { success: false, error: 'Invalid email or password' };
      }

      if (!data || data.length === 0) {
        // The server returns no row for a wrong password, a suspended account (PLAN.md
        // §4 D205) and a member of an organization whose access period has ended (D207),
        // and does not say which, so the message may not either.
        console.log('[AUTH] No user data returned from authentication');
        return { success: false, error: 'Invalid email or password, or the account is suspended or its organization\'s access period has ended. Contact your administrator if this persists.' };
      }

      const userData = data[0];
      console.log('[AUTH] User data from DB:', userData);
      
      // Set user context for RLS policies
      const { error: contextError } = await supabase.rpc('set_current_user_context', {
        user_id: userData.user_id,
        user_email: email
      });

      if (contextError) {
        console.error('[AUTH] Error setting user context:', contextError);
        return { success: false, error: 'Authentication setup failed' };
      }
      
      // Fetch user's organization (non-blocking)
      const { data: orgData, error: orgError } = await supabase
        .from('approved_users')
        .select('organization')
        .eq('id', userData.user_id)
        .maybeSingle();
      
      if (orgError) {
        console.warn('[AUTH] Organization lookup failed, defaulting:', orgError);
      }
      
      const userObj: User = {
        id: userData.user_id,
        name: userData.user_name || 'User',
        email: email,
        role: userData.user_role || 'user',
        organization: orgData?.organization || 'default_org'
      };

      console.log('[AUTH] Created user object:', userObj);

      // The account row: deactivation, forced change and password expiry. FAIL CLOSED —
      // an unreadable row used to be skipped silently, which is exactly how none of the
      // three was ever enforced (D206).
      const { profile, error: profileError } = await readProfile(userData.user_id);
      if (!profile) {
        console.error('[AUTH] Account status could not be read:', profileError);
        return { success: false, error: 'Could not verify your account status. Please try again.' };
      }
      if (profile.is_active === false) {
        return { success: false, error: 'Your account has been deactivated. Contact your administrator.' };
      }
      if (profile.access_expired) {
        return { success: false, error: 'Your organization\'s access period has ended. Contact your administrator to renew it.' };
      }
      Object.assign(userObj, profile, {
        name: profile.name || userObj.name,
        role: profile.role || userObj.role,
        organization: profile.organization || userObj.organization,
      });

      setUser(userObj);
      localStorage.setItem('auth_user', JSON.stringify(userObj));
      console.log('[AUTH] User stored in localStorage');
      // Somebody real signed in: the demo session is over.
      endDemoSession();
      setDemoMode(null);

      // WP 7.1 stage 1b — ask for a real session BESIDE the one above, never instead of it.
      //
      // OFF by default (`SESSION_MINT_DEFAULT`), and a no-op until somebody sets
      // `SUPABASE_JWT_SECRET` as a function secret. When it does run it mints a token whose
      // `sub` is this user's id and asks the database who it thinks is acting — the only
      // evidence stage 1b can produce, because no gate in this repository can mint a token
      // PostgREST accepts (PLAN.md §14, WP 7.1 stage 1b).
      //
      // Deliberately AFTER the login has been recorded and deliberately awaited only for
      // its outcome: `mintAndVerifySession` never throws, and this block returns success
      // whatever it reports. A session experiment must not be able to cost somebody their
      // login, which is the property that makes stages 1a and 1b safe to merge.
      try {
        const minted = await mintAndVerifySession(email, password, userData.user_id);
        if (minted.state === 'confirmed') {
          console.log('[AUTH] session minted and the database agrees:', minted.resolved);
        } else if (minted.state === 'mismatch') {
          console.error(
            '[AUTH] session minted but the database resolved somebody else — stage 1b is NOT working:',
            minted,
          );
        } else if (minted.state !== 'disabled') {
          console.log('[AUTH] session not minted:', minted.state);
        }
      } catch (mintError) {
        // Unreachable by contract; here because "never throws" is a claim about a module
        // somebody may later edit, and this is the login path.
        console.warn('[AUTH] session mint threw, which it should not:', mintError);
      }

      return { success: true };
    } catch (error) {
      console.error('[AUTH] Login error:', error);
      return { success: false, error: 'Login failed. Please try again.' };
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    // Ending a PREVIEW is not signing out: the person's own session was only hidden.
    if (preview) {
      console.log('[DEMO] ending the preview; the signed-in session is untouched');
      endDemoSession();
      setDemoMode(null);
      return;
    }
    console.log('[AUTH] Logging out user');
    console.log('[DEMO] ending the demo session (if one is on)');
    setUser(null);
    localStorage.removeItem('auth_user');
    // "Exit demo" is this same call: the session ends, and the route guard sends the
    // visitor to /auth.
    endDemoSession();
    setDemoMode(null);
  };

  const refreshProfile = async () => {
    if (!user?.id) return;
    const { profile, error } = await readProfile(user.id);
    if (!profile) {
      console.warn('[AUTH] Profile refresh failed; keeping the last known account state:', error);
      return;
    }
    // A session that outlived its account: suspended, or its organization's access
    // period ended since sign-in (D207). The database refuses the next sign-in either way.
    if (profile.is_active === false || profile.access_expired) {
      await logout();
      return;
    }
    const updated: User = {
      ...user,
      ...profile,
      name: profile.name || user.name,
      role: profile.role || user.role,
      organization: profile.organization || user.organization,
    };
    // D278 — a super admin changed the role while this tab was open. Said once: the next
    // refresh compares against the role stored here.
    const notice = roleChangeNotice(user.role, updated.role);
    if (notice) toast.info(notice);
    setUser(updated);
    localStorage.setItem('auth_user', JSON.stringify(updated));
  };
  // The listeners below outlive a render; they call the latest refreshProfile, not the
  // one closed over the user of the render that installed them.
  const refreshRef = useRef(refreshProfile);
  refreshRef.current = refreshProfile;

  useEffect(() => {
    // State initialized synchronously from localStorage
    console.log('[AUTH] AuthProvider mounted. User present:', !!user);
    
    // If user exists in localStorage, set context for RLS
    if (user?.id && user?.email) {
      supabase.rpc('set_current_user_context', {
        user_id: user.id,
        user_email: user.email
      }).then(({ error }) => {
        if (error) {
          console.error('[AUTH] Error setting user context on mount:', error);
        }
      });
      // A stored session carries the account state from its sign-in. Re-read it, so a
      // reset, a deactivation or an expiry since then is enforced on reload too.
      refreshProfile();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per signed-in user
  }, [user?.id, user?.email]);

  // D278 — an account changed elsewhere (a role on /admin/users) reaches an open tab: on
  // focus, on becoming visible, and every five minutes while signed in.
  useEffect(() => {
    if (!user?.id) return;
    return watchProfileFreshness(() => { refreshRef.current(); });
  }, [user?.id]);

  return (
    <AuthContext.Provider value={{ user: realUser ?? demoUser, login, logout, refreshProfile, loading, demo: !realUser && !!demoUser, preview: preview && !!demoUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};