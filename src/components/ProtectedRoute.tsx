import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import PageSpinner from '@/components/PageSpinner';
import { DEMO_HOME, demoPathAllowed } from '@/lib/demo/demoSession';

interface ProtectedRouteProps {
  children: ReactNode;
}

const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const { user, loading, demo } = useAuth();
  const location = useLocation();

  if (loading) return <PageSpinner />;

  if (!user) {
    // Remember where they were headed so /auth can send them back after login.
    return <Navigate to="/auth" replace state={{ from: location }} />;
  }

  // A demo visitor may open the demo pages (src/lib/demo) and nothing else. This keeps an
  // honest visitor on them; what the demo account can actually do is the database's call.
  if (demo && !demoPathAllowed(location.pathname)) return <Navigate to={DEMO_HOME} replace />;

  return <>{children}</>;
};

export default ProtectedRoute;
