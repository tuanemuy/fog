/**
 * The one sentence under an auth sheet's title (`.page-description` in
 * `spec/design/pages/password-reset.html`), for a screen whose title alone
 * does not say what happens next. Centred, and broken only at punctuation
 * unless a word cannot fit.
 */
export function AuthSheetDescription({
  children,
}: Readonly<{ children: string }>) {
  return (
    <p className="mt-lg text-center font-base text-sm leading-tight text-neutral-600 text-balance break-keep wrap-anywhere">
      {children}
    </p>
  );
}
