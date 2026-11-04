// The strip a demo session wears on every page: what this is, and the way out.
// Renders nothing outside a demo session.
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';

export function DemoBanner() {
  const { demo, logout } = useAuth();
  const navigate = useNavigate();
  if (!demo) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-[#e8e8ea] bg-[#fffbeb] px-4 py-2 text-[12.5px] text-[#52525b]"
    >
      <span>
        <span className="font-semibold text-[#18181b]">Demo.</span> Read-only, with fictional data.
        Nothing you do here is saved.
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={() => {
          void logout().then(() => navigate('/auth'));
        }}
      >
        Sign in
      </Button>
    </div>
  );
}
