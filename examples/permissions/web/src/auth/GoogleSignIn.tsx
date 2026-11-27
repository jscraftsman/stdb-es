import { useEffect, useRef, useState } from 'react';
import { clearAuthTokens, GOOGLE_CLIENT_ID, writeGoogleCredential } from '../config.js';
import { decodeCredential, type GoogleProfile } from './google.js';

type Props = {
  signedIn: boolean;
  profile: GoogleProfile | null;
};

export function GoogleSignIn({ signedIn, profile }: Props) {
  const buttonHost = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (signedIn || !buttonHost.current) return;

    const accounts = window.google?.accounts?.id;
    if (!accounts) {
      setError('Google sign-in script did not load.');
      return;
    }

    accounts.initialize({
      client_id: GOOGLE_CLIENT_ID,
      ux_mode: 'popup',
      use_one_tap: false,
      callback: (response) => {
        // A reload lets the provider rebuild the connection with this token.
        writeGoogleCredential(response.credential);
        window.location.reload();
      },
    });
    accounts.renderButton(buttonHost.current, {
      theme: 'outline',
      size: 'large',
      width: 240,
    });
    accounts.disableAutoSelect?.();
  }, [signedIn]);

  function signOut() {
    window.google?.accounts?.id?.disableAutoSelect?.();
    clearAuthTokens();
    window.location.reload();
  }

  return (
    <div className="auth">
      {signedIn ? (
        <>
          <span>
            {profile?.email ?? profile?.name ?? 'Google account connected'}
          </span>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </>
      ) : (
        <div ref={buttonHost} />
      )}
      {error ? <span className="auth-error">{error}</span> : null}
    </div>
  );
}
