import { Suspense, useEffect, useState } from 'react';
import { lazyChunk } from '@/lib/lazyChunk';
import { useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { useCapabilities } from '@/hooks/useCapabilities';
import { useToast } from '@/hooks/use-toast';
import { Check } from 'lucide-react';
import AuthHeroStrip from '@/components/AuthHeroStrip';

// Loaded on demand: /auth is in the initial graph, and the panel is rarely opened.
const ForgotPasswordPanel = lazyChunk(() => import('@/pages/AuthForgotPassword'));

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type LoginFormData = z.infer<typeof loginSchema>;

const Auth = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  // "Forgot password?" swaps the form for a request to a super admin (§4 D251).
  const [forgot, setForgot] = useState(false);
  const { login, user, demo } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { homePath, ready } = useCapabilities();
  const { toast } = useToast();

  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname;
  const redirectTo = from && !from.startsWith('/auth') ? from : homePath;

  // Waits for `ready`: `homePath` is only this user's once their capability set
  // has been read. Before that it comes from the role fallback, which sends a
  // restricted account to /app and from there to /forbidden.
  // A demo visitor is not signed in as anyone: this page is how they leave the demo, so
  // it does not send them onward the way it sends a person who already has a session.
  useEffect(() => {
    if (user && !demo && ready) {
      navigate(redirectTo, { replace: true });
    }
  }, [user, demo, ready, navigate, redirectTo]);

  const form = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = async (data: LoginFormData) => {
    setIsLoading(true);
    setFormError(null);

    const result = await login(data.email, data.password);

    if (result.success) {
      // Redirect is owned by the effect above; this only covers the hand-off beat.
      setSignedIn(true);
      toast({ title: 'Login successful', description: 'Welcome back!' });
    } else {
      // Inline error is the primary channel now — the toast is the backstop.
      setFormError(result.error || 'Those credentials don’t match an approved account.');
      toast({
        title: 'Login failed',
        description: result.error || 'Please check your credentials and try again.',
        variant: 'destructive',
      });
    }

    setIsLoading(false);
  };

  // Signed in already (this login, or a visitor who opened /auth with a live
  // session): the hand-off is under way, so the form stays disabled while the
  // capability read that picks their home finishes.
  const handingOff = signedIn || Boolean(user);
  const isBusy = isLoading || handingOff;

  return (
    <div className="flex min-h-dvh items-stretch bg-white text-[#171717] min-[1920px]:[zoom:1.15] min-[2560px]:[zoom:1.35]">
      {/* Form column */}
      <div className="flex w-full shrink-0 grow-0 basis-auto flex-col justify-start border-[--hair-border] px-[clamp(1rem,5vw,76px)] pb-8 pt-9 md:w-auto md:basis-[max(420px,40%)] md:border-r">
        <img
          src="/logo-lockup.png"
          alt="SuReSuite — Supply Chain Resilience Suite"
          className="h-10 w-auto self-start object-contain"
        />

        <div className="my-auto flex w-full max-w-[400px] flex-col gap-[22px] py-7">
          {forgot ? (
            <Suspense fallback={null}>
              <ForgotPasswordPanel initialEmail={form.getValues('email')} onBack={() => setForgot(false)} />
            </Suspense>
          ) : (
          <>
          <h1 className="m-0 text-[31px] font-semibold leading-[1.1] tracking-[-0.022em]">
            Welcome <span className="font-serif italic font-medium">back.</span>
          </h1>

          {formError && (
            // Below `md` the tinted panel goes: the skin allows no colour
            // fill larger than a chip, so the failure is carried by the 6px
            // dot alone against the panel outline (§3, §12). Desktop keeps the
            // tint it has always had.
            <div className="flex items-start gap-[11px] rounded-[4px] border border-[#d4d4d4] bg-white px-[14px] py-[13px] md:rounded md:border-[#f3c9cd] md:bg-[#fdf5f5]">
              <span className="mt-[6px] size-[6px] shrink-0 rounded-full bg-[#BF2330]" />
              <div className="flex flex-col gap-[3px]">
                <span className="text-[13px] font-semibold tracking-[-0.01em] text-[#18181b] md:text-[#8f1a24]">Sign-in failed</span>
                <span className="text-[13px] leading-[1.5] text-[#3f3f46] md:text-[#a04249]">{formError}</span>
              </div>
            </div>
          )}

          {handingOff && (
            <div className="flex items-center gap-[11px] rounded bg-[#171717] p-[14px]">
              <span className="size-[6px] shrink-0 animate-pulse rounded-full bg-white" />
              <span className="text-[13px] tracking-[-0.01em] text-white">
                Signed in — taking you to your workspace…
              </span>
            </div>
          )}

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-[18px]">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem className="flex flex-col gap-[7px] space-y-0">
                    <FormLabel className="text-[12.5px] font-medium tracking-[-0.005em] text-[#171717]">
                      Email address
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="email"
                        autoComplete="username"
                        placeholder="you@organisation.com"
                        disabled={isBusy}
                        className="h-[46px] rounded-[6px] border-[#d4d4d4] px-[14px] text-[14.5px] md:rounded md:border-[#e0e0e0] transition-[border-color,box-shadow] duration-150 hover:border-[#c4c4c4] focus-visible:border-[#171717] focus-visible:ring-[3px] focus-visible:ring-[#171717]/[0.09] focus-visible:ring-offset-0"
                      />
                    </FormControl>
                    <FormMessage className="text-[12px]" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem className="flex flex-col gap-[7px] space-y-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <FormLabel className="text-[12.5px] font-medium tracking-[-0.005em] text-[#171717]">
                        Password
                      </FormLabel>
                      <button
                        type="button"
                        onClick={() => { setFormError(null); setForgot(true); }}
                        disabled={isBusy}
                        className="text-[12px] text-[#525252] no-underline hover:text-[#171717] md:text-[#737373]"
                      >
                        Forgot password?
                      </button>
                    </div>
                    <FormControl>
                      <div className="relative flex items-center">
                        <Input
                          {...field}
                          type={showPassword ? 'text' : 'password'}
                          autoComplete="current-password"
                          placeholder="Enter your password"
                          disabled={isBusy}
                          className="h-[46px] rounded-[6px] border-[#d4d4d4] pl-[14px] pr-[74px] text-[14.5px] md:rounded md:border-[#e0e0e0] transition-[border-color,box-shadow] duration-150 hover:border-[#c4c4c4] focus-visible:border-[#171717] focus-visible:ring-[3px] focus-visible:ring-[#171717]/[0.09] focus-visible:ring-offset-0"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          disabled={isBusy}
                          className="absolute right-[6px] inline-flex h-[34px] items-center rounded-sm px-[10px] font-mono text-[10px] uppercase tracking-[0.14em] text-[#737373] hover:bg-[#f5f5f5] hover:text-[#171717]"
                        >
                          {showPassword ? 'Hide' : 'Show'}
                        </button>
                      </div>
                    </FormControl>
                    <FormMessage className="text-[12px]" />
                  </FormItem>
                )}
              />

              {/* NOTE: presentational until session persistence is wired in useAuth —
                  pass rememberMe into login() (or set the supabase session
                  persistence flag) before shipping this as a real promise. */}
              <label className="-mt-0.5 flex cursor-pointer select-none items-center gap-[9px]">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={rememberMe}
                  onClick={() => setRememberMe((v) => !v)}
                  className="relative size-4 shrink-0 rounded-sm border border-[#d0d0d0] bg-white"
                >
                  {rememberMe && (
                    <span className="absolute -inset-px grid place-items-center rounded-sm bg-[#171717]">
                      <Check className="size-[10px] text-white" strokeWidth={3} />
                    </span>
                  )}
                </button>
                <span className="text-[13px] text-[#525252]">Keep me signed in on this device</span>
              </label>

              <button
                type="submit"
                disabled={isBusy}
                // §7/§12 below `md`: 6px, and no shadow — a shadow is never
                // what separates two things in this skin. `active:translate-y-px`
                // stays: a 1px nudge is exactly the press the spec allows.
                className="mt-1 inline-flex h-[46px] w-full items-center justify-center gap-2 rounded-[6px] bg-[#18181b] text-[13.5px] font-semibold tracking-[-0.008em] text-white transition-[background-color,transform] duration-150 hover:bg-black active:translate-y-px disabled:opacity-100 md:rounded md:bg-[#171717] md:text-[14.5px] md:font-medium md:shadow-sm"
              >
                {isBusy ? (
                  <span className="inline-flex items-center gap-[9px] opacity-85">
                    <span className="size-[6px] animate-pulse rounded-full bg-white" />
                    Signing in…
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    Sign in <span className="text-[15px] leading-none">→</span>
                  </span>
                )}
              </button>
            </form>
          </Form>
          </>
          )}

          <div className="flex flex-col gap-3 border-t border-[--hair-border] pt-5">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#525252] md:tracking-[0.2em] md:text-[#737373]">No account yet</span>
            <p className="m-0 text-pretty text-[13px] leading-[1.6] text-[#525252] md:text-[#737373]">
              Accounts are approved by the Digital SC Lab. Email{' '}
              <a href="mailto:phu.nguyen@hwr-berlin.de" className="font-medium text-[#BF2330] hover:underline">
                phu.nguyen@hwr-berlin.de
              </a>{' '}
              to request access.
            </p>
          </div>
        </div>
      </div>

      <AuthHeroStrip />
    </div>
  );
};

export default Auth;
